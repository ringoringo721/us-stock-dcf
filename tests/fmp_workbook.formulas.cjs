const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const XLSX = require('xlsx');
const recalculate = require('xlsx-calc');
const Scenario = require('../fmp_scenario.js');
const { exportCalculations } = require('../scripts/export_fmp_calculations.cjs');

// This validator otherwise treats blanks as numbers and eagerly evaluates IF's unused error branch.
recalculate.import_functions({
  ISNUMBER: value => typeof value === 'number' && Number.isFinite(value),
  NA: () => { throw new Error('#N/A'); }
}, { override: true });
recalculate.import_raw_functions({
  IF: (condition, yes, no) => condition.calc() ? yes.calc() : no ? no.calc() : false
});

const find = (sheet, label) => {
  const cell = Object.entries(sheet).find(([ref, cell]) => /^A\d+$/.test(ref) && cell.v === label);
  assert.ok(cell, `Missing workbook row ${label}`);
  return cell[0].slice(1);
};
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Number.isFinite(actual)
  && Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fmp-workbook-test-'));
try {
  for (const ticker of ['0823.HK', '0388.HK', 'AAPL']) {
    const report = exportCalculations(ticker);
    const input = path.join(temporary, `${ticker}.json`), output = path.join(temporary, `${ticker}.xlsx`);
    fs.writeFileSync(input, JSON.stringify(report));
    execFileSync(process.env.PYTHON || 'python', [path.join(__dirname, '..', 'scripts', 'fmp_calculation_workbook.py'),
      '--input', input, '--output', output], { encoding: 'utf8' });
    const book = XLSX.readFile(output, { cellFormula: true, cellNF: true });
    assert.equal(book.SheetNames.length, 6);
    recalculate(book);
    for (const packet of report.packets) {
      const kind = packet.kind === 'advanced' ? 'Advanced' : 'CFO';
      const sheet = book.Sheets[`10Y ${kind}`], native = book.Sheets[`Native ${kind}`];
      const priceRow = find(sheet, 'targetPrice');
      near(sheet[`B${priceRow}`].v, packet.tenYear.result.targetPrice);
      assert.equal(sheet.B13.v, packet.tenYear.input.baseYear + 1);
      assert.equal(sheet.K13.v, packet.tenYear.input.baseYear + 10);
      assert.equal(sheet[`B${find(sheet, 'growth')}`].z, '0.00%', 'Percentage format has exactly two decimal places');
      assert.equal(typeof sheet[`B${find(sheet, 'growth')}`].v, 'number', 'Formatting does not replace numeric source values');
      near(sheet[`B${find(sheet, 'growth')}`].v, packet.tenYear.input.years[0].values.growth / 100);
      for (let index = 0; index < packet.native.rows.length; index++) {
        const column = XLSX.utils.encode_col(index + 1), year = native[`${column}4`].v;
        const checks = packet.native.checks.find(check => check.year === year);
        for (const [label, key] of [
          ['EV residual', 'evResidual'], ['Equity residual', 'equityResidual'],
          ['Original diluted-price residual', 'dilutedPriceResidual'],
          [kind === 'Advanced' ? 'EBIT identity residual' : 'CFO cash-flow residual',
            kind === 'Advanced' ? 'ebitIdentityResidual' : 'cfoCashFlowResidual']
        ]) near(native[`${column}${find(native, label)}`].v, checks[key], 0.01);
      }
      const scenario = structuredClone(packet.tenYear.input);
      sheet[`B${find(sheet, 'growth')}`].v = 0.12;
      Scenario.update(scenario, 0, 'growth', 12);
      sheet[`C${find(sheet, 'beta')}`].v = 2;
      Scenario.update(scenario, 1, 'beta', 2);
      sheet.B10.v = 0.015; scenario.terminalGrowth = 1.5;
      sheet.B8.v += 100e6; scenario.netDebt += 100e6;
      if (kind === 'Advanced') {
        sheet[`D${find(sheet, 'da')}`].v = 0.01;
        Scenario.update(scenario, 2, 'da', 1);
      } else {
        sheet[`D${find(sheet, 'cfo')}`].v = 0.5;
        Scenario.update(scenario, 2, 'cfo', 50);
      }
      recalculate(book);
      near(sheet[`B${priceRow}`].v, Scenario.calculate(scenario).targetPrice);
      sheet[`B${find(sheet, 'ke override (blank = initial Ke / changed CAPM)')}`] = { t: 'n', v: 0.11 };
      Scenario.update(scenario, 0, 'ke', 11);
      recalculate(book);
      near(sheet[`B${priceRow}`].v, Scenario.calculate(scenario).targetPrice);
    }
    console.log(`${ticker}: native residuals and both actual Excel-formula models recalculate correctly, including edited inputs and Ke overrides.`);
  }
  for (const ticker of ['0823.HK', '0388.HK']) {
    const book = XLSX.readFile(path.join(__dirname, '..', 'calculation_models', `${ticker}-dcf-models.xlsx`), { cellFormula: true });
    const expected = ['Advanced', 'CFO'].map(kind => {
      const sheet = book.Sheets[`10Y ${kind}`], cell = `B${find(sheet, 'targetPrice')}`;
      return { sheet, cell, value: sheet[cell].v };
    });
    recalculate(book);
    expected.forEach(({ sheet, cell, value }) => near(sheet[cell].v, value));
    console.log(`${ticker}: persisted downloadable workbook formulas reproduce their captured initial results.`);
  }
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
