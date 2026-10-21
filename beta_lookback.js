(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BetaLookback = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  // Resolve lazily: browser script order may load this file before price_history.js / after fmp_cache.js.
  const Price = () => (typeof module === 'object' && module.exports ? require('./price_history.js') : root.PriceHistory);
  const Cache = () => (typeof module === 'object' && module.exports ? require('./fmp_cache.js') : root.FmpCache);
  const WINDOWS = [1, 2, 3, 4, 5];
  const PROVIDER = 'provider';
  const BENCHMARKS = {
    US: { ticker: 'SPY', labelZh: '標普 500（SPY ETF）', labelEn: 'S&P 500 (via SPY ETF)' },
    HK: { ticker: '2800.HK', labelZh: '恒生指數（盈富基金 2800.HK）', labelEn: 'Hang Seng Index (via TraHK 2800.HK)' }
  };
  const memory = new Map();
  const seriesMemory = new Map();
  const preferences = new Map();
  const lastResult = new Map();
  const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const tickerOk = ticker => /^[A-Z0-9]+(?:[.-][A-Z0-9]+)*$/.test(ticker || '');
  const marketOf = ticker => /\.HK$/i.test(ticker) ? 'HK' : 'US';
  const periodOf = years => `${years}y`;
  const cacheKey = (ticker, years, benchmark) => `beta:v1:${ticker}|${benchmark}|${years}y|ols-daily`;
  const minReturns = years => Math.max(60, Math.floor(years * 252 * 0.55));

  function validateSeries(record, ticker, { allowBootstrap = false } = {}) {
    const currency = /\.HK$/i.test(ticker) ? 'HKD' : 'USD';
    const fmp = record?.source === 'FMP historical-price-eod/full';
    const bootstrap = allowBootstrap && typeof record?.source === 'string'
      && record.source.startsWith('Yahoo Finance chart bootstrap');
    if (record?.version !== 1 || record.ticker !== ticker || record.currency !== currency
        || record.priceBasis !== 'splitAdjustedClose' || !(fmp || bootstrap)
        || !validDate(record.requestedFrom) || !validDate(record.requestedTo)
        || record.requestedFrom > record.requestedTo || !Array.isArray(record.rows)) {
      throw new TypeError('Unsupported beta price series');
    }
    let previous = '';
    for (const row of record.rows) {
      if (!Array.isArray(row) || row.length !== 3 || !validDate(row[0]) || row[0] <= previous
          || row[0] < record.requestedFrom || row[0] > record.requestedTo
          || typeof row[1] !== 'number' || !Number.isFinite(row[1]) || row[1] <= 0
          || row[2] !== null && (!Number.isSafeInteger(row[2]) || row[2] < 0)) {
        throw new TypeError('Invalid beta price row');
      }
      previous = row[0];
    }
    return record;
  }

  function alignedReturns(stockRows, benchRows, years) {
    if (!WINDOWS.includes(years)) throw new TypeError('Unsupported beta lookback');
    const range = Price().periodRange(stockRows, periodOf(years));
    if (!range) return { returns: [], start: null, end: null, reason: 'insufficientStockHistory' };
    const stock = Price().select(stockRows, range[0], range[1]);
    const bench = Price().select(benchRows, range[0], range[1]);
    const market = new Map(bench.map(row => [row[0], row[1]]));
    const paired = [];
    for (const row of stock) {
      if (market.has(row[0])) paired.push([row[0], row[1], market.get(row[0])]);
    }
    const returns = [];
    for (let i = 1; i < paired.length; i++) {
      const prev = paired[i - 1], cur = paired[i];
      const rs = cur[1] / prev[1] - 1, rm = cur[2] / prev[2] - 1;
      if (!finite(rs) || !finite(rm)) continue;
      returns.push([rs, rm]);
    }
    return {
      returns, start: paired[0]?.[0] || null, end: paired.at(-1)?.[0] || null,
      reason: returns.length < minReturns(years) ? 'insufficientOverlappingReturns' : null
    };
  }

  function olsBeta(stockRows, benchRows, years) {
    const aligned = alignedReturns(stockRows, benchRows, years);
    if (aligned.reason) {
      return {
        beta: null, n: aligned.returns.length, r2: null, lookbackYears: years,
        start: aligned.start, end: aligned.end, reason: aligned.reason, method: 'ols-daily'
      };
    }
    const n = aligned.returns.length;
    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0, sumYY = 0;
    for (const [y, x] of aligned.returns) {
      sumX += x; sumY += y; sumXX += x * x; sumXY += x * y; sumYY += y * y;
    }
    const varX = sumXX - sumX * sumX / n;
    if (!(varX > 0)) {
      return {
        beta: null, n, r2: null, lookbackYears: years, start: aligned.start, end: aligned.end,
        reason: 'zeroBenchmarkVariance', method: 'ols-daily'
      };
    }
    const beta = (sumXY - sumX * sumY / n) / varX;
    const alpha = sumY / n - beta * sumX / n;
    let ssRes = 0, ssTot = 0;
    const meanY = sumY / n;
    for (const [y, x] of aligned.returns) {
      const fitted = alpha + beta * x;
      ssRes += (y - fitted) ** 2;
      ssTot += (y - meanY) ** 2;
    }
    const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
    if (!finite(beta)) {
      return {
        beta: null, n, r2: null, lookbackYears: years, start: aligned.start, end: aligned.end,
        reason: 'nonFiniteBeta', method: 'ols-daily'
      };
    }
    return {
      beta, n, r2: finite(r2) ? r2 : null, lookbackYears: years,
      start: aligned.start, end: aligned.end, reason: null, method: 'ols-daily'
    };
  }

  function fromEodRows(ticker, rows, from, to, source = 'FMP historical-price-eod/full') {
    const currency = /\.HK$/i.test(ticker) ? 'HKD' : 'USD';
    const provider = ticker.endsWith('.HK') ? ticker : ticker.replaceAll('.', '-');
    const by = new Map();
    for (const row of rows) {
      const day = String(row?.date || '').slice(0, 10);
      const close = row?.close;
      const volume = row?.volume;
      if (!validDate(day) || day < from || day > to || !finite(close) || close <= 0) {
        throw new TypeError('Invalid EOD price for beta');
      }
      if (row.symbol != null && row.symbol !== ticker && row.symbol !== provider) {
        throw new TypeError('EOD symbol mismatch for beta');
      }
      const vol = volume == null ? null : Number(volume);
      if (vol !== null && (!Number.isSafeInteger(vol) || vol < 0)) throw new TypeError('Invalid EOD volume for beta');
      by.set(day, [day, close, vol]);
    }
    const ordered = [...by.keys()].sort().map(day => by.get(day));
    return validateSeries({
      version: 1, ticker, providerSymbol: provider, currency, source,
      priceBasis: 'splitAdjustedClose', volumeBasis: 'providerReported',
      requestedFrom: from, requestedTo: to, fetchedAt: new Date().toISOString(),
      columns: ['date', 'close', 'volume'], rows: ordered
    }, ticker);
  }

  async function fetchSeries(path) {
    const response = await root.fetch(path, { cache: 'default' });
    if (!response.ok) {
      const err = new Error(`BETA_SERIES_HTTP_${response.status}`);
      err.status = response.status;
      err.path = path;
      throw err;
    }
    return response.json();
  }

  async function loadSeries(ticker, { reload = false } = {}) {
    if (!tickerOk(ticker)) throw new TypeError('Invalid beta ticker');
    if (!reload && seriesMemory.has(ticker)) return seriesMemory.get(ticker);
    const priceApi = Price();
    if (!priceApi || typeof priceApi.validate !== 'function') {
      const err = new Error('PRICE_HISTORY_API_UNAVAILABLE');
      err.causeCode = 'priceHistoryApiUnavailable';
      throw err;
    }
    const promise = (async () => {
      const chartPath = `cache/price_charts/${encodeURIComponent(ticker)}.json`;
      let chartError = null;
      // Prefer published price_charts (same cache as Profile charts) — any US/HK listing.
      try {
        const chart = await fetchSeries(chartPath);
        return priceApi.validate(chart, ticker);
      } catch (error) {
        chartError = error;
      }
      // Benchmark bootstrap / committed beta benchmarks (Yahoo or FMP-shaped).
      try {
        const bench = await fetchSeries(`cache/beta_benchmarks/${encodeURIComponent(ticker)}.json`);
        return validateSeries(bench, ticker, { allowBootstrap: true });
      } catch (_) { /* fall through to FMP */ }
      // On-demand FMP only when static caches miss — minimize API use.
      try {
        const to = new Date().toISOString().slice(0, 10);
        const fromDate = new Date();
        fromDate.setUTCFullYear(fromDate.getUTCFullYear() - 20);
        const from = fromDate.toISOString().slice(0, 10);
        const query = new URLSearchParams({ action: 'historical-price', symbol: ticker, from, to });
        const result = await Cache().request(query, { refresh: reload });
        if (!Array.isArray(result?.data) || result.source?.symbol !== ticker) {
          throw new Error('FMP_INVALID_HISTORICAL_PRICE');
        }
        return fromEodRows(ticker, result.data, from, to);
      } catch (fmpError) {
        const status = chartError?.status;
        const code = status === 404 ? 'priceChartMissing'
          : status ? `priceChartHttp${status}`
            : /Unsupported|Invalid/.test(String(chartError?.message || '')) ? 'priceChartInvalid'
              : /PRICE_HISTORY_API/.test(String(chartError?.message || '')) ? 'priceHistoryApiUnavailable'
                : 'stockPricesUnavailable';
        const err = new Error(String(fmpError.message || fmpError));
        err.causeCode = code;
        err.chartPath = chartPath;
        err.chartDetail = String(chartError?.message || chartError || '');
        err.fmpDetail = String(fmpError.message || fmpError);
        throw err;
      }
    })();
    seriesMemory.set(ticker, promise);
    while (seriesMemory.size > 12) seriesMemory.delete(seriesMemory.keys().next().value);
    promise.catch(() => { if (seriesMemory.get(ticker) === promise) seriesMemory.delete(ticker); });
    return promise;
  }

  function providerBeta(ticker) {
    const source = root.MarketContext?.fcff?.()?.betaSources?.[ticker]
      || (typeof MarketContext !== 'undefined' ? MarketContext.fcff()?.betaSources?.[ticker] : null);
    const value = finite(source?.value) ? source.value : null;
    return {
      mode: PROVIDER, beta: value, n: null, r2: null, lookbackYears: null,
      start: null, end: null, reason: value === null ? 'providerBetaUnavailable' : null,
      method: 'fmp-profile', benchmark: null, benchmarkLabel: null,
      cache: { hit: true, key: `beta:v1:${ticker}|provider` },
      source: source?.source || 'FMP profile beta'
    };
  }

  async function resolve(ticker, selection = PROVIDER, { reload = false } = {}) {
    if (!tickerOk(ticker)) throw new TypeError('Invalid beta ticker');
    const finish = result => { lastResult.set(ticker, result); return result; };
    if (selection === PROVIDER) return finish(providerBeta(ticker));
    const years = Number(selection);
    if (!WINDOWS.includes(years)) throw new TypeError('Unsupported beta lookback');
    const market = marketOf(ticker);
    const bench = BENCHMARKS[market];
    const key = cacheKey(ticker, years, bench.ticker);
    if (!reload && memory.has(key)) return finish({ ...memory.get(key), cache: { hit: true, key } });
    try {
      const persisted = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      if (!reload && persisted) {
        const parsed = JSON.parse(persisted);
        if (parsed?.version === 1 && parsed.ticker === ticker && parsed.lookbackYears === years
            && parsed.benchmark === bench.ticker && (finite(parsed.beta) || parsed.reason)) {
          memory.set(key, parsed);
          return finish({ ...parsed, cache: { hit: true, key, persisted: true } });
        }
      }
    } catch (_) { /* ignore corrupt local cache */ }

    let stock, benchmark;
    try { stock = await loadSeries(ticker, { reload }); }
    catch (error) {
      return finish({
        version: 1, ticker, mode: years, beta: null, n: 0, r2: null, lookbackYears: years,
        start: null, end: null,
        reason: error.causeCode || 'stockPricesUnavailable', method: 'ols-daily',
        benchmark: bench.ticker, benchmarkLabel: bench, cache: { hit: false, key },
        detail: String(error.message || error),
        chartPath: error.chartPath || null,
        chartDetail: error.chartDetail || null,
        fmpDetail: error.fmpDetail || null
      });
    }
    try { benchmark = await loadSeries(bench.ticker, { reload }); }
    catch (error) {
      return finish({
        version: 1, ticker, mode: years, beta: null, n: 0, r2: null, lookbackYears: years,
        start: null, end: null, reason: 'benchmarkPricesUnavailable', method: 'ols-daily',
        benchmark: bench.ticker, benchmarkLabel: bench, cache: { hit: false, key },
        detail: String(error.message || error)
      });
    }
    if (stock.currency !== benchmark.currency) {
      return finish({
        version: 1, ticker, mode: years, beta: null, n: 0, r2: null, lookbackYears: years,
        start: null, end: null, reason: 'currencyMismatch', method: 'ols-daily',
        benchmark: bench.ticker, benchmarkLabel: bench, cache: { hit: false, key }
      });
    }
    const computed = olsBeta(stock.rows, benchmark.rows, years);
    const entry = {
      version: 1, ticker, mode: years, ...computed,
      benchmark: bench.ticker, benchmarkLabel: bench,
      computedAt: new Date().toISOString(),
      stockCoverage: { from: stock.requestedFrom, to: stock.requestedTo, source: stock.source },
      benchmarkCoverage: { from: benchmark.requestedFrom, to: benchmark.requestedTo, source: benchmark.source }
    };
    memory.set(key, entry);
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(entry));
    } catch (_) { /* quota */ }
    return finish({ ...entry, cache: { hit: false, key } });
  }

  function reasonText(reason, language = 'zh') {
    const en = language === 'en';
    const messages = {
      providerBetaUnavailable: ['供應商未提供 Beta', 'Provider beta unavailable'],
      insufficientStockHistory: ['個股價格歷史不足以覆蓋所選年期', 'Stock price history does not cover the selected window'],
      insufficientOverlappingReturns: ['與基準重疊交易日不足，不估計 Beta', 'Too few overlapping sessions with the benchmark; beta not estimated'],
      zeroBenchmarkVariance: ['基準報酬變異為零，無法估計 Beta', 'Benchmark return variance is zero; beta not estimated'],
      nonFiniteBeta: ['OLS 結果非有限值', 'OLS result was non-finite'],
      stockPricesUnavailable: ['無法載入個股歷史價格', 'Stock historical prices unavailable'],
      priceChartMissing: ['本站尚未發布該股票的日線快取（cache/price_charts），且即時 FMP 亦無法取得', 'Published daily price cache missing for this ticker, and live FMP fetch also failed'],
      priceChartInvalid: ['個股日線快取格式無效，無法估計 Beta', 'Stock daily price cache is invalid; beta not estimated'],
      priceHistoryApiUnavailable: ['PriceHistory API 尚未載入，無法讀取日線', 'PriceHistory API is not loaded; cannot read daily prices'],
      benchmarkPricesUnavailable: ['無法載入基準歷史價格', 'Benchmark historical prices unavailable'],
      currencyMismatch: ['個股與基準幣別不一致，不估計 Beta', 'Stock and benchmark currencies differ; beta not estimated']
    };
    if (messages[reason]) return messages[reason][en ? 1 : 0];
    if (/^priceChartHttp\d+$/.test(reason || '')) {
      return en
        ? `Stock price cache HTTP ${reason.slice('priceChartHttp'.length)}; live FMP fetch also failed`
        : `個股日線快取 HTTP ${reason.slice('priceChartHttp'.length)}，且即時 FMP 亦失敗`;
    }
    return reason || '';
  }

  function statusText(result, language = 'zh') {
    const en = language === 'en';
    const bench = result.benchmarkLabel;
    const benchName = bench ? (en ? bench.labelEn : bench.labelZh) : '';
    if (result.mode === PROVIDER || result.method === 'fmp-profile') {
      return en
        ? 'Default: FMP profile beta (provider / window unspecified). OLS windows use cached prices vs the market benchmark only when selected.'
        : '預設：FMP 公司檔 Beta（供應商／年期未明）。選擇年期後才以快取價格對基準做 OLS。';
    }
    if (result.reason) {
      const detail = result.chartPath
        ? (en ? ` Path: ${result.chartPath}.` : ` 路徑：${result.chartPath}。`)
        : '';
      return en
        ? `N/A — ${reasonText(result.reason, 'en')}.${detail} Benchmark: ${benchName}.`
        : `N/A — ${reasonText(result.reason, 'zh')}。${detail}基準：${benchName}。`;
    }
    const cacheNote = result.cache?.hit
      ? (en ? 'Cached beta; no recompute.' : '已用快取 Beta；未重算。')
      : (en ? 'Computed from cached daily prices.' : '由快取日線價格計算。');
    return en
      ? `OLS β=${result.beta.toFixed(4)} over ${result.lookbackYears}y vs ${benchName} (${result.n} daily returns${result.r2 != null ? `, R²=${result.r2.toFixed(3)}` : ''}). ${cacheNote}`
      : `OLS β=${result.beta.toFixed(4)}（${result.lookbackYears} 年，相對 ${benchName}；${result.n} 個日報酬${result.r2 != null ? `，R²=${result.r2.toFixed(3)}` : ''}）。${cacheNote}`;
  }

  function getPreference(ticker) {
    return preferences.get(ticker) || PROVIDER;
  }
  function setPreference(ticker, selection) {
    if (selection !== PROVIDER && !WINDOWS.includes(Number(selection))) throw new TypeError('Unsupported beta lookback');
    preferences.set(ticker, selection === PROVIDER ? PROVIDER : Number(selection));
  }

  function bankKeFromBeta(stock, beta) {
    if (!finite(beta)) return null;
    const rfPct = finite(stock?.rf) ? stock.rf
      : finite(stock?.rateSource?.year10) ? stock.rateSource.year10 : 4.3;
    const erpPct = finite(stock?.erp) ? stock.erp : 4.75;
    let ke = rfPct + beta * erpPct;
    // US build floors financial Ke at 9%; preserve that convention when applying OLS beta.
    if (!/\.HK$/i.test(stock?.ticker || '') && stock?.fin_valuation?.is_financial) ke = Math.max(ke, 9);
    return ke;
  }

  return {
    WINDOWS, PROVIDER, BENCHMARKS, validateSeries, alignedReturns, olsBeta, fromEodRows,
    loadSeries, resolve, providerBeta, reasonText, statusText, getPreference, setPreference,
    bankKeFromBeta, cacheKey, minReturns, memory, seriesMemory, lastResult
  };
});
