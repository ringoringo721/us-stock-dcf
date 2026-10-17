const test = require('node:test');
const assert = require('node:assert/strict');
const { financingDebt, workingCapital } = require('../scripts/fcff_sources.cjs');

test('reported debt already containing leases is preserved, never increased a second time', () => {
  const result = financingDebt({ totalDebt: 38860e6, shortTermDebt: 1000e6,
    longTermDebt: 32366e6, capitalLeaseObligations: 5494e6 });
  assert.equal(result.value, 38860e6);
  assert.equal(result.leaseDebt, 5494e6);
  assert.equal(result.reason, null);
});

test('unclear lease inclusion is explicit rather than guessing whether to add lease debt', () => {
  const result = financingDebt({ totalDebt: 120, shortTermDebt: 20,
    longTermDebt: 100, capitalLeaseObligations: 10 });
  assert.equal(result.value, null);
  assert.equal(result.reason, 'debtCompositionUnverified');
  assert.equal(financingDebt({ totalDebt: 120 }).reason, 'debtCompositionUnverified');
});

test('reported zero debt and zero lease values remain actual zeros', () => {
  assert.equal(financingDebt({ totalDebt: 0, capitalLeaseObligations: 0 }).value, 0);
  assert.equal(financingDebt({ totalDebt: 120, capitalLeaseObligations: 0 }).value, 120);
  assert.equal(financingDebt({ totalDebt: -1, capitalLeaseObligations: 0 }).value, null);
});

test('current financing leases are excluded from operating NWC, not counted like trade payables', () => {
  const balance = { totalCurrentAssets: 500, cashAndShortTermInvestments: 100,
    totalCurrentLiabilities: 200, shortTermDebt: 50, longTermDebt: 100,
    capitalLeaseObligations: 30, capitalLeaseObligationsCurrent: 10, totalDebt: 180 };
  assert.equal(workingCapital(balance), 260);
  assert.equal(workingCapital({ ...balance, totalDebt: 150 }), null);
  assert.equal(financingDebt({ ...balance, capitalLeaseObligationsCurrent: 40 }).value, null);
});

test('unavailable or malformed source records return reasons rather than fabricated snapshots', () => {
  const { prepareSnapshot } = require('../scripts/fcff_sources.cjs');
  assert.equal(prepareSnapshot('TEST', null, null, null).reason, 'sourceUnavailable');
  assert.equal(prepareSnapshot('TEST', { ticker: 'TEST', providerSymbol: 'TEST',
    capturedAt: 123 }, null, null).reason, 'sourceUnavailable');
});
