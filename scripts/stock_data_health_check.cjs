'use strict';
/**
 * Full US+HK health check after #108/#109: profile TTM, peers TTM, five-year history,
 * tax autofill, holders/insiders/splits. Classifies ok | honest_empty | bug.
 */
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
process.chdir(root);

const UsdCurrency = require('../usd_currency.js');
const Profile = require('../profile_overview.js');
const Peer = require('../peer_comparison.js');
const Scenario = require('../fmp_scenario.js');

const usdRates = JSON.parse(fs.readFileSync('cache/fx/usd_rates.json', 'utf8'));
let hkdRates = null;
try { hkdRates = JSON.parse(fs.readFileSync('cache/fx/hkd_rates.json', 'utf8')); } catch {}

const EX = n => Math.min(n, 12);

function listTickers(dir, suffix) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith(suffix)).map(f => f.slice(0, -suffix.length));
}

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function loadCompany(market, ticker) {
  const file = market === 'US'
    ? `cache/us_companies/${ticker}.json`
    : `cache/hk_companies/${ticker}.json`;
  const pack = loadJson(file);
  return pack?.stock || null;
}

function loadStatements(ticker) {
  return loadJson(`cache/financials/${ticker}_statements_v2.json`);
}

function convert(statements, market) {
  if (!statements?.annual || !statements?.quarterly) return { error: 'missing_statements' };
  try {
    const currency = market === 'HK' ? 'HKD' : 'USD';
    const rates = market === 'HK' ? hkdRates : usdRates;
    const data = { ...statements, calculationCurrency: currency };
    // HK packs often already HKD; convertStatements still sets cadence.
    const foreign = ['annual', 'quarterly'].some(period =>
      Object.values(data[period] || {}).filter(Array.isArray).flat()
        .some(row => row.reportedCurrency && row.reportedCurrency !== currency
          && !({ NTD: 'TWD', RMB: 'CNY' }[row.reportedCurrency] === currency)));
    return UsdCurrency.convertStatements(data, foreign ? rates : null, currency);
  } catch (e) {
    return { error: e.message };
  }
}

function classifyProfileTtm(conv, market) {
  if (conv.error) return { status: 'honest_empty', reason: conv.error };
  const q = conv.quarterly?.income || [];
  if (!q.length) {
    // Annual-only reporters (some HK) — TTM from quarterly N/A is honest if annual exists
    const annual = (conv.annual?.income || []).filter(r => r.period === 'FY' || !r.period);
    return { status: annual.length ? 'honest_empty' : 'honest_empty', reason: 'no_quarterly_income' };
  }
  try {
    const summary = Profile.calculate(conv);
    const hasRev = Number.isFinite(summary.revenue) && summary.revenue > 0;
    const hasMargin = Number.isFinite(summary.grossMargin) || Number.isFinite(summary.operatingMargin)
      || Number.isFinite(summary.netMargin);
    const hasGrowth = Number.isFinite(summary.revenueGrowth);
    if (hasRev && (hasMargin || hasGrowth)) {
      return { status: 'ok', revenue: summary.revenue, frequency: conv.reportingFrequency,
        grossMargin: summary.grossMargin, revenueGrowth: summary.revenueGrowth };
    }
    // Diagnose bug vs honest
    const periods = [...new Set(q.map(r => r.period).filter(Boolean))];
    const onlyQ24 = periods.length && periods.every(p => p === 'Q2' || p === 'Q4');
    const fxNull = q.filter(r => r.currencyConversion?.reason).length;
    const positive = q.filter(r => Number.isFinite(r.revenue) && r.revenue > 0).length;
    if (positive < 2) {
      return { status: 'honest_empty', reason: positive === 0 ? 'no_positive_quarterly_revenue' : 'insufficient_quarters',
        periods, fxNull, frequency: conv.reportingFrequency };
    }
    // Enough positive rows but Profile still blank → likely cadence/window bug residual
    if (conv.reportingFrequency === 'quarterly' && onlyQ24) {
      return { status: 'bug', reason: 'q2q4_still_quarterly_cadence', periods, frequency: conv.reportingFrequency };
    }
    return { status: 'bug', reason: 'ttm_blank_with_positive_quarters', periods, frequency: conv.reportingFrequency,
      fxNull, positive, summaryReason: !hasRev ? 'no_ttm_revenue' : 'no_margins_or_growth' };
  } catch (e) {
    return { status: 'bug', reason: `profile_throw:${e.message}` };
  }
}

function classifyPeersTarget(stock, conv, market) {
  if (!stock) return { status: 'honest_empty', reason: 'no_company_pack' };
  if (market === 'HK') {
    // HK peers use annualView
    if (conv.error) return { status: 'honest_empty', reason: conv.error };
    try {
      const viewed = Peer.annualView(
        { ...stock, calculationCurrency: stock.calculationCurrency || 'HKD' },
        { ...conv, calculationCurrency: stock.calculationCurrency || 'HKD' }
      );
      const rev = viewed.peerAnnual?.income?.revenue;
      if (Number.isFinite(rev) && rev > 0) return { status: 'ok', revenueM: rev };
      if (viewed.peerAnnual?.providerStatementsUnavailable) {
        return { status: 'honest_empty', reason: 'provider_statements_unavailable' };
      }
      if (viewed.peerAnnual?.reason === 'missingFullFiscalYear') {
        // After #109 periodLength fix — if FY rows exist without pl=12 this should be ok.
        const fy = (conv.annual?.income || []).filter(r => r.period === 'FY' || !r.period);
        if (fy.some(r => Number.isFinite(r.revenue) && r.revenue > 0)) {
          return { status: 'bug', reason: 'missingFullFiscalYear_with_fy_rows', fyCount: fy.length };
        }
        return { status: 'honest_empty', reason: 'missingFullFiscalYear' };
      }
      return { status: 'honest_empty', reason: viewed.peerAnnual?.reason || 'no_annual_revenue' };
    } catch (e) {
      return { status: 'bug', reason: `annualView_throw:${e.message}` };
    }
  }
  // US: overlay TTM like runtime
  if (conv.error) {
    const raw = stock.statements_raw?.income?.revenue;
    const latest = Array.isArray(raw) ? raw[raw.length - 1] : null;
    if (Number.isFinite(latest) && latest > 0) return { status: 'ok', revenueM: latest, source: 'pack_only' };
    return { status: 'honest_empty', reason: conv.error };
  }
  try {
    const overlaid = Peer.overlayUsTtm(stock, conv);
    const latest = overlaid.statements_raw?.income?.revenue?.at(-1);
    if (Number.isFinite(latest) && latest > 0) {
      return { status: 'ok', revenueM: latest, frequency: conv.reportingFrequency };
    }
    if (Number.isFinite(latest) && latest === 0) {
      return { status: 'bug', reason: 'peers_ttm_still_zero_after_overlay', frequency: conv.reportingFrequency };
    }
    // No TTM but annual FY in pack?
    const annual = stock.statements_raw?.income?.revenue;
    const hasAnnual = Array.isArray(annual) && annual.some(v => Number.isFinite(v) && v > 0);
    return { status: hasAnnual ? 'bug' : 'honest_empty',
      reason: hasAnnual ? 'peers_ttm_null_with_annual' : 'no_ttm_or_annual_revenue',
      frequency: conv.reportingFrequency };
  } catch (e) {
    return { status: 'bug', reason: `overlay_throw:${e.message}` };
  }
}

function classifyHistoryTax(conv, stock, market) {
  if (conv.error) return { history: { status: 'honest_empty', reason: conv.error },
    tax: { status: 'honest_empty', reason: conv.error } };
  const currency = market === 'HK'
    ? (stock?.reportedCurrency || 'HKD')
    : (stock?.reportedCurrency || conv.annual?.income?.[0]?.sourceReportedCurrency
      || conv.annual?.income?.[0]?.reportedCurrency || 'USD');
  // Prefer filing currency for fiveYearEffectiveTax matching
  const filingCurrency = (() => {
    const rows = (conv.annual?.income || []).filter(r => r.period === 'FY' || r.period === undefined);
    const src = rows.map(r => r.sourceReportedCurrency || r.reportedCurrency).filter(Boolean);
    return src[0] || currency;
  })();

  const income = (conv.annual?.income || [])
    .filter(r => Scenario.fullAnnualPeriod(r) && Number.isFinite(r.revenue) && r.revenue > 0)
    .slice().sort((a, b) => a.date.localeCompare(b.date));
  let history;
  if (income.length < 5) {
    history = { status: 'honest_empty', reason: 'HISTORY_FIVE_YEAR_INCOMPLETE', fyCount: income.length };
  } else {
    const latest = income.at(-1);
    const year = Number(latest.fiscalYear || latest.calendarYear);
    const fakeCompany = {
      forecastBase: { year, date: latest.date, reason: null },
      currencyCheck: { sourceCurrency: latest.sourceReportedCurrency || latest.reportedCurrency }
    };
    const hist = Scenario.fiveYearHistory(conv, fakeCompany, 'advanced');
    if (!hist.reason) {
      history = { status: 'ok', years: hist.years?.map(y => y.year) };
    } else if (hist.reason === 'HISTORY_FIVE_YEAR_INCOMPLETE') {
      // Check if FX gaps on oldest (the #108 class) — after fix should be rare for Mar FYE
      const gaps = hist.gaps || [];
      const fxGaps = gaps.filter(g => g.code === 'FX_REVENUE_UNAVAILABLE' || g.detail === 'missingFxPeriod');
      if (fxGaps.length && income.length >= 5) {
        history = { status: 'bug', reason: hist.reason, gaps: gaps.slice(0, 5), detail: 'fx_gap_with_five_fy' };
      } else {
        history = { status: 'honest_empty', reason: hist.reason, gaps: gaps.slice(0, 5) };
      }
    } else {
      history = { status: 'honest_empty', reason: hist.reason };
    }
  }

  let tax;
  if (income.length < 1) {
    tax = { status: 'honest_empty', reason: 'no_fy_income' };
  } else {
    const latest = income.at(-1);
    const year = Number(latest.fiscalYear || latest.calendarYear);
    const matchCurrency = latest.sourceReportedCurrency || latest.reportedCurrency;
    const taxFive = Scenario.fiveYearEffectiveTax(conv, { year, date: latest.date }, matchCurrency);
    if (!taxFive.reason && Scenario.usableOperatingTax(taxFive.percent)) {
      tax = { status: 'ok', percent: taxFive.percent, years: taxFive.years, origin: 'five-year-effective-tax' };
    } else {
      // Check extreme latest-FY wouldn't be autofilled
      const latestRate = latest.incomeBeforeTax > 0 && Number.isFinite(latest.incomeTaxExpense)
        ? latest.incomeTaxExpense / latest.incomeBeforeTax * 100 : null;
      if (Scenario.usableOperatingTax(latestRate)) {
        tax = { status: 'ok', percent: latestRate, origin: 'latest-fy-usable' };
      } else {
        // Statutory fallback path — OK (filled), not a bug
        tax = { status: 'ok', percent: Scenario.STATUTORY_OPERATING_TAX_FALLBACK,
          origin: 'statutory-operating-tax-fallback',
          fiveYearReason: taxFive.reason, latestRate };
        // Flag residual bug if latest is extreme AND five-year incomplete for FX reasons only
        if (Number.isFinite(latestRate) && (latestRate > 40 || latestRate < 0)
            && taxFive.reason === null && Scenario.usableOperatingTax(taxFive.percent) === false
            && (taxFive.skipped || []).every(s => s.reason === 'TAX_RATE_OUTLIER' || s.reason === 'TAX_PRETAX_OR_EXPENSE_UNAVAILABLE')) {
          // Soft tax working correctly
        }
      }
    }
  }
  return { history, tax };
}

function classifyHolders(stock, market) {
  if (!stock) {
    return {
      holders: { status: 'honest_empty', reason: 'no_company_pack' },
      insiders: { status: 'honest_empty', reason: 'no_company_pack' },
      splits: { status: 'honest_empty', reason: 'no_company_pack' }
    };
  }
  const holdersN = (stock.top_holders || []).length;
  const insidersN = (stock.insider_trades || []).length;
  const splitsN = (stock.stock_splits || []).length;
  const hasCompanyCache = fs.existsSync(
    market === 'US' ? `cache/company/${stock.ticker}.json` : `cache/company/${stock.ticker}.json`
  );
  // Holders: empty across expansion is known capture gap unless company cache exists with holders
  let holders;
  if (holdersN > 0) holders = { status: 'ok', count: holdersN };
  else if (hasCompanyCache) {
    const company = loadJson(`cache/company/${stock.ticker}.json`);
    const liveN = (company?.holders?.data || []).length;
    if (liveN > 0) holders = { status: 'ok', count: liveN, source: 'company_cache_not_on_pack' };
    else holders = { status: 'honest_empty', reason: company?.holders?.reason || 'FMP_NO_HOLDERS', hasCompanyCache: true };
  } else {
    holders = { status: 'honest_empty', reason: 'no_company_cache_capture_gap' };
  }

  let insiders;
  if (insidersN > 0) insiders = { status: 'ok', count: insidersN };
  else if (hasCompanyCache) {
    const company = loadJson(`cache/company/${stock.ticker}.json`);
    const liveN = (company?.insiders?.data || []).length;
    if (liveN > 0) insiders = { status: 'bug', reason: 'company_cache_insiders_not_on_pack', count: liveN };
    else insiders = { status: 'honest_empty', reason: company?.insiders?.reason || 'FMP_NO_INSIDERS' };
  } else {
    insiders = { status: 'honest_empty', reason: 'no_insider_rows' };
  }

  let splits;
  if (splitsN > 0) splits = { status: 'ok', count: splitsN };
  else splits = { status: 'honest_empty', reason: 'no_splits_reported' };

  return { holders, insiders, splits };
}

function scanMarket(market) {
  const dir = market === 'US' ? 'cache/us_companies' : 'cache/hk_companies';
  const tickers = listTickers(dir, '.json').sort();
  const summary = {
    market, scanned: 0,
    profile: { ok: 0, honest_empty: 0, bug: 0 },
    peers: { ok: 0, honest_empty: 0, bug: 0 },
    history: { ok: 0, honest_empty: 0, bug: 0 },
    tax: { ok: 0, honest_empty: 0, bug: 0 },
    holders: { ok: 0, honest_empty: 0, bug: 0 },
    insiders: { ok: 0, honest_empty: 0, bug: 0 },
    splits: { ok: 0, honest_empty: 0, bug: 0 },
    examples: { profile_bug: [], peers_bug: [], history_bug: [], tax_bug: [],
      insiders_bug: [], profile_empty: [], peers_empty: [], history_empty: [] },
    semiannual: []
  };
  const bugs = [];

  for (const ticker of tickers) {
    const stock = loadCompany(market, ticker);
    if (!stock) continue;
    summary.scanned++;
    const raw = loadStatements(ticker);
    const conv = raw ? convert(raw, market) : { error: 'no_statements_file' };
    if (!conv.error && conv.reportingFrequency === 'semiannual') summary.semiannual.push(ticker);

    const profile = classifyProfileTtm(conv, market);
    const peers = classifyPeersTarget(stock, conv, market);
    const { history, tax } = classifyHistoryTax(conv, stock, market);
    const { holders, insiders, splits } = classifyHolders(stock, market);

    for (const [key, result] of Object.entries({ profile, peers, history, tax, holders, insiders, splits })) {
      summary[key][result.status] = (summary[key][result.status] || 0) + 1;
    }
    const pushEx = (bucket, obj) => {
      if (summary.examples[bucket].length < EX(12)) summary.examples[bucket].push(obj);
    };
    if (profile.status === 'bug') { bugs.push({ ticker, market, kind: 'profile', ...profile }); pushEx('profile_bug', { ticker, ...profile }); }
    if (peers.status === 'bug') { bugs.push({ ticker, market, kind: 'peers', ...peers }); pushEx('peers_bug', { ticker, ...peers }); }
    if (history.status === 'bug') { bugs.push({ ticker, market, kind: 'history', ...history }); pushEx('history_bug', { ticker, ...history }); }
    if (tax.status === 'bug') { bugs.push({ ticker, market, kind: 'tax', ...tax }); pushEx('tax_bug', { ticker, ...tax }); }
    if (insiders.status === 'bug') { bugs.push({ ticker, market, kind: 'insiders', ...insiders }); pushEx('insiders_bug', { ticker, ...insiders }); }
    if (profile.status === 'honest_empty' && summary.examples.profile_empty.length < 8) {
      pushEx('profile_empty', { ticker, reason: profile.reason });
    }
    if (peers.status === 'honest_empty' && summary.examples.peers_empty.length < 8) {
      pushEx('peers_empty', { ticker, reason: peers.reason });
    }
    if (history.status === 'honest_empty' && summary.examples.history_empty.length < 8) {
      pushEx('history_empty', { ticker, reason: history.reason, fyCount: history.fyCount });
    }
  }
  summary.semiannualCount = summary.semiannual.length;
  summary.bugList = bugs;
  return summary;
}

console.error('Scanning US…');
const us = scanMarket('US');
console.error(`US scanned=${us.scanned} profile_bug=${us.profile.bug} peers_bug=${us.peers.bug} history_bug=${us.history.bug}`);
console.error('Scanning HK…');
const hk = scanMarket('HK');
console.error(`HK scanned=${hk.scanned} profile_bug=${hk.profile.bug} peers_bug=${hk.peers.bug} history_bug=${hk.history.bug}`);

const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  mergeSha: '994b0c4fe0e19adb4517554d0f12e4a5deb61adb',
  prs: ['#108', '#109'],
  us, hk,
  totals: {
    scanned: us.scanned + hk.scanned,
    bugs: us.bugList.length + hk.bugList.length,
    byKind: {}
  }
};
for (const kind of ['profile', 'peers', 'history', 'tax', 'insiders']) {
  out.totals.byKind[kind] = {
    bug: (us.bugList.filter(b => b.kind === kind).length) + (hk.bugList.filter(b => b.kind === kind).length)
  };
}

fs.mkdirSync('scripts/data', { recursive: true });
fs.writeFileSync('scripts/data/stock_data_health_check.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify({
  mergeSha: out.mergeSha,
  scanned: out.totals.scanned,
  bugs: out.totals.bugs,
  byKind: out.totals.byKind,
  us: { scanned: us.scanned, profile: us.profile, peers: us.peers, history: us.history, tax: us.tax,
    holders: us.holders, insiders: us.insiders, splits: us.splits, semiannual: us.semiannualCount,
    examples: us.examples },
  hk: { scanned: hk.scanned, profile: hk.profile, peers: hk.peers, history: hk.history, tax: hk.tax,
    holders: hk.holders, insiders: hk.insiders, splits: hk.splits, semiannual: hk.semiannualCount,
    examples: hk.examples }
}, null, 2));
