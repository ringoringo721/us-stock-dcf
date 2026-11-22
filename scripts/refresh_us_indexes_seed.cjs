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
  // Refuse partial belts: validatePayload only needs ≥1 row, but the public seed
  // must keep the full catalog so a thin FMP response cannot strip the ribbon.
  const expected = UsIndexes.SYMBOLS.length;
  if (!Array.isArray(payload.indexes) || payload.indexes.length !== expected) {
    const got = Array.isArray(payload.indexes) ? payload.indexes.length : 0;
    const have = new Set((payload.indexes || []).map(row => row.symbol));
    const missing = UsIndexes.SYMBOLS.filter(symbol => !have.has(symbol));
    throw new Error(
      `US_INDEX_SEED_INCOMPLETE: got ${got}/${expected}`
      + (missing.length ? `; missing ${missing.join(',')}` : ''),
    );
  }

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
