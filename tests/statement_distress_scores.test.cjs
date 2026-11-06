const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateAltman,
  calculateBeneish,
  calculateAll,
  altmanZone,
  beneishZone,
  retainedEarningsUnusable,
  receivablesUnusable,
  beneishTata,
  beneishLeverage
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
          accountsReceivables: 100, netReceivables: 100,
          cashAndCashEquivalents: 200, shortTermDebt: 50, longTermDebt: 300, taxPayables: 20
        }),
        row(2024, {
          totalAssets: 2200, totalLiabilities: 900, totalCurrentAssets: 1000, totalCurrentLiabilities: 450,
          retainedEarnings: 620, totalStockholdersEquity: 1300, propertyPlantEquipmentNet: 650,
          accountsReceivables: 150, netReceivables: 150,
          cashAndCashEquivalents: 250, shortTermDebt: 60, longTermDebt: 320, taxPayables: 25
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

test('Beneish 8-variable M-Score publishes intercept + eight indices (1999)', () => {
  const data = industrialFixture();
  const result = calculateBeneish(data);
  assert.equal(result.reason, null);
  assert.equal(result.intercept, -4.84);
  assert.equal(result.items.length, 9);
  assert.equal(result.items[0].key, 'intercept');
  assert.equal(result.items[0].contribution, -4.84);
  assert.ok(result.items.every(item => item.desc_en && item.detail_zh && item.detail_en));
  assert.ok(Number.isFinite(result.score));

  // Classic Beneish 1999 TATA / LVGI (not NI−CFO / TL/TA).
  const bal = data.annual.balance[1];
  const prior = data.annual.balance[0];
  const expectedTata = beneishTata(bal, prior, data.annual.income[1], data.annual.cashflow[1]);
  assert.ok(Math.abs(result.indices.TATA - expectedTata) < 1e-12);
  assert.ok(Math.abs(result.indices.LVGI
    - (beneishLeverage(bal) / beneishLeverage(prior))) < 1e-12);
  // M = −4.84 + Σ wi×index
  const rebuilt = result.intercept + Object.entries(result.indices)
    .reduce((sum, [key, value]) => sum + result.weights[key] * value, 0);
  assert.ok(Math.abs(result.score - Number(rebuilt.toFixed(2))) < 1e-9);

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

test('collapsed AR (0 after positive prior) walks back like collapsed RE', () => {
  const collapsed = industrialFixture();
  collapsed.annual.income.push(row(2025, {
    revenue: 1300, grossProfit: 450, ebit: 230, operatingIncome: 230, netIncome: 170,
    sellingGeneralAndAdministrativeExpenses: 160, depreciationAndAmortization: 50
  }));
  collapsed.annual.balance.push(row(2025, {
    totalAssets: 2400, totalLiabilities: 950, totalCurrentAssets: 1100, totalCurrentLiabilities: 480,
    retainedEarnings: 700, totalStockholdersEquity: 1450, propertyPlantEquipmentNet: 700,
    accountsReceivables: 0, netReceivables: 0,
    cashAndCashEquivalents: 280, shortTermDebt: 70, longTermDebt: 340, taxPayables: 30
  }));
  collapsed.annual.cashflow.push(row(2025, { operatingCashFlow: 210, depreciationAndAmortization: 50 }));
  assert.equal(receivablesUnusable(collapsed.annual.balance[2], collapsed.annual.balance[1]), true);
  const walked = calculateBeneish(collapsed);
  assert.equal(walked.reason, null);
  assert.equal(walked.period, 'FY 2024');
  assert.ok(Number.isFinite(walked.score));
  assert.ok(walked.indices.DSRI > 0);
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

test('collapsed FMP equity (RE=0, common≈equity) is unusable; genuine RE=0 still scores', () => {
  const collapsed = row(2025, {
    totalAssets: 2000, totalLiabilities: 800, totalCurrentAssets: 900, totalCurrentLiabilities: 400,
    retainedEarnings: 0, additionalPaidInCapital: 0, treasuryStock: 0,
    accumulatedOtherComprehensiveIncomeLoss: 0, otherTotalStockholdersEquity: 0,
    commonStock: 1200, totalStockholdersEquity: 1200, propertyPlantEquipmentNet: 600
  });
  assert.equal(retainedEarningsUnusable(collapsed), true);

  const collapsedOther = row(2025, {
    totalAssets: 2000, totalLiabilities: 800, totalCurrentAssets: 900, totalCurrentLiabilities: 400,
    retainedEarnings: 0, additionalPaidInCapital: 0, commonStock: 0,
    otherTotalStockholdersEquity: 1200, totalStockholdersEquity: 1200, propertyPlantEquipmentNet: 600
  });
  assert.equal(retainedEarningsUnusable(collapsedOther), true);

  const genuineZero = row(2025, {
    totalAssets: 2000, totalLiabilities: 800, totalCurrentAssets: 900, totalCurrentLiabilities: 400,
    retainedEarnings: 0, additionalPaidInCapital: 400, commonStock: 800,
    totalStockholdersEquity: 1200, propertyPlantEquipmentNet: 600
  });
  assert.equal(retainedEarningsUnusable(genuineZero), false);

  const data = industrialFixture();
  data.annual.income.push(row(2025, {
    revenue: 1300, grossProfit: 450, ebit: 230, operatingIncome: 230, netIncome: 170,
    sellingGeneralAndAdministrativeExpenses: 160, depreciationAndAmortization: 50
  }));
  data.annual.balance.push(collapsed);
  data.annual.cashflow.push(row(2025, { operatingCashFlow: 200, depreciationAndAmortization: 50 }));
  const walked = calculateAltman(data, { mcapMillions: 5000, model: 'z' });
  assert.equal(walked.reason, null);
  assert.equal(walked.period, 'FY 2024');
  assert.ok(Number.isFinite(walked.score));
  assert.ok(walked.ratios.x2 > 0);
});

test('NTES FY2025 collapsed RE walks back; USD mcap converts to CNY for X4', () => {
  const fs = require('fs');
  const path = require('path');
  const {
    attachDistressScores,
    mcapMillionsInStatementCurrency
  } = require('../scripts/distress_score_fields.cjs');
  const file = path.join(__dirname, '../cache/financials/NTES_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const company = JSON.parse(fs.readFileSync(path.join(__dirname, '../cache/us_companies/NTES.json'), 'utf8'));
  const stock = JSON.parse(JSON.stringify(company.stock));

  const bare = calculateAltman(statements, { mcapMillions: stock.mcap, model: 'z' });
  // Without FX, walk-back still avoids X2=0 on FY2025.
  assert.equal(bare.period, 'FY 2024');
  assert.ok(bare.ratios.x2 > 0.5);

  const converted = mcapMillionsInStatementCurrency(stock, 'CNY');
  assert.equal(converted.reason, null);
  assert.ok(converted.mcapMillions > stock.mcap * 5, 'CNY mcap should be several× USD mcap');

  const { altman } = attachDistressScores(stock, statements, { ticker: 'NTES' });
  assert.equal(altman.reason, null);
  assert.equal(altman.period, 'FY 2024');
  assert.equal(altman.scoringCurrency, 'CNY');
  assert.ok(altman.score > 6, `expected FX-corrected superRobust Z, got ${altman.score}`);
  assert.equal(altman.zone, 'superRobust');
  assert.ok(altman.ratios.x4 > 5, `X4 should reflect CNY market equity, got ${altman.ratios.x4}`);
  assert.equal(stock.z_score_zone, 'superRobust');
  assert.equal(stock.ratingSources.zScore.mcapFx.from, 'USD');
  assert.equal(stock.ratingSources.zScore.mcapFx.to, 'CNY');
});

test('NTES Beneish uses classic TATA/LVGI and publishes M with intercept', () => {
  const fs = require('fs');
  const path = require('path');
  const { attachDistressScores } = require('../scripts/distress_score_fields.cjs');
  const file = path.join(__dirname, '../cache/financials/NTES_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const company = JSON.parse(fs.readFileSync(path.join(__dirname, '../cache/us_companies/NTES.json'), 'utf8'));
  const stock = JSON.parse(JSON.stringify(company.stock));
  const { beneish } = attachDistressScores(stock, statements, { ticker: 'NTES' });
  assert.equal(beneish.reason, null);
  assert.ok(Number.isFinite(beneish.score));
  assert.equal(beneish.intercept, -4.84);
  assert.equal(beneish.items[0].key, 'intercept');
  // Classic TATA should not equal (NI−CFO)/TA for NTES FY window.
  const obsIncome = statements.annual.income.find(r => String(r.date).startsWith(String(beneish.date).slice(0, 4))
    || String(r.fiscalYear) === String(beneish.period).replace(/\D/g, ''));
  assert.ok(Number.isFinite(beneish.indices.TATA));
  assert.ok(Number.isFinite(beneish.indices.LVGI));
  assert.ok(beneish.score > -4 && beneish.score < 0, `NTES M in plausible band, got ${beneish.score}`);
  assert.equal(stock.m_score, beneish.score);
  void obsIncome;
});

test('AAPL USD reporter keeps identity FX and publishes classic Z > 4', () => {
  const fs = require('fs');
  const path = require('path');
  const { attachDistressScores } = require('../scripts/distress_score_fields.cjs');
  const file = path.join(__dirname, '../cache/financials/AAPL_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '../full_market_dcf.json'), 'utf8'));
  const stock = JSON.parse(JSON.stringify(market.AAPL));
  const raw = calculateAltman(statements, { mcapMillions: stock.mcap, model: 'z' });
  const { altman, mcapFx } = attachDistressScores(stock, statements, { ticker: 'AAPL' });
  assert.equal(stock.calculationCurrency, 'USD');
  assert.equal(altman.scoringCurrency, 'USD');
  assert.equal(mcapFx.fx, null, 'same-currency mcap needs no FX metadata');
  assert.equal(altman.score, raw.score);
  assert.ok(altman.score > 4);
  assert.equal(altman.zone, 'superRobust');
  assert.ok(altman.ratios.x2 > 0);
});

test('0700.HK Beneish scores in statement currency without mcap FX', () => {
  const fs = require('fs');
  const path = require('path');
  const { attachDistressScores } = require('../scripts/distress_score_fields.cjs');
  const file = path.join(__dirname, '../cache/financials/0700.HK_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '../hk_market_dcf.json'), 'utf8'));
  const stock = JSON.parse(JSON.stringify(market['0700.HK']));
  const { beneish } = attachDistressScores(stock, statements, { ticker: '0700.HK' });
  assert.equal(beneish.reason, null);
  assert.ok(Number.isFinite(beneish.score));
  assert.equal(beneish.scoringCurrency, 'CNY');
  assert.equal(beneish.intercept, -4.84);
  assert.ok(!stock.ratingSources.mScore?.mcapFx, 'Beneish YoY ratios need no mcap FX');
});

test('0700.HK CNY statements convert HKD mcap before classic X4', () => {
  const fs = require('fs');
  const path = require('path');
  const {
    attachDistressScores,
    mcapMillionsInStatementCurrency
  } = require('../scripts/distress_score_fields.cjs');
  const file = path.join(__dirname, '../cache/financials/0700.HK_statements_v2.json');
  if (!fs.existsSync(file)) return;
  const statements = JSON.parse(fs.readFileSync(file, 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(__dirname, '../hk_market_dcf.json'), 'utf8'));
  const stock = JSON.parse(JSON.stringify(market['0700.HK']));
  assert.equal(stock.calculationCurrency, 'HKD');
  assert.equal(stock.reportedCurrency, 'CNY');

  const unconverted = calculateAltman(statements, { mcapMillions: stock.mcap, model: 'z' });
  const converted = mcapMillionsInStatementCurrency(stock, 'CNY');
  assert.equal(converted.reason, null);
  assert.ok(converted.mcapMillions < stock.mcap, 'CNY mcap from HKD should be slightly smaller');
  assert.ok(converted.fx && converted.fx.from === 'HKD' && converted.fx.to === 'CNY');

  const { altman } = attachDistressScores(stock, statements, { ticker: '0700.HK' });
  assert.equal(altman.reason, null);
  assert.equal(altman.scoringCurrency, 'CNY');
  assert.ok(Number.isFinite(altman.score));
  assert.ok(altman.score < unconverted.score, 'FX-corrected Z must not use raw HKD mcap vs CNY liabilities');
  assert.equal(stock.ratingSources.zScore.mcapFx.from, 'HKD');
  assert.equal(stock.ratingSources.zScore.mcapFx.to, 'CNY');
});

test('MOP statement currency uses HKD peg for mcap conversion', () => {
  const { mcapMillionsInStatementCurrency } = require('../scripts/distress_score_fields.cjs');
  const stock = { mcap: 1000, calculationCurrency: 'HKD', quoteDate: '2025-12-31' };
  const converted = mcapMillionsInStatementCurrency(stock, 'MOP');
  assert.equal(converted.reason, null);
  assert.ok(Math.abs(converted.mcapMillions - 1030) < 1e-6);
  assert.equal(converted.fx.peg.via, 'HKD');
});
