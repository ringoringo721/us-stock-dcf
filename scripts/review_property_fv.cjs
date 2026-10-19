const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

async function review({ market, apiKey, fetcher = fetch, limit = 10 }) {
  if (!apiKey) throw new Error('FMP_NOT_CONFIGURED');
  const tickers = Object.keys(market), records = {};
  let cursor = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (cursor < tickers.length) {
      const ticker = tickers[cursor++], symbol = ticker.endsWith('.HK') ? ticker : ticker.replaceAll('.', '-');
      const url = new URL('https://financialmodelingprep.com/stable/financial-statement-full-as-reported');
      for (const [key, value] of Object.entries({ symbol, period: 'annual', limit, apikey: apiKey })) url.searchParams.set(key, value);
      const response = await fetcher(url, { signal: AbortSignal.timeout(60000), redirect: 'error' });
      if (!response.ok) throw new Error(`${ticker}: FMP_HTTP_${response.status}`);
      const rows = await response.json();
      if (!Array.isArray(rows) || rows.some(row => row.symbol !== symbol || !row.data || typeof row.data !== 'object')) {
        throw new Error(`${ticker}: INVALID_AS_REPORTED_RESPONSE`);
      }
      const candidates = rows.flatMap(row => Object.entries(row.data).filter(([tag]) =>
        /(?:investmentpropert|realestate).*(?:revalu|fairvalue)|(?:revalu|fairvalue).*investmentpropert/i.test(tag))
        .map(([tag, value]) => ({ date: row.date, fiscalYear: row.fiscalYear, period: row.period,
          currency: row.reportedCurrency, tag, value })));
      records[ticker] = { providerSymbol: symbol, periods: rows.map(row => ({ date: row.date, period: row.period })),
        responseSha256: crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
        reason: !rows.length ? 'NO_AS_REPORTED_COVERAGE' : candidates.length ? 'CANDIDATE_TAGS_REQUIRE_REVIEW'
          : 'NO_ISOLATED_PROPERTY_FV_TAG_RETURNED', candidates };
    }
  }));
  return { version: 1, capturedAt: new Date().toISOString(), endpoint: 'FMP stable/financial-statement-full-as-reported',
    requestedAnnualPeriods: limit,
    limitation: 'A missing tag is not proof of zero FV change. Candidate tags can be balances, not P&L changes; none are applied automatically.',
    records: Object.fromEntries(tickers.map(ticker => [ticker, records[ticker]])) };
}
async function main() {
  process.loadEnvFile(path.join(__dirname, '..', '.env.local'));
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--output') throw new Error('Use --output FILE to save the coverage evidence');
  const result = await review({ market: { ...require('../full_market_dcf.json'), ...require('../hk_market_dcf.json') },
    apiKey: process.env.FMP_API_KEY });
  fs.writeFileSync(args[1], JSON.stringify(result, null, 2) + '\n');
  const counts = {};
  for (const row of Object.values(result.records)) counts[row.reason] = (counts[row.reason] || 0) + 1;
  console.log(JSON.stringify({ tickers: Object.keys(result.records).length, counts,
    candidates: Object.entries(result.records).filter(([, row]) => row.candidates.length).map(([ticker, row]) => ({ ticker, candidates: row.candidates })) }));
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { review };
