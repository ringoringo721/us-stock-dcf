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

  function load(ticker) {
    if (!/^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(ticker)) return Promise.reject(new Error('INVALID_COMPANY_SYMBOL'));
    if (!cache.has(ticker)) cache.set(ticker, (async () => {
      const response = await root.fetch(`cache/company/${encodeURIComponent(ticker)}.json`);
      if (!response.ok) throw new Error(`COMPANY_DATA_HTTP_${response.status}`);
      const data = await response.json();
      if (data.symbol !== ticker) throw new Error('COMPANY_DATA_SECURITY_MISMATCH');
      loaded.set(ticker, data);
      return data;
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

  async function renderNews(container, symbol, storedRows, language) {
    if (!container) return;
    const id = ++requestId, en = language === 'en';
    let rows = newsRows(storedRows, symbol), page = 0, hasMore = true, translations = null, translationError = null;
    let sourceText = rows.length ? (en ? 'Previously captured FMP news; live refresh pending.' : '\u5df2\u64f7\u53d6\u7684 FMP \u65b0\u805e\uff1b\u6b63\u5728\u66f4\u65b0\u3002') : '';
    const status = root.document.createElement('p'), articles = root.document.createElement('div');
    const languageNote = root.document.createElement('p');
    languageNote.className = 'analysis-note';
    const more = root.document.createElement('button');
    more.type = 'button';
    more.className = 'action-btn';
    container.replaceChildren(languageNote, status, articles, more);
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
        source.textContent = [item.publisher || item.site, item.publishedDate, symbol, 'FMP',
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
    async function load() {
      more.disabled = true;
      status.textContent = en ? 'Loading FMP company news\u2026' : '\u6b63\u5728\u8f09\u5165 FMP \u516c\u53f8\u65b0\u805e\u2026';
      try {
        const response = await root.fetch(`/api/fmp?action=news&symbol=${encodeURIComponent(symbol)}&page=${page}`);
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('FMP_API_UNAVAILABLE');
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `HTTP_${response.status}`);
        if (!Array.isArray(result.data) || result.source?.symbol !== symbol || result.page !== page) {
          throw new Error('FMP_INVALID_RESPONSE');
        }
        if (id !== requestId) return;
        const retainedArchive = page === 0 && result.data.length === 0 && rows.length > 0;
        rows = newsRows(page === 0 && !retainedArchive ? result.data : [...rows, ...result.data], symbol);
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
      } finally { if (id === requestId) more.disabled = false; }
    }
    more.addEventListener('click', load);
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

  return { safeUrl, splits, newsRows, metadata, renderNews, load, peek: ticker => loaded.get(ticker) };
});
