'use strict';

const crypto = require('node:crypto');

/**
 * Live FMP rebuild for index belts is not gated by spoofable browser headers.
 * Public GETs serve seed / in-memory cache only. Live fan-out requires the
 * shared INDEX_BELT_REFRESH_SECRET via `x-index-belt-refresh` or
 * `Authorization: Bearer …` (timing-safe compare).
 */
function readRefreshSecret(env = process.env) {
  const value = env.INDEX_BELT_REFRESH_SECRET;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function candidateFromRequest(req) {
  const header = String(req?.headers?.['x-index-belt-refresh'] || '').trim();
  if (header) return header;
  const auth = String(req?.headers?.authorization || '').trim();
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return '';
}

function authorizeLiveRefresh(req, secret = readRefreshSecret()) {
  if (!secret) return false;
  const candidate = candidateFromRequest(req);
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(secret);
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

module.exports = {
  readRefreshSecret,
  candidateFromRequest,
  authorizeLiveRefresh,
};
