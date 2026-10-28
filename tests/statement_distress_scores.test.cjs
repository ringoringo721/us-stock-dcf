const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateAltman,
  calculateBeneish,
  calculateAll,
  altmanZone,
  beneishZone
} = require('../statement_distress_scores.js');

function row(year, fields) {
  return { date: `${year}-12-31`, fiscalYear: year, period: 'FY', reportedCurrency: 'USD', ...fields };
}

function industrialFixture() {
  return {
    annual: {
      income: [
        row(2023, {
          revenue: 1000, grossProfit: 400, ebit: 200, operatingIncome: 200, netIncome: 150,
          sellingGeneralAndAdministrativeExpenses: 120, depreciationAndAmortization: 40
        }),
        row(2024, {
          revenue: 1200, grossProfit: 420, ebit: 220, operatingIncome: 220, netIncome: 160,
          sellingGeneralAndAdministrativeExpenses: 150, depreciationAndAmortization: 45
        })
      ],
      balance: [
        row(2023, {
          totalAssets: 2000, totalLiabilities: 800, totalCurrentAssets: 900, totalCurrentLiabilities: 400,
          retainedEarnings: 500, totalStockholdersEquity: 1200, propertyPlantEquipmentNet: 600,
          accountsReceivables: 100, netReceivables: 100
        }),
        row(2024, {
          totalAssets: 2200, totalLiabilities: 900, totalCurrentAssets: 1000, totalCurrentLiabilities: 450,
          retainedEarnings: 620, totalStockholdersEquity: 1300, propertyPlantEquipmentNet: 650,
          accountsReceivables: 150, netReceivables: 150
        })
      ],
      cashflow: [
        row(2023, { operatingCashFlow: 180, depreciationAndAmortization: 40 }),
        row(2024, { operatingCashFlow: 190, depreciationAndAmortization: 45 })
      ]
    },
    quarterly: { income: [], balance: [], cashflow: [] }
  };
}

test('classic Altman Z uses market equity and screenshot-style bands', () => {
  const result = calculateAltman(industrialFixture(), { mcapMillions: 5000, model: 'z' });
  assert.equal(result.reason, null);
  assert.equal(result.model, 'z');
  assert.equal(result.x4Basis, 'marketEquity');
  assert.equal(result.items.length, 5);
  assert.ok(result.score > 4);
  assert.equal(result.zone, 'superRobust');
  assert.equal(altmanZone(3.5), 'safe');
  assert.equal(altmanZone(2.5), 'grey');
  assert.equal(altmanZone(1.2), 'distress');
});

test('Z′ book-equity model is available and separate from classic bands', () => {
  const result = calculateAltman(industrialFixture(), { model: 'zPrime' });
  assert.equal(result.model, 'zPrime');
  assert.equal(result.x4Basis, 'bookEquity');
  assert.ok(Number.isFinite(result.score));
  assert.ok(result.items[3].desc.includes('X4′'));
});

test('Beneish 8-variable M-Score publishes component breakdown', () => {
  const result = calculateBeneish(industrialFixture());
  assert.equal(result.reason, null);
  assert.equal(result.items.length, 8);
  assert.ok(result.items.every(item => item.desc_en && item.detail_zh && item.detail_en));
  assert.ok(Number.isFinite(result.score));
  assert.ok(['clean', 'windowDressing', 'highRisk'].includes(result.zone));
  assert.equal(beneishZone(-2.5), 'clean');
  assert.equal(beneishZone(-1.9), 'windowDressing');
  assert.equal(beneishZone(-1.5), 'highRisk');
});

test('banks and insurers are N/A for Z, M (and callers should null PF the same way)', () => {
  const all = calculateAll(industrialFixture(), { isFinancial: true, mcapMillions: 5000 });
  assert.equal(all.altman.score, null);
  assert.equal(all.altman.reason, 'financialSectorNotApplicable');
  assert.equal(all.beneish.score, null);
  assert.equal(all.beneish.reason, 'financialSectorNotApplicable');
});

test('missing market cap blocks classic Z; undisclosed SGA uses neutral SGAI=1', () => {
  assert.equal(calculateAltman(industrialFixture(), { model: 'z' }).reason, 'missingMarketCap');
  const data = industrialFixture();
  delete data.annual.income.at(-1).sellingGeneralAndAdministrativeExpenses;
  data.annual.income[0].sellingGeneralAndAdministrativeExpenses = 0;
  const m = calculateBeneish(data);
  assert.equal(m.reason, null);
  assert.ok(Number.isFinite(m.score));
  assert.equal(m.indices.SGAI, 1);
});

test('Beneish 0/0 receivable intensity is neutral DSRI; prior-only zero stays incomplete', () => {
  const bothZero = industrialFixture();
  bothZero.annual.balance[0].accountsReceivables = 0;
  bothZero.annual.balance[0].netReceivables = 0;
  bothZero.annual.balance[1].accountsReceivables = 0;
  bothZero.annual.balance[1].netReceivables = 0;
  const clean = calculateBeneish(bothZero);
  assert.equal(clean.reason, null);
  assert.equal(clean.indices.DSRI, 1);

  const spike = industrialFixture();
  spike.annual.balance[0].accountsReceivables = 0;
  spike.annual.balance[0].netReceivables = 0;
  const blocked = calculateBeneish(spike);
  assert.equal(blocked.score, null);
  assert.equal(blocked.reason, 'incompleteCriteria');
  assert.equal(blocked.indices.DSRI, null);
});

test('fiscal balance dates a few days off income still yield Altman/Beneish', () => {
  const data = industrialFixture();
  data.annual.balance[0].date = '2023-12-28';
  data.annual.balance[1].date = '2024-12-29';
  const z = calculateAltman(data, { mcapMillions: 5000, model: 'z' });
  const m = calculateBeneish(data);
  assert.equal(z.reason, null);
  assert.ok(Number.isFinite(z.score));
  assert.equal(m.reason, null);
  assert.ok(Number.isFinite(m.score));
});

test('currency breaks cannot silently compare Beneish years', () => {
  const data = industrialFixture();
  data.annual.income[0].reportedCurrency = 'HKD';
  assert.equal(calculateBeneish(data).reason, 'missingComparableStatements');
});

test('AAPL statements produce a finite classic Z and M with expected zones', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '../cache/financials/AAPL_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '../full_market_dcf.json'), 'utf8'));
  const z = calculateAltman(statements, { mcapMillions: market.AAPL.mcap, model: 'z' });
  const m = calculateBeneish(statements);
  assert.equal(z.reason, null);
  assert.ok(z.score > 4);
  assert.equal(z.zone, 'superRobust');
  assert.equal(m.reason, null);
  assert.ok(Number.isFinite(m.score));
});

test('JPM financial flag yields N/A even when statements exist', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '../cache/financials/JPM_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '../full_market_dcf.json'), 'utf8'));
  const all = calculateAll(statements, {
    isFinancial: !!market.JPM.fin_valuation?.is_financial,
    mcapMillions: market.JPM.mcap
  });
  assert.equal(all.altman.reason, 'financialSectorNotApplicable');
  assert.equal(all.beneish.reason, 'financialSectorNotApplicable');
});

test('Beneish walks back to an older annual pair when latest is incomplete', () => {
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '../cache/financials/AZO_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const m = calculateBeneish(statements);
  assert.equal(m.reason, null);
  assert.ok(Number.isFinite(m.score));
  // Latest FY has DA=0; walk-back should land on an earlier complete pair.
  assert.ok(m.period && !String(m.period).includes('2026'));
});

test('preferred empty packs inherit issuer common statements (SMCIP→SMCI)', () => {
  const { attachDistressScores } = require('../scripts/distress_score_fields.cjs');
  const fs = require('fs');
  const path = require('path');
  const expText = fs.readFileSync(path.join(__dirname, '../us_expansion_data.js'), 'utf8');
  const exp = JSON.parse(expText.slice(expText.indexOf('=') + 1).replace(/;\s*$/, ''));
  const stock = JSON.parse(JSON.stringify(exp.stocks.SMCIP));
  const empty = { annual: { income: [], balance: [], cashflow: [] }, quarterly: { income: [], balance: [], cashflow: [] } };
  const result = attachDistressScores(stock, empty, { ticker: 'SMCIP' });
  assert.equal(result.inheritedFrom, 'SMCI');
  assert.ok(Number.isFinite(stock.z_score));
  assert.ok(Number.isFinite(stock.m_score));
});
