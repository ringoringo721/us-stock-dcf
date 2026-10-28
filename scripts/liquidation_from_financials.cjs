/**
 * Build isolated liquidation source records from cached FMP quarterly statements
 * plus the stock's USD listing quote / verified outstanding shares.
 *
 * Used to backfill US expansion tickers that were never covered by
 * refresh_liquidation.py (which historically iterated only full_market_dcf.json).
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const FIELDS = ['totalCurrentAssets', 'totalLiabilities', 'cashAndShortTermInvestments',
  'accountsReceivables', 'netReceivables', 'otherReceivables', 'inventory', 'preferredStock'];

const finite = value => typeof value === 'number' && Number.isFinite(value);

function latestQuarterBalance(statements) {
  const rows = statements?.quarterly?.balance;
  if (!Array.isArray(rows)) return null;
  const quarters = rows.filter(row => row && ['Q1', 'Q2', 'Q3', 'Q4'].includes(row.period)
    && typeof row.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  if (!quarters.length) return null;
  quarters.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return quarters[0];
}

function quoteDateFor(stock) {
  const candidates = [stock?.shareSource?.date, stock?.shareSource?.capturedAt?.slice(0, 10)]
    .filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value));
  return candidates.sort().at(-1) || null;
}

/** @returns {{ record: object } | { reason: string, detail?: object }} */
function buildSourceRecord(ticker, stock, statements, capturedAt) {
  if (!stock || !statements) return { reason: 'missingInputs' };
  const balance = latestQuarterBalance(statements);
  if (!balance) return { reason: 'noQuarter' };
  if (typeof balance.reportedCurrency !== 'string' || !/^[A-Z]{3}$/.test(balance.reportedCurrency)) {
    return { reason: 'missingCurrency' };
  }
  const price = stock.price;
  const mcapMillions = stock.mcap;
  if (!finite(price) || price <= 0 || !finite(mcapMillions) || mcapMillions <= 0) {
    return { reason: 'invalidQuote' };
  }
  const date = quoteDateFor(stock);
  if (!date) return { reason: 'missingQuoteDate' };
  const fetchedAt = capturedAt || stock.shareSource?.capturedAt || `${date}T23:59:59Z`;
  const fetchedDay = String(fetchedAt).slice(0, 10);
  if (balance.date > fetchedDay || date > fetchedDay) return { reason: 'futureDates' };
  return {
    record: {
      ticker,
      providerSymbol: ticker.replace(/\./g, '-'),
      fetchedAt,
      balance: {
        date: balance.date,
        period: balance.period,
        reportedCurrency: balance.reportedCurrency,
        filingDate: balance.filingDate ? String(balance.filingDate).slice(0, 10) : null,
        acceptedDate: balance.acceptedDate ? String(balance.acceptedDate).slice(0, 10) : null,
        ...Object.fromEntries(FIELDS.map(field => [field, finite(balance[field]) ? balance[field] : null]))
      },
      quote: {
        currency: 'USD',
        date,
        price,
        marketCap: mcapMillions * 1e6
      }
    }
  };
}

function loadStatements(root, ticker) {
  const file = path.join(root, 'cache', 'financials', `${ticker}_statements_v2.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { FIELDS, latestQuarterBalance, quoteDateFor, buildSourceRecord, loadStatements };
