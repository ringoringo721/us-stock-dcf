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

test('codeFromTicker / tickerFromCode round-trip', () => {
  assert.equal(HkSmartMoney.codeFromTicker('1398.HK'), '01398');
  assert.equal(HkSmartMoney.codeFromTicker('0700.HK'), '00700');
  assert.equal(HkSmartMoney.tickerFromCode('01398'), '1398.HK');
  assert.equal(HkSmartMoney.tickerFromCode(700), '700.HK');
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

test('parseSfcShortCsv and buildShortForCode', () => {
  const csv = `Date,Stock Code,Stock Name,Aggregated Reportable Short Positions (Shares),Aggregated Reportable Short Positions (HK$)
30/10/2026,1398,ICBC,1269281039,10020973803
23/10/2026,1398,ICBC,1243943868,9800000000`;
  const week = HkSmartMoney.parseSfcShortCsv(csv.split('\n').slice(0, 2).join('\n'));
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
});

test('committed HK seeds cover 1398.HK and a Connect name with DI', () => {
  const seed1398 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'hk-smart-money', '1398.HK.json'), 'utf8'));
  assert.equal(seed1398.ticker, '1398.HK');
  assert.ok(seed1398.southbound?.pct > 0);
  assert.ok(seed1398.short?.shares > 0);

  const seed2318 = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'cache', 'hk-smart-money', '2318.HK.json'), 'utf8'));
  assert.ok((seed2318.di_events || []).length >= 1);
  assert.ok(seed2318.southbound?.pct > 0);
});

test('API rejects non-HK symbols and unknown actions', async () => {
  const handler = createApi.createHandler({
    fetch: async () => ({ ok: true, text: async () => '', json: async () => ({}) }),
  });
  const responses = [];
  const res = {
    setHeader() {},
    end(body) { responses.push({ status: res.statusCode, body: JSON.parse(body) }); },
  };
  await handler({ method: 'GET', url: '/api/hk-smart-money?action=stock&symbol=AAPL', headers: {} }, res);
  assert.equal(responses.at(-1).status, 400);
  assert.equal(responses.at(-1).body.error, 'HK_SYMBOL_REQUIRED');

  await handler({ method: 'GET', url: '/api/hk-smart-money?action=nope', headers: {} }, res);
  assert.equal(responses.at(-1).status, 400);
  assert.equal(responses.at(-1).body.error, 'INVALID_ACTION');
});

test('API stock action serves committed seed without upstream', async () => {
  const handler = createApi.createHandler({
    fetch: async () => {
      throw new Error('UPSTREAM_SHOULD_NOT_RUN');
    },
  });
  let payload = null;
  const res = {
    statusCode: 200,
    setHeader() {},
    end(body) { payload = JSON.parse(body); },
  };
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=stock&symbol=1398.HK',
    headers: { 'x-forwarded-for': '127.0.0.1' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ticker, '1398.HK');
  assert.ok(payload.southbound?.pct > 0);
  assert.ok(['seed', 'cache'].includes(payload.source) || payload.source);
});

test('API stock refresh rebuilds from upstream fixtures', async () => {
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
    fetch: async (url, opts = {}) => {
      const href = String(url);
      if (href.includes('mutualmarket')) {
        return { ok: true, text: async () => sbHtml };
      }
      if (href.includes('/di/summary/')) {
        return { ok: true, text: async () => (href.includes('C1') ? diHtml : '<html></html>') };
      }
      if (href.includes('sfc.hk') && href.includes('.csv')) {
        return { ok: true, text: async () => sfcCsv };
      }
      if (href.includes('sfc.hk')) {
        return { ok: true, text: async () => sfcPage };
      }
      if (href.includes('DailyStat')) {
        return { ok: true, text: async () => csm };
      }
      return { ok: false, status: 404, text: async () => 'missing' };
    },
  });

  let payload = null;
  const res = {
    statusCode: 200,
    setHeader() {},
    end(body) { payload = JSON.parse(body); },
  };
  await handler({
    method: 'GET',
    url: '/api/hk-smart-money?action=stock&symbol=1398.HK&refresh=1',
    headers: { 'x-forwarded-for': '10.0.0.2' },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(payload.ticker, '1398.HK');
  assert.equal(payload.source, 'live');
  assert.equal(payload.southbound.pct, 10);
  assert.ok(payload.di_events.some(row => row.filer === 'Demo Filer'));
  assert.equal(payload.short.shares, 1000);
  assert.equal(payload.market_flow.southbound[0].net_buy, 2);
});
