#!/usr/bin/env node
'use strict';

/**
 * Rewrite committed US index-belt seed from live FMP (batch-quote + EOD history).
 * Used by daily_update so anonymous /api/us-indexes seed stays current.
 */

const fs = require('node:fs');
const path = require('node:path');
const { fetchLivePayload } = require('../api/us-indexes.js');
const UsIndexes = require('../us_indexes.js');

async function main() {
  const key = String(process.env.FMP_API_KEY || '').trim();
  if (!key) throw new Error('FMP_API_KEY is required; US index belt seed was not refreshed');

  const now = new Date();
  const payload = await fetchLivePayload({
    fetcher: globalThis.fetch,
    key,
    now,
  });
  UsIndexes.validatePayload(payload);

  const outDir = path.join(__dirname, '..', 'cache', 'us-indexes');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'latest.json');
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  const majors = payload.indexes.filter(row => row.kind === 'major');
  console.log(JSON.stringify({
    ok: true,
    path: 'cache/us-indexes/latest.json',
    capturedAt: payload.capturedAt,
    count: payload.indexes.length,
    majors: majors.map(row => ({
      symbol: row.symbol,
      changePct: Number(row.changePct.toFixed(4)),
      price: row.price,
    })),
  }, null, 2));
}

main().catch(error => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
