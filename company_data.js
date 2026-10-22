(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CompanyData = api;
})(typeof globalThis === 'object' ? globalThis : this, function (root) {
  'use strict';
  let requestId = 0;
  const cache = new Map();
  const loaded = new Map();
  let translationCache = null;
  // Matched issuer names and official websites in both FMP profiles; ADRs are not the HK security.
  const relatedListings = {
    '0823.HK': 'LKREF', '0388.HK': 'HKXCY', '0700.HK': 'TCEHY',
    '9988.HK': 'BABA', '0005.HK': 'HSBC', '0939.HK': 'CICHY'
  };
  const newsListings = symbol => relatedListings[symbol] ? [symbol, relatedListings[symbol]] : [symbol];
  const safeUrl = value => {
    try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null; }
    catch (error) { if (error instanceof TypeError) return null; throw error; }
  };
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

  function splits(rows) {
    return (rows || []).filter(row => day(row.date)).map(row => {
      if (row.ratio && row.desc && row.type) return row;
      const valid = typeof row.numerator === 'number' && typeof row.denominator === 'number'
        && Number.isFinite(row.numerator) && Number.isFinite(row.denominator) && row.numerator > 0 && row.denominator > 0;
      return { date: row.date, ratio: valid ? `${row.numerator}:${row.denominator}` : 'N/A',
        desc: '\u4f9b\u61c9\u5546\u5831\u544a\u7684\u80a1\u6578\u8abf\u6574\u6bd4\u7387\uff1b\u672a\u7368\u7acb\u6838\u5be6\u70ba\u62c6\u80a1\u6216\u4f9b\u80a1\u3002',
        type: 'FMP \u80a1\u6578\u8abf\u6574', source: 'FMP splits', verifiedEventType: false };
    }).sort((a, b) => b.date.localeCompare(a.date));
  }

  function newsRows(rows, symbol) {
    const seen = new Set();
    return (rows || []).filter(row => {
      if (row?.symbol !== symbol || typeof row.title !== 'string' || !row.title.trim() || !safeUrl(row.url)
          || !day(row.publishedDate?.slice(0, 10))) return false;
      const key = safeUrl(row.url);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  }

  function metadata(data, stock) {
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const holders = (data?.holders?.data || []).filter(row => row.symbol === stock.ticker
      && row.putCallShare === 'Share' && finite(row.sharesNumber) && row.sharesNumber >= 0);
    const insiders = (data?.insiders?.data || []).filter(row => row.symbol === stock.ticker
      && day(row.transactionDate) && finite(row.securitiesTransacted));
    const summary = data?.ownership?.data?.[0];
    return {
      inst_ownership_pct: summary?.symbol === stock.ticker && finite(summary.ownershipPercent) ? summary.ownershipPercent : null,
      insider_ownership_pct: null,
      top_holders: holders.map((row, index) => ({
        rank: index + 1, name: row.investorName, shares: row.sharesNumber,
        val_m: finite(stock.price) ? row.sharesNumber * stock.price / 1e6 : null,
        pct: finite(row.ownership) ? row.ownership : null, date: row.date,
        change: finite(row.changeInSharesNumberPercentage) ? `${row.changeInSharesNumberPercentage >= 0 ? '+' : ''}${row.changeInSharesNumberPercentage.toFixed(2)}%` : 'N/A'
      })),
      insider_trades: insiders.map(row => ({
        date: row.transactionDate, name: row.reportingName, title: row.typeOfOwner,
        is_buy: /^P(?:-|$)/.test(row.transactionType) ? true : /^S(?:-|$)/.test(row.transactionType) ? false : null,
        action: row.transactionType, shares: Math.abs(row.securitiesTransacted),
        price: finite(row.price) ? row.price : null,
        total_val: finite(row.price) ? Math.abs(row.securitiesTransacted) * row.price / 1e6 : null
      })),
      ownershipDate: summary?.date || null,
      metadataCapturedAt: data?.capturedAt || null,
      metadataSourceReason: data?.ownership?.reason || data?.holders?.reason || null,
      news: newsRows([...(data?.news?.data || []), ...(stock.news || [])], stock.ticker)
    };
  }

  const Scenario = () => (typeof module === 'object' && module.exports
    ? require('./fmp_scenario.js') : root.FmpScenario);
  const Cache = () => (typeof module === 'object' && module.exports
    ? require('./fmp_cache.js') : root.FmpCache);
  const Industry = () => (typeof module === 'object' && module.exports
    ? require('./financial_industry.js') : root.FinancialIndustry);
  const StatementsPack = () => (typeof module === 'object' && module.exports
    ? require('./statements_model_pack.js') : root.StatementsModelPack);

  function expansionEligible(ticker) {
    if (/\.HK$/i.test(ticker) || root.FULL_MARKET_DATA?.[ticker]) return false;
    return !!(root.US_EXPANSION?.stocks?.[ticker]
      || root.US_LISTINGS?.stocks?.some(item => item.ticker === ticker));
  }

  function expansionStock(ticker) {
    return root.US_EXPANSION?.stocks?.[ticker]
      || root.US_LISTINGS?.stocks?.find(item => item.ticker === ticker)
      || null;
  }

  function isFinancialExpansion(ticker) {
    const stock = expansionStock(ticker);
    if (stock?.fin_valuation?.is_financial === true) return true;
    return !!Industry()?.usesFinancialValuationModel(stock?.industry, ticker);
  }

  function calculationCurrency(ticker) {
    return root.US_EXPANSION?.stocks?.[ticker]?.calculationCurrency
      || root.FULL_MARKET_DATA?.[ticker]?.calculationCurrency
      || 'USD';
  }

  function currencyEvidence(symbol, currency, models, statements) {
    const rows = models.advanced?.data || [];
    const full = Scenario().fullAnnualPeriod;
    const matchesYear = row => row.revenue > 0 && full(row)
      && rows.some(model => Number(model.year) === Number(row.fiscalYear || row.calendarYear));
    const actual = (statements?.annual?.income || []).slice()
      .sort((a, b) => b.date.localeCompare(a.date)).find(matchesYear);
    if (!actual) return { reason: 'FMP_MODEL_CURRENCY_UNVERIFIED' };
    const original = actual.reportedCurrency;
    const model = rows.find(row => Number(row.year) === Number(actual.fiscalYear || actual.calendarYear));
    if (!model || !(model.revenue > 0)) return { reason: 'FMP_MODEL_CURRENCY_UNVERIFIED' };
    // Live hydrate only certifies same-currency matches; cross-currency needs captured FX evidence.
    if (original !== currency) {
      return { reason: 'FMP_MODEL_CURRENCY_UNVERIFIED', sourceCurrency: original, currency,
        sourceDate: actual.date, financialSource: 'storedAnnualFinancials',
        originalRevenue: actual.revenue, modelRevenue: model.revenue };
    }
    const ratio = model.revenue / actual.revenue;
    return {
      reason: Math.abs(ratio - 1) < 0.005 ? null : 'FMP_MODEL_CURRENCY_UNVERIFIED',
      sourceCurrency: original, currency, sourceDate: actual.date,
      sourcePeriodLength: actual.periodLength, financialSource: 'storedAnnualFinancials',
      originalRevenue: actual.revenue, modelRevenue: model.revenue, impliedRate: ratio,
      fx: { price: 1, symbol: `${original}${currency}` },
      basis: 'matchingHistoricalRevenue'
    };
  }

  async function fetchModel(action, symbol) {
    const result = await Cache().request(new URLSearchParams({ action, symbol }));
    if (!Array.isArray(result.data) || result.source?.symbol !== symbol) {
      throw new Error('FMP_INVALID_RESPONSE');
    }
    return {
      data: result.data, reason: result.data.length ? null : 'FMP_NO_COVERAGE',
      endpoint: result.source?.endpoint || action, capturedAt: result.source?.capturedAt || null
    };
  }

  function publishModelSummary(ticker, data) {
    if (!root.FMP_MODEL_DATA?.stocks) return;
    const { news, ownership, holders, insiders, analystEstimates, forecastActuals, ...summary } = data;
    summary.models = Object.fromEntries(Object.entries(data.models).map(([name, model]) => [name, {
      ...model,
      data: model.data.length ? [model.data.slice().sort((a, b) => Number(b.year || 0) - Number(a.year || 0))[0]] : []
    }]));
    root.FMP_MODEL_DATA.stocks[ticker] = summary;
  }

  function financialStubPack(ticker, currency, capturedAt) {
    return {
      symbol: ticker, currency, capturedAt,
      models: {
        dcf: { data: [], reason: 'FINANCIAL_INSTITUTION', endpoint: null, capturedAt },
        levered: { data: [], reason: 'FINANCIAL_INSTITUTION', endpoint: null, capturedAt }
      },
      currencyCheck: {
        reason: null, currency,
        basis: 'financialInstitutionUsesExcessReturnModel'
      },
      hydratedFrom: 'financial-institution-stub',
      news: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      ownership: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      holders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      insiders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' }
    };
  }

  async function attachAnalystEstimates(data, ticker, statements, currency, capturedAt) {
    try {
      const estimates = await Cache().request(new URLSearchParams({
        action: 'analyst-estimates', symbol: ticker, period: 'annual', limit: '12'
      }));
      if (typeof module === 'object' && module.exports) {
        const { buildAnalystSources } = require('./scripts/analyst_sources.cjs');
        Object.assign(data, buildAnalystSources(data, statements, estimates, capturedAt));
      } else if (Array.isArray(estimates?.data) && estimates.source?.symbol === ticker) {
        // Browser: same-currency consensus only when a matching fiscal row scales within 25%.
        const latest = (statements.annual?.income || []).filter(row => Scenario().fullAnnualPeriod(row)
          && row.reportedCurrency === currency).sort((a, b) => b.date.localeCompare(a.date))[0];
        const matched = latest?.revenue > 0 ? estimates.data.filter(row => row?.symbol === ticker
          && day(row.date) && Math.abs(Date.parse(row.date) - Date.parse(latest.date)) <= 10 * 86400000) : [];
        const scale = matched.length === 1 && typeof matched[0].revenueAvg === 'number'
          && Number.isFinite(matched[0].revenueAvg) ? matched[0].revenueAvg / latest.revenue : null;
        if (latest?.revenue > 0 && scale != null && scale >= 0.75 && scale <= 1.25) {
          const cutoff = data.forecastBase?.date || latest.date;
          data.analystEstimates = {
            provider: 'FMP', endpoint: 'analyst-estimates', period: 'annual', symbol: ticker,
            capturedAt, currency, calculationCurrency: currency,
            rows: estimates.data.filter(row => row?.symbol === ticker && day(row.date)
              && (!cutoff || row.date > cutoff)).map(row => ({
              date: row.date,
              revenueAvg: row.revenueAvg, ebitdaAvg: row.ebitdaAvg, ebitAvg: row.ebitAvg,
              netIncomeAvg: row.netIncomeAvg, epsAvg: row.epsAvg,
              operatingCashFlowAvg: row.operatingCashFlowAvg,
              capitalExpenditureAvg: row.capitalExpenditureAvg,
              depreciationAndAmortizationAvg: row.depreciationAndAmortizationAvg,
              numAnalystsRevenue: row.numAnalystsRevenue, numAnalystsEps: row.numAnalystsEps
            })).sort((a, b) => a.date.localeCompare(b.date)),
            reason: null, fx: { rate: 1, basis: 'Same reporting and calculation currency' }
          };
          if (!data.analystEstimates.rows.length) {
            data.analystEstimates.reason = 'ANALYST_NO_FUTURE_COVERAGE';
          }
        }
      }
    } catch (error) {
      console.error('Live analyst estimates unavailable', ticker, error.message);
    }
  }

  async function hydrateUsExpansion(ticker) {
    if (!expansionEligible(ticker)) throw new Error('COMPANY_DATA_HTTP_404');
    const statementsResponse = await root.fetch(
      `cache/financials/${encodeURIComponent(ticker)}_statements_v2.json`);
    if (!statementsResponse.ok) {
      throw new Error(`COMPANY_STATEMENTS_HTTP_${statementsResponse.status}`);
    }
    const statements = await statementsResponse.json();
    const currency = calculationCurrency(ticker);
    const capturedAt = new Date().toISOString();
    const stock = root.US_EXPANSION?.stocks?.[ticker] || expansionStock(ticker);
    const financial = isFinancialExpansion(ticker);
    if (financial) {
      const data = financialStubPack(ticker, currency, capturedAt);
      publishModelSummary(ticker, data);
      return data;
    }
    const names = {
      dcf: 'dcf', levered: 'levered-dcf', advanced: 'custom-dcf', customLevered: 'custom-levered-dcf'
    };
    let models = {};
    let usedProxy = false;
    try {
      if (!root.FmpCache && !(typeof module === 'object' && module.exports)) {
        throw new Error('FMP_NOT_CONFIGURED');
      }
      for (const [name, action] of Object.entries(names)) {
        models[name] = await fetchModel(action, ticker);
      }
      usedProxy = true;
    } catch (error) {
      console.error('FMP proxy hydrate unavailable; using statements pack', ticker, error.message);
      const pack = StatementsPack().build(ticker, statements, stock || { ticker }, currency, capturedAt);
      publishModelSummary(ticker, pack);
      return pack;
    }
    const currencyCheck = models.advanced?.data?.length
      ? currencyEvidence(ticker, currency, models, statements)
      : { reason: 'FMP_MODEL_CURRENCY_UNVERIFIED' };
    const data = {
      symbol: ticker, currency, capturedAt, models, currencyCheck,
      hydratedFrom: usedProxy ? 'fmp-proxy+statements_v2' : 'statements_v2-offline',
      news: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      ownership: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      holders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' },
      insiders: { data: [], reason: 'FMP_COMPANY_CACHE_MISSING' }
    };
    if (models.advanced?.data?.length) {
      data.forecastBase = Scenario().baseSource(data, statements);
      if (data.forecastBase?.reason) {
        const recovered = Scenario().resolveForecastBase(data);
        if (Number.isInteger(recovered?.year) && !recovered.reason) data.forecastBase = recovered;
      }
      await attachAnalystEstimates(data, ticker, statements, currency, capturedAt);
    } else {
      // Proxy returned empty advanced rows — still enable ten-year defaults from statements.
      const pack = StatementsPack().build(ticker, statements, stock || { ticker }, currency, capturedAt);
      publishModelSummary(ticker, pack);
      return pack;
    }
    publishModelSummary(ticker, data);
    return data;
  }

  function load(ticker) {
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) return Promise.reject(new Error('INVALID_COMPANY_SYMBOL'));
    if (!cache.has(ticker)) cache.set(ticker, (async () => {
      const response = await root.fetch(`cache/company/${encodeURIComponent(ticker)}.json`);
      if (response.ok) {
        const data = await response.json();
        if (data.symbol !== ticker) throw new Error('COMPANY_DATA_SECURITY_MISMATCH');
        loaded.set(ticker, data);
        return data;
      }
      if (response.status === 404 && expansionEligible(ticker)) {
        const data = await hydrateUsExpansion(ticker);
        if (data.symbol !== ticker) throw new Error('COMPANY_DATA_SECURITY_MISMATCH');
        loaded.set(ticker, data);
        return data;
      }
      throw new Error(`COMPANY_DATA_HTTP_${response.status}`);
    })().catch(error => { cache.delete(ticker); throw error; }));
    return cache.get(ticker);
  }

  function loadTranslations() {
    if (!translationCache) translationCache = (async () => {
      const response = await root.fetch('cache/news_translations.json');
      if (!response.ok) throw new Error(`NEWS_TRANSLATION_HTTP_${response.status}`);
      const data = await response.json();
      if (data.version !== 1 || data.language !== 'zh-Hant' || data.provider !== 'Vertex AI'
          || !data.titles || typeof data.titles !== 'object' || Array.isArray(data.titles)) {
        throw new Error('NEWS_TRANSLATION_INVALID_CACHE');
      }
      return data.titles;
    })().catch(error => { translationCache = null; throw error; });
    return translationCache;
  }

  const selectedNewsListings = new Map();
  async function renderNews(container, symbol, storedRows, language, feedSymbol = selectedNewsListings.get(symbol) || symbol) {
    if (!container) return;
    const listings = newsListings(symbol);
    if (!listings.includes(feedSymbol)) throw new Error('UNVERIFIED_NEWS_LISTING');
    const id = ++requestId, en = language === 'en';
    let rows = newsRows(storedRows, feedSymbol), page = 0, hasMore = true, translations = null, translationError = null;
    let sourceText = rows.length ? (en ? 'Previously captured FMP news; checking saved responses.' : '已擷取的 FMP 新聞；正在讀取已存快照。') : '';
    const status = root.document.createElement('p'), articles = root.document.createElement('div');
    const languageNote = root.document.createElement('p');
    languageNote.className = 'analysis-note';
    const more = root.document.createElement('button');
    more.type = 'button';
    more.className = 'action-btn';
    more.dataset.newsMore = '';
    const refresh = root.document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'action-btn';
    refresh.textContent = en ? 'Refresh FMP news' : '重新查詢 FMP 新聞';
    const listingNote = root.document.createElement('p');
    listingNote.className = 'analysis-note';
    listingNote.dataset.newsListing = feedSymbol;
    listingNote.textContent = feedSymbol !== symbol
      ? (en ? `Same issuer, different listing: ${feedSymbol}. Articles keep FMP's original symbol; these are not a dedicated ${symbol} news feed. Provider tags may include affiliates or broader market articles.`
        : `同一發行人、不同上市代號：${feedSymbol}。保留 FMP 原始新聞代號；並非 ${symbol} 專屬新聞。供應商標籤亦可能涵蓋關聯企業或綜合市場文章。`)
      : listings.length > 1 ? (en ? `News tagged by FMP as ${symbol}. If coverage is empty, select the verified same-issuer US/OTC listing separately; it is never substituted silently.`
        : `FMP 標記為 ${symbol} 的新聞。如回傳空白，可另外選取已核對發行人的美國／場外上市代號；不會自動混入或改標為港股新聞。`) : '';
    const listingControl = root.document.createElement('label');
    if (listings.length > 1) {
      listingControl.textContent = en ? 'FMP news listing: ' : 'FMP 新聞上市代號：';
      const select = root.document.createElement('select');
      select.dataset.newsListingSelect = symbol;
      for (const listing of listings) {
        const option = root.document.createElement('option');
        option.value = listing;
        option.textContent = listing === symbol ? `${symbol} (HKEX)`
          : `${listing} (${en ? 'same issuer · US / OTC' : '同一發行人 · 美國／場外'})`;
        select.append(option);
      }
      select.value = feedSymbol;
      select.addEventListener('change', () => {
        selectedNewsListings.set(symbol, select.value);
        renderNews(container, symbol, storedRows, language, select.value)
          .catch(error => { console.error('News listing could not change', symbol, error.message); status.textContent = error.message; });
      });
      listingControl.append(select);
    }
    container.replaceChildren(listingControl, listingNote, languageNote, status, articles, more, refresh);
    function draw() {
      languageNote.dataset.newsLanguage = en ? 'original' : translations ? 'ai-zh-Hant' : 'original';
      languageNote.textContent = en
        ? 'Original provider headlines. Article links open the original publication.'
        : translationError ? `\u7e41\u4e2d\u7ffb\u8b6f\u5feb\u53d6\u7121\u6cd5\u8b80\u53d6 (${translationError})\uff1b\u4ee5\u4e0b\u4fdd\u7559\u539f\u6587\u6a19\u984c\uff0c\u4e26\u975e\u5df2\u7ffb\u8b6f\u5167\u5bb9\u3002`
          : translations ? '\u5df2\u5b58\u7684 AI \u7e41\u4e2d\u6a19\u984c\u7ffb\u8b6f\uff08Vertex AI\uff09\uff1b\u4fdd\u7559\u539f\u6a19\u984c\u53ca\u539f\u6587\u9023\u7d50\u3002\u672a\u7ffb\u8b6f\u7684\u65b0\u6a19\u984c\u4ecd\u986f\u793a\u539f\u6587\uff1b\u4e0d\u7ffb\u8b6f\u6587\u7ae0\u5168\u6587\u3002AI \u53ef\u80fd\u6709\u8aa4\uff0c\u4ee5\u539f\u6587\u70ba\u6e96\u3002\u91cd\u958b\u9801\u9762\u4e0d\u6703\u91cd\u8907\u547c\u53eb Vertex\u3002'
            : '\u6b63\u5728\u8f09\u5165\u5df2\u5132\u5b58\u7684\u7e41\u4e2d\u6a19\u984c\u7ffb\u8b6f\uff1b\u6682\u986f\u793a\u539f\u6587\u3002';
      articles.replaceChildren();
      for (const item of rows) {
        const article = root.document.createElement('article');
        article.className = 'analysis-note';
        const title = root.document.createElement('a');
        const translated = !en && translations && Object.hasOwn(translations, item.title) ? translations[item.title] : null;
        const titleZh = translated?.model === 'gemini-2.5-flash-lite' && typeof translated.text === 'string'
          && /[\u3400-\u9fff]/.test(translated.text) ? translated.text : null;
        title.textContent = titleZh || item.title;
        title.href = safeUrl(item.url);
        title.target = '_blank';
        title.rel = 'noopener noreferrer';
        const source = root.document.createElement('p');
        source.textContent = [item.publisher || item.site, item.publishedDate, feedSymbol, 'FMP',
          !en ? titleZh ? 'AI \u7e41\u4e2d\u6a19\u984c\u7ffb\u8b6f \u00b7 Vertex AI' : '\u539f\u6587\u6a19\u984c\uff08\u5c1a\u7121\u7ffb\u8b6f\uff09' : ''].filter(Boolean).join(' \u00b7 ');
        article.append(title, source);
        if (titleZh) {
          const original = root.document.createElement('details'), label = root.document.createElement('summary');
          const originalTitle = root.document.createElement('p');
          label.textContent = '\u539f\u6587\u6a19\u984c';
          originalTitle.textContent = item.title;
          original.append(label, originalTitle);
          article.append(original);
        }
        articles.append(article);
      }
      status.textContent = sourceText;
      more.hidden = !hasMore;
      more.textContent = en ? 'Load more FMP company news' : '\u8f09\u5165\u66f4\u591a FMP \u516c\u53f8\u65b0\u805e';
    }
    async function load(force = false) {
      more.disabled = true;
      refresh.disabled = true;
      status.textContent = en ? 'Loading FMP company news\u2026' : '\u6b63\u5728\u8f09\u5165 FMP \u516c\u53f8\u65b0\u805e\u2026';
      try {
        const saved = loaded.get(feedSymbol);
        const snapshot = page === 0 && Array.isArray(saved?.news?.data)
          && [null, undefined, 'FMP_NO_COVERAGE'].includes(saved.news.reason)
          ? { data: newsRows(saved.news.data, feedSymbol), page: 0, hasMore: saved.news.data.length >= 50,
            source: { symbol: feedSymbol, provider: 'FMP', capturedAt: saved.news.capturedAt || saved.capturedAt || null } }
          : null;
        const result = await root.FmpCache.request(new URLSearchParams({ action: 'news', symbol: feedSymbol, page }),
          { refresh: force, snapshot });
        if (!Array.isArray(result.data) || result.source?.symbol !== feedSymbol || result.page !== page
            || result.data.some(row => row?.symbol !== feedSymbol)) {
          throw new Error('FMP_INVALID_RESPONSE');
        }
        if (id !== requestId) return;
        const retainedArchive = page === 0 && result.data.length === 0 && rows.length > 0;
        rows = newsRows(page === 0 && !retainedArchive ? result.data : [...rows, ...result.data], feedSymbol);
        hasMore = result.hasMore === true;
        page++;
        sourceText = rows.length ? (en
          ? `Source: FMP company news \u00b7 ${rows.length} articles loaded. Provider coverage is not a complete news archive.`
          : `\u4f86\u6e90\uff1aFMP \u516c\u53f8\u65b0\u805e \u00b7 \u5df2\u8f09\u5165 ${rows.length} \u5247\u3002\u4f9b\u61c9\u5546\u6536\u9304\u7bc4\u570d\u4e0d\u7b49\u65bc\u5b8c\u6574\u65b0\u805e\u6b77\u53f2\u3002`)
          : (en ? 'FMP returned no company news for this security.' : 'FMP \u672a\u56de\u50b3\u6b64\u8b49\u5238\u7684\u516c\u53f8\u65b0\u805e\u3002');
        if (retainedArchive) sourceText = en
          ? 'FMP returned no articles in this live response. Showing previously captured articles, not a refreshed feed.'
          : '\u672c\u6b21 FMP \u5373\u6642\u56de\u61c9\u70ba\u7a7a\uff1b\u4ee5\u4e0b\u4fdd\u7559\u5148\u524d\u64f7\u53d6\u7684\u771f\u5be6\u65b0\u805e\uff0c\u4e26\u975e\u66f4\u65b0\u5f8c\u7684\u6e05\u55ae\u3002';
        if (result.limitReached) sourceText += en
          ? ' The supported pagination limit was reached; additional archive coverage is not claimed.'
          : ' \u5df2\u9054\u5206\u9801\u4e0a\u9650\uff1b\u4e0d\u4ee3\u8868\u5df2\u6536\u9304\u5168\u90e8\u6b77\u53f2\u65b0\u805e\u3002';
        sourceText += ` ${root.FmpCache.note(result, language)}`;
        draw();
      } catch (error) {
        if (id !== requestId) return;
        console.error('Company news could not be refreshed', symbol, error.message);
        sourceText = `${en ? 'Live FMP news unavailable' : 'FMP \u5373\u6642\u65b0\u805e\u7121\u6cd5\u8b80\u53d6'} (${error.message}). ${
          rows.length ? (en ? 'Showing previously captured articles, not a successful live refresh.' : '\u4ee5\u4e0b\u662f\u5148\u524d\u64f7\u53d6\u5167\u5bb9\uff0c\u4e26\u975e\u672c\u6b21\u5373\u6642\u66f4\u65b0\u7d50\u679c\u3002')
            : (en ? 'No articles were fabricated.' : '\u4e0d\u4ee5\u793a\u610f\u65b0\u805e\u4ee3\u66ff\u3002')}`;
        draw();
        more.textContent = en ? 'Retry FMP news' : '\u91cd\u8a66 FMP \u65b0\u805e';
        more.hidden = false;
      } finally { if (id === requestId) { more.disabled = false; refresh.disabled = false; } }
    }
    more.addEventListener('click', () => load());
    refresh.addEventListener('click', () => { page = 0; load(true); });
    draw();
    const translate = async () => {
      if (en) return;
      try {
        const data = await loadTranslations();
        if (id !== requestId) return;
        translations = data;
      } catch (error) {
        if (id !== requestId) return;
        console.error('Saved headline translations unavailable', error.message);
        translationError = error.message;
      }
      if (id === requestId) draw();
    };
    await Promise.all([load(), translate()]);
  }

  return { safeUrl, splits, newsRows, newsListings, metadata, renderNews, load, peek: ticker => loaded.get(ticker) };
});
