const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

function loadUsContext() {
  const context = { window: {}, console };
  context.window = context;
  for (const file of [
    'us_universe_data.js',
    'us_expansion_data.js',
    'us_chinese_names_data.js',
    'market_data.js',
    'financial_industry.js',
    'us_universe.js',
  ]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  }
  return context;
}

test('US Chinese names catalogue attaches name_zh on merge for known sources', () => {
  const context = loadUsContext();
  const merged = context.UsUniverse.merge(
    context.FULL_MARKET_DATA, context.US_LISTINGS, context.US_EXPANSION
  );
  assert.equal(merged.LMT.name_zh, '洛克希德·馬丁');
  assert.equal(merged.ETN.name_zh, '伊頓公司');
  assert.equal(merged.BABA.name_zh, '阿里巴巴');
  assert.equal(merged['BRK-A'].name_zh, '波克夏海瑟威 (A)');
  // No invented translation when description_zh has no Chinese short name.
  assert.equal(merged.IBKR?.name_zh, undefined);
  assert.equal(merged.WDC?.name_zh, undefined);
  assert.ok(context.US_CHINESE_NAMES.coverage.pct >= 30);
});

test('listingStock copies catalogue name_zh for uncaptured equities', () => {
  const context = {
    window: {},
    US_CHINESE_NAMES: { names: { NEWCO: '新創示範' } },
    FinancialIndustry: { usesFinancialValuationModel: () => false },
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'us_universe.js'), 'utf8'), context);
  const stock = context.UsUniverse.listingStock({
    ticker: 'NEWCO', name: 'New Co', name_en: 'New Co',
    exchange: 'NYSE', sector: 'Technology', industry: 'Software', marketCap: 12e9,
  });
  assert.equal(stock.name_zh, '新創示範');
});
