'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HkSmartMoney = require('../hk_smart_money.js');
const createApi = require('../api/hk-smart-money.js');

test('isHkListed gates .HK / HKD / HKEX', () => {
  assert.equal(HkSmartMoney.isHkListed({ ticker: '1398.HK' }), true);
  assert.equal(HkSmartMoney.isHkListed({ ticker: 'AAPL' }), false);
  assert.equal(HkSmartMoney.isHkListed({ ticker: '0700', calculationCurrency: 'HKD' }), true);
  assert.equal(HkSmartMoney.isHkListed({ ticker: 'BABA', exchange: 'HKEX' }), true);
});

test('tickerFromCode keeps 4-digit HK tickers (never 700.HK / 00700.HK)', () => {
  assert.equal(HkSmartMoney.tickerFromCode('00700'), '0700.HK');
  assert.equal(HkSmartMoney.tickerFromCode(700), '0700.HK');
  assert.equal(HkSmartMoney.tickerFromCode('0700'), '0700.HK');
  assert.equal(HkSmartMoney.tickerFromCode('01398'), '1398.HK');
  assert.equal(HkSmartMoney.tickerFromCode('5'), '0005.HK');
  assert.equal(HkSmartMoney.tickerFromCode('87001'), '87001.HK');
  assert.equal(HkSmartMoney.codeFromTicker('0700.HK'), '00700');
  assert.equal(HkSmartMoney.codeFromTicker('1398.HK'), '01398');
});

test('parseDiSummaryHtml extracts C1 substantial rows', () => {
  const html = `
    <TR bgColor="#cccccc"><TD class="txt" width="130" valign="top"><a href="/di/NSForm2.aspx?fn=CS20261105E00374&sc=02318">CS20261105E00374</a></TD>
    <TD class="txt" width="120" valign="top"><a href="/di/NSSrchCorpList.aspx">Ping An</a></TD>
    <TD class="txt" width="52" valign="top">02318</TD>
    <TD class="txt" width="80" valign="top">Ordinary Shares</TD>
    <TD class="txt" width="120" valign="top"><a href="/di/NSSrchPersonList.aspx">BlackRock, Inc.</a></TD>
    <TD class="txt" width="80" valign="top"><a href="/di/NSForm2.aspx?fn=CS20261105E00374">03/11/2026</a></TD>
    <TD class="txt" width="80" valign="top"><a href="javascript: window.open('/di/NSStdCode.htm?ft=CS#1101', '', '');void(0);">1101</a>(L)<br></TD>
    <TD class="txt" width="120" valign="top">1,000,000(L)<br></TD>
    <TD class="txt" width="100" valign="top">HKD 50.1234</TD>
    <TD class="txt" width="180" valign="top" colspan="2"><TABLE cellSpacing='0' cellPadding='2' border='0'><TR><TD class='txt' width='130' valign='top' align='right'>10,000,000(L)</TD><TD class='txt' valign='top' width='50' align='right'>6.76</TD></TR></TABLE></TD>
    <TD class="txt" width="180" valign="top" colspan="2"><TABLE cellSpacing='0' cellPadding='2' border='0'><TR><TD class='txt' width='130' valign='top' align='right'>11,000,000(L)</TD><TD class='txt' valign='top' width='50' align='right'>7.10</TD></TR></TABLE></TD></TR>`;
  const events = HkSmartMoney.parseDiSummaryHtml(html, 'substantial', '2026-11-06');
  assert.equal(events.length, 1);
  assert.equal(events[0].stock_code, '02318');
  assert.equal(events[0].filer, 'BlackRock, Inc.');
  assert.equal(events[0].event_date, '2026-11-03');
  assert.equal(events[0].reason_code, '1101');
  assert.equal(events[0].avg_price, 50.1234);
  assert.equal(events[0].before_pct, 6.76);
  assert.equal(events[0].after_pct, 7.1);
  assert.equal(events[0].action, 'added');
  assert.match(events[0].form_url, /^https:\/\/di\.hkex\.com\.hk\/di\/NSForm2/);
});

test('normalizeDiEvents ISO-dates, actions, dedupes by serial', () => {
  const rows = HkSmartMoney.normalizeDiEvents([
    {
      serial: 'CS1',
      filer: 'BlackRock, Inc.',
      event_date: '03/11/2026',
      before_pct: 6.76,
      after_pct: 6.76,
    },
    {
      serial: 'CS1',
      filer: 'BlackRock, Inc.',
      event_date: '2026-11-03',
      before_pct: 6.76,
      after_pct: 6.76,
      action: 'held',
    },
    {
      serial: 'CS2',
      filer: 'JPMorgan',
      event_date: '30/10/2026',
      before_pct: 6.2,
      after_pct: 6.0,
    },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].event_date, '2026-11-03');
  assert.equal(rows[0].action, 'held');
  assert.equal(rows[1].event_date, '2026-10-30');
  assert.equal(rows[1].action, 'reduced');
});

test('parseSouthboundHtml reads shareholding rows', () => {
  const html = `
    <input name="txtShareholdingDate" type="text" value="2026/11/06" id="txtShareholdingDate" />
    <tr>
      <td class="col-stock-code"><div class="mobile-list-heading">Stock Code:</div><div class="mobile-list-body"> 1398</div></td>
      <td class="col-stock-name"><div class="mobile-list-heading">Name:</div><div class="mobile-list-body">ICBC</div></td>
      <td class="col-shareholding"><div class="mobile-list-heading">Shareholding in CCASS:</div><div class="mobile-list-body">35,449,345,098</div></td>
      <td class="col-shareholding-percent"><div class="mobile-list-heading">%</div><div class="mobile-list-body">40.84%</div></td>
    </tr>`;
  const parsed = HkSmartMoney.parseSouthboundHtml(html);
  assert.equal(parsed.as_of, '2026-11-06');
  assert.equal(parsed.byCode['01398'].pct, 40.84);
  assert.equal(parsed.byCode['01398'].shares, 35449345098);
});

test('southbound deltas use exact prior business days, else null', () => {
  const built = HkSmartMoney.buildSouthboundForCode([
    { date: '2026-11-06', pct: 40.84, shares: 1 },
    { date: '2026-11-05', pct: 40.86, shares: 1 },
    { date: '2026-10-30', pct: 40.87, shares: 1 },
    { date: '2026-10-09', pct: 41.35, shares: 1 },
  ]);
  assert.equal(built.pct_chg_1d, -0.02);
  assert.equal(built.pct_chg_5d, -0.03);
  assert.equal(built.pct_chg_20d, -0.51);

  const sparse = HkSmartMoney.buildSouthboundForCode([
    { date: '2026-11-06', pct: 40.84, shares: 1 },
    { date: '2026-11-02', pct: 40.86, shares: 1 },
  ]);
  assert.equal(sparse.pct_chg_1d, null);
  assert.equal(sparse.pct_chg_5d, null);
  assert.equal(sparse.pct_chg_20d, null);
});

test('southbound long horizons use calendar lookback with honest nulls', () => {
  assert.deepEqual([...HkSmartMoney.SOUTHBOUND_LONG_CAL_DAYS], [30, 60, 90, 120, 150, 180, 270, 360]);
  const built = HkSmartMoney.buildSouthboundForCode([
    { date: '2026-11-06', pct: 40.0, shares: 1 },
    { date: '2026-10-07', pct: 39.0, shares: 1 }, // ~30 calendar days prior
    { date: '2026-08-07', pct: 38.0, shares: 1 }, // ~91 calendar days
    { date: '2025-11-07', pct: 35.0, shares: 1 }, // ~364 calendar days
  ]);
  assert.equal(built.pct_chg_30d, 1);
  assert.equal(built.pct_chg_90d, 2);
  assert.equal(built.pct_chg_360d, 5);
  assert.equal(built.pct_chg_60d, null); // no row near 60d target
  assert.equal(built.pct_chg_120d, null);
});

test('parseSfcShortCsv and buildShortForCode', () => {
  const csv = `Date,Stock Code,Stock Name,Aggregated Reportable Short Positions (Shares),Aggregated Reportable Short Positions (HK$)
30/10/2026,1398,ICBC,1269281039,10020973803`;
  const week = HkSmartMoney.parseSfcShortCsv(csv);
  assert.equal(week.byCode['01398'].shares, 1269281039);
  const short = HkSmartMoney.buildShortForCode(
    week.byCode['01398'],
    { shares: 1243943868 },
    { shares: 35449345098, pct: 40.84 },
  );
  assert.ok(short.pct_of_issued > 1 && short.pct_of_issued < 2);
  assert.equal(short.shares_chg_wow, 1269281039 - 1243943868);
});

test('parseCsmDailyJs extracts southbound net buy', () => {
  const text = `tabData = ${JSON.stringify([{
    id: 1,
    date: '2026-11-06',
    market: 'SSE Southbound',
    tradingDay: 1,
    content: [{
      style: 1,
      table: {
        schema: [['Total Turnover', 'Buy Turnover', 'Sell Turnover']],
        tr: [{ td: [['10']] }, { td: [['6']] }, { td: [['4']] }],
      },
    }, {
      style: 2,
      table: {
        schema: [['Rank', 'Stock Code', 'Stock Name', 'Buy Turnover', 'Sell Turnover', 'Total Turnover']],
        tr: [{ td: [['1', '00700', 'TENCENT', '1', '2', '3']] }],
      },
    }],
  }])};`;
  const parsed = HkSmartMoney.parseCsmDailyJs(text);
  assert.equal(parsed.southbound.length, 1);
  assert.equal(parsed.southbound[0].net_buy, 2);
  assert.equal(parsed.southbound[0].top[0].stock_code, '00700');
  assert.equal(parsed.turnover_unit, 'HKD_million');
});

test('formatCsmNetTurnover labels HK$ million with 億 gloss (not 億 CNY raw)', () => {
  assert.match(HkSmartMoney.formatCsmNetTurnover(2414.91, 'zh'), /2,414\.91 百萬港元/);
  assert.match(HkSmartMoney.formatCsmNetTurnover(2414.91, 'zh'), /約 \+24\.15 億港元/);
  assert.match(HkSmartMoney.formatCsmNetTurnover(2414.91, 'en'), /HK\$ million/);
  assert.match(HkSmartMoney.formatCsmNetTurnover(2414.91, 'en'), /≈ \+24\.15/);
  assert.equal(HkSmartMoney.formatCsmNetTurnover(null, 'zh'), '—');
});

test('committed HK seeds cover 1398.HK and a Connect name with DI', () => {
  const seed1398 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'hk-smart-money', '1398.HK.json'), 'utf8'));
  assert.equal(seed1398.ticker, '1398.HK');
  assert.ok(seed1398.southbound?.pct > 0);
  assert.ok(seed1398.short?.shares > 0);
  assert.ok((seed1398.southbound.history || []).length >= 20,
    'seed should retain ~1y weekly+horizon southbound points');
  assert.ok('pct_chg_30d' in seed1398.southbound);
  assert.ok('pct_chg_360d' in seed1398.southbound);

  const seed0700 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'hk-smart-money', '0700.HK.json'), 'utf8'));
  assert.equal(seed0700.ticker, '0700.HK');

  const seed2318 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'hk-smart-money', '2318.HK.json'), 'utf8'));
  assert.ok((seed2318.di_events || []).length >= 1);
  assert.match(seed2318.di_events[0].event_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(seed2318.di_events[0].action);
  assert.ok(seed2318.southbound?.pct > 0);
});

function mockRes() {
  const headers = {};
  const res = {
    statusCode: 200,
    headers,
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(body) { res.body = JSON.parse(body); },
  };
  return res;
}

test('API rejects non-HK symbols and unknown actions with no-store', async () => {
  const handler = createApi.createHandler({
    fetch: async () => ({ ok: true, text: async () => '', json: async () => ({}) }),
  });
  const res = mockRes();
  await handler({ method: 'GET', url: '/api/hk-smart-money?action=stock&symbol=AAPL', headers: {} }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'HK_SYMBOL_REQUIRED');
  assert.equal(res.headers['cache-control'], 'no-store');

  const res2 = mockRes();
  await handler({ method: 'GET', url: '/api/hk-smart-money?action=nope', headers: {} }, res2);
  assert.equal(res2.statusCode, 400);
  assert.equal(res2.body.error, 'INVALID_ACTION');
  assert.equal(res2.headers['cache-control'], 'no-store');
});

test('API stock action serves seed with public cache; rate-limit uses rightmost XFF', async () => {
  const handler = createApi.createHandler({
    fetch: async () => {
      throw new Error('UPSTREAM_SHOULD_NOT_RUN');
    },
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=stock&symbol=0700.HK',
    headers: { 'x-forwarded-for': '1.1.1.1, 9.9.9.9' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, '0700.HK');
  assert.ok(res.body.southbound?.pct > 0);
  assert.match(res.headers['cache-control'], /^public/);

  // Exhaust live budget with spoofed left XFF but same rightmost IP — should 429.
  for (let i = 0; i < 8; i += 1) {
    const r = mockRes();
    await handler({
      method: 'GET',
      url: '/api/hk-smart-money?action=flow&refresh=1',
      headers: {
        'x-forwarded-for': `${i}.0.0.1, 9.9.9.9`,
      },
    }, r);
    if (i < 6) {
      // May succeed or fail upstream; either way not necessarily 429 yet.
    }
  }
  const limited = mockRes();
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=flow&refresh=1',
    headers: { 'x-forwarded-for': '8.8.8.8, 9.9.9.9' },
  }, limited);
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.headers['cache-control'], 'no-store');
});

test('API stock refresh uses private cache mode on success', async () => {
  const sbHtml = `
    <input name="txtShareholdingDate" type="text" value="2026/11/06" id="txtShareholdingDate" />
    <input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="x" />
    <input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="y" />
    <input type="hidden" name="today" id="today" value="20261106" />
    <input type="hidden" name="sortBy" id="sortBy" value="stockcode" />
    <input type="hidden" name="sortDirection" id="sortDirection" value="asc" />
    <input type="hidden" name="originalShareholdingDate" id="originalShareholdingDate" value="2026/11/06" />
    <tr>
      <td class="col-stock-code"><div class="mobile-list-body">1398</div></td>
      <td class="col-stock-name"><div class="mobile-list-body">ICBC</div></td>
      <td class="col-shareholding"><div class="mobile-list-body">100</div></td>
      <td class="col-shareholding-percent"><div class="mobile-list-body">10.00%</div></td>
    </tr>`;
  const diHtml = `
    <TR bgColor="#cccccc"><TD class="txt" width="130" valign="top"><a href="/di/NSForm2.aspx?fn=X&sc=01398">X</a></TD>
    <TD class="txt" width="120" valign="top"><a href="/di/NSSrchCorpList.aspx">ICBC</a></TD>
    <TD class="txt" width="52" valign="top">01398</TD>
    <TD class="txt" width="80" valign="top">Ordinary Shares</TD>
    <TD class="txt" width="120" valign="top"><a href="/di/NSSrchPersonList.aspx">Demo Filer</a></TD>
    <TD class="txt" width="80" valign="top"><a href="/di/NSForm2.aspx?fn=X">01/11/2026</a></TD>
    <TD class="txt" width="80" valign="top"><a href="javascript: window.open('/di/NSStdCode.htm?ft=CS#1001', '', '');void(0);">1001</a>(L)<br></TD>
    <TD class="txt" width="120" valign="top">1(L)<br></TD>
    <TD class="txt" width="100" valign="top"></TD>
    <TD class="txt" width="180" valign="top" colspan="2"><TABLE cellSpacing='0' cellPadding='2' border='0'><TR><TD class='txt' align='right'>1(L)</TD><TD class='txt' align='right'>5.00</TD></TR></TABLE></TD>
    <TD class="txt" width="180" valign="top" colspan="2"><TABLE cellSpacing='0' cellPadding='2' border='0'><TR><TD class='txt' align='right'>2(L)</TD><TD class='txt' align='right'>5.10</TD></TR></TABLE></TD></TR>`;
  const sfcPage = '<a href="https://www.sfc.hk/-/media/EN/pdf/spr/2026/10/30/Short_Position_Reporting_Aggregated_Data_20261030.csv">csv</a>';
  const sfcCsv = `Date,Stock Code,Stock Name,Aggregated Reportable Short Positions (Shares),Aggregated Reportable Short Positions (HK$)
30/10/2026,1398,ICBC,1000,2000`;
  const csm = `tabData = ${JSON.stringify([{
    id: 1, date: '2026-11-06', market: 'SSE Southbound', tradingDay: 1,
    content: [{
      style: 1,
      table: {
        schema: [['Buy Turnover', 'Sell Turnover']],
        tr: [{ td: [['3']] }, { td: [['1']] }],
      },
    }],
  }])};`;

  const handler = createApi.createHandler({
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('mutualmarket')) return { ok: true, text: async () => sbHtml };
      if (href.includes('/di/summary/')) {
        return { ok: true, text: async () => (href.includes('C1') ? diHtml : '<html></html>') };
      }
      if (href.includes('sfc.hk') && href.includes('.csv')) return { ok: true, text: async () => sfcCsv };
      if (href.includes('sfc.hk')) return { ok: true, text: async () => sfcPage };
      if (href.includes('DailyStat')) return { ok: true, text: async () => csm };
      return { ok: false, status: 404, text: async () => 'missing' };
    },
  });

  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=stock&symbol=1398.HK&refresh=1',
    headers: { 'x-real-ip': '203.0.113.10' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ticker, '1398.HK');
  assert.equal(res.body.source, 'live');
  assert.match(res.headers['cache-control'], /^private/);
  assert.ok(res.body.di_events.some(row => row.filer === 'Demo Filer' && row.action));
});

test('API southbound without symbol is rejected (no full-table scrape)', async () => {
  const handler = createApi.createHandler({
    fetch: async () => ({ ok: true, text: async () => '' }),
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=southbound',
    headers: { 'x-real-ip': '203.0.113.20' },
  }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'SYMBOL_REQUIRED');
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('unseeded stock GET returns empty (no live scrape) unless refresh=1', async () => {
  let upstream = 0;
  const handler = createApi.createHandler({
    fetch: async () => {
      upstream += 1;
      return { ok: true, text: async () => '' };
    },
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=stock&symbol=9999.HK',
    headers: { 'x-real-ip': '203.0.113.30' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'empty');
  assert.equal(res.body.notice, 'HK_SMART_MONEY_NO_SEED');
  assert.equal(upstream, 0);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('live shorts action returns buildShortForCode shape (not raw CSV)', async () => {
  createApi.resetCachesForTests();
  const sfcPage = '<a href="https://www.sfc.hk/-/media/EN/pdf/spr/2026/10/30/a.csv">csv</a>'
    + '<a href="https://www.sfc.hk/-/media/EN/pdf/spr/2026/10/23/b.csv">csv</a>';
  const week0 = `Date,Stock Code,Stock Name,Aggregated Reportable Short Positions (Shares),Aggregated Reportable Short Positions (HK$)
30/10/2026,1398,ICBC,1269281039,10020973803`;
  const week1 = `Date,Stock Code,Stock Name,Aggregated Reportable Short Positions (Shares),Aggregated Reportable Short Positions (HK$)
23/10/2026,1398,ICBC,1243943868,9800000000`;
  const handler = createApi.createHandler({
    fetch: async (url) => {
      const href = String(url);
      if (href.includes('.csv') && href.includes('10/30')) return { ok: true, text: async () => week0 };
      if (href.includes('.csv') && href.includes('10/23')) return { ok: true, text: async () => week1 };
      if (href.includes('sfc.hk')) return { ok: true, text: async () => sfcPage };
      return { ok: false, status: 404, text: async () => 'missing' };
    },
  });
  const res = mockRes();
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=shorts&symbol=1398.HK&refresh=1',
    headers: { 'x-real-ip': '203.0.113.40' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, 'live');
  assert.ok(res.body.row);
  assert.equal(res.body.row.shares, 1269281039);
  assert.equal(res.body.row.shares_chg_wow, 1269281039 - 1243943868);
  assert.ok(res.body.row.as_of);
  assert.ok('pct_of_issued' in res.body.row);
  assert.ok('hkd' in res.body.row);
  assert.match(res.headers['cache-control'], /^private/);
});
