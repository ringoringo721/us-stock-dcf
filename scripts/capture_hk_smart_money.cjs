#!/usr/bin/env node
'use strict';

/**
 * Capture HK Smart Money seeds (DI / southbound / SFC shorts / CSM flow).
 * Polite sequential fetches — run manually, do not put on a tight cron.
 *
 * Usage:
 *   node scripts/capture_hk_smart_money.cjs
 *   node scripts/capture_hk_smart_money.cjs 1398.HK 0700.HK 2318.HK
 */

const fs = require('node:fs');
const path = require('node:path');
const HkSmartMoney = require('../hk_smart_money.js');

const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'cache', 'hk-smart-money');
const DEFAULT_TICKERS = ['1398.HK', '0700.HK', '2318.HK', '3988.HK'];

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchText(url, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': HkSmartMoney.USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(40000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return text;
}

function grabHidden(html, name) {
  const byName = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i'));
  if (byName) return byName[1];
  const byId = html.match(new RegExp(`id="${name}"[^>]*value="([^"]*)"`, 'i'));
  return byId ? byId[1] : '';
}

async function fetchSouthbound(dateIso) {
  const url = HkSmartMoney.SOUTHBOUND_URL;
  let html = await fetchText(url);
  const wanted = dateIso ? HkSmartMoney.toSlashDate(dateIso) : null;
  const current = grabHidden(html, 'txtShareholdingDate');
  if (wanted && wanted !== current) {
    const params = new URLSearchParams({
      __EVENTTARGET: 'btnSearch',
      __EVENTARGUMENT: '',
      __VIEWSTATE: grabHidden(html, '__VIEWSTATE'),
      __VIEWSTATEGENERATOR: grabHidden(html, '__VIEWSTATEGENERATOR'),
      today: grabHidden(html, 'today'),
      sortBy: grabHidden(html, 'sortBy') || 'stockcode',
      sortDirection: grabHidden(html, 'sortDirection') || 'asc',
      originalShareholdingDate: grabHidden(html, 'originalShareholdingDate'),
      alertMsg: '',
      txtShareholdingDate: wanted,
    });
    html = await fetchText(url, {
      method: 'POST',
      body: params.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: url,
        Origin: 'https://www3.hkexnews.hk',
      },
    });
  }
  return HkSmartMoney.parseSouthboundHtml(html);
}

async function main() {
  const tickers = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TICKERS;
  const codes = tickers.map(t => HkSmartMoney.codeFromTicker(t)).filter(Boolean);
  fs.mkdirSync(outDir, { recursive: true });

  const days = HkSmartMoney.businessDaysBack(HkSmartMoney.DI_LOOKBACK_DAYS);
  const diByCode = Object.fromEntries(codes.map(code => [code, []]));
  for (const day of days) {
    for (const [cat, role] of [[1, 'substantial'], [2, 'director']]) {
      const url = HkSmartMoney.DI_SUMMARY_TMPL
        .replace('{date}', day.replace(/-/g, ''))
        .replace('{cat}', String(cat));
      try {
        const html = await fetchText(url);
        const events = HkSmartMoney.parseDiSummaryHtml(html, role, day);
        for (const event of events) {
          if (diByCode[event.stock_code]) diByCode[event.stock_code].push(event);
        }
        process.stdout.write(`DI ${day} C${cat}: ${events.length}\n`);
      } catch (error) {
        process.stderr.write(`DI fail ${day} C${cat}: ${error.message}\n`);
      }
      await sleep(150);
    }
  }

  // Southbound history ≤ ~1y (HKEXnews retention): dense recent sessions for
  // short Δ windows, long calendar horizons, plus weekly samples for the curve.
  const asOfList = HkSmartMoney.businessDaysBack(1);
  const asOf = asOfList[0];
  const sbDateSet = new Set();
  // Dense ~1 month so 1D/5D/20D still resolve when the latest session is empty.
  for (const day of HkSmartMoney.businessDaysBack(25, asOf)) sbDateSet.add(day);
  for (const days of HkSmartMoney.SOUTHBOUND_LONG_CAL_DAYS) {
    const target = HkSmartMoney.shiftCalendarDays(asOf, days);
    if (!target) continue;
    // Snap to business day on/before target so mutualmarket has a session.
    const snapped = HkSmartMoney.businessDaysBack(1, target)[0];
    if (snapped) sbDateSet.add(snapped);
  }
  // Weekly samples across ~52 weeks (~260 biz days).
  const yearBiz = HkSmartMoney.businessDaysBack(260, asOf);
  for (let i = 0; i < yearBiz.length; i += 5) sbDateSet.add(yearBiz[i]);

  const sbDates = [...sbDateSet].sort((a, b) => String(b).localeCompare(String(a)));
  process.stdout.write(`SB dates planned: ${sbDates.length}\n`);
  const sbHistory = {};
  for (const day of sbDates) {
    try {
      const snap = await fetchSouthbound(day);
      sbHistory[snap.as_of || day] = snap;
      process.stdout.write(`SB ${day} → ${snap.as_of} rows=${snap.rows.length}\n`);
    } catch (error) {
      process.stderr.write(`SB fail ${day}: ${error.message}\n`);
    }
    await sleep(180);
  }

  const sfcPage = await fetchText(HkSmartMoney.SFC_SHORTS_PAGE);
  const csvLinks = HkSmartMoney.extractSfcCsvLinks(sfcPage);
  const shortWeeks = [];
  for (const link of csvLinks.slice(0, 2)) {
    const csv = await fetchText(link, { headers: { Accept: 'text/csv,*/*' } });
    shortWeeks.push(HkSmartMoney.parseSfcShortCsv(csv));
    await sleep(100);
  }

  let marketFlow = null;
  for (const day of HkSmartMoney.businessDaysBack(5)) {
    const url = HkSmartMoney.CSM_DAILY_TMPL.replace('{date}', day.replace(/-/g, ''));
    try {
      const text = await fetchText(url, { headers: { Accept: 'application/javascript,text/plain,*/*' } });
      marketFlow = HkSmartMoney.parseCsmDailyJs(text);
      if (marketFlow.southbound?.length) break;
    } catch (error) {
      process.stderr.write(`flow fail ${day}: ${error.message}\n`);
    }
  }

  const sbDateKeys = Object.keys(sbHistory).sort((a, b) => String(b).localeCompare(String(a)));
  for (const code of codes) {
    const history = [];
    for (const date of sbDateKeys) {
      const row = sbHistory[date].byCode?.[code];
      if (row) history.push({ date, shares: row.shares, pct: row.pct, name: row.name });
    }
    const southbound = HkSmartMoney.buildSouthboundForCode(history);
    const short = HkSmartMoney.buildShortForCode(
      shortWeeks[0]?.byCode?.[code] || null,
      shortWeeks[1]?.byCode?.[code] || null,
      southbound,
    );
    const ticker = HkSmartMoney.tickerFromCode(code);
    const payload = {
      ticker,
      stock_code: code,
      source: 'seed',
      capturedAt: new Date().toISOString(),
      southbound,
      di_events: (diByCode[code] || [])
        .sort((a, b) => String(b.event_date || '').localeCompare(String(a.event_date || ''))),
      short,
      market_flow: marketFlow,
      notes: {
        zh: '官方日終／週更披露之轉送快照；非投資建議。南向為港股通合計（A00003+A00004），非單一基金。',
        en: 'Relay of official daily/weekly disclosures; not investment advice. Southbound is Stock Connect aggregate (A00003+A00004), not a single fund.',
      },
    };
    const file = path.join(outDir, `${ticker}.json`);
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    process.stdout.write(`wrote ${file} sb=${southbound.pct} di=${payload.di_events.length}\n`);
  }

  if (marketFlow) {
    fs.writeFileSync(path.join(outDir, 'market-flow.json'), `${JSON.stringify(marketFlow, null, 2)}\n`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
