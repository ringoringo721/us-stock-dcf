/**
 * Market enterprise value in calculation-currency millions.
 *
 * Formula: EV = market cap + net debt
 *         = market cap + total debt − cash and short-term investments
 *
 * FMP `/enterprise-values` stays in the statement reported currency. After the
 * shared USD statement translator sets fx_rate=1, treating that endpoint as USD
 * millions mislabels KRW/TWD/JPY/… values (SKHY/ASX-class bugs). Prefer the
 * balance-derived USD EV already used by usd_financials.cjs / build_hkex.cjs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MarketEv = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const finite = value => typeof value === 'number' && Number.isFinite(value);

  function netDebtMillions(stock) {
    if (finite(stock?.net_debt)) return stock.net_debt;
    const debt = stock?.debt;
    const cash = finite(stock?.cash_and_short_term) ? stock.cash_and_short_term
      : finite(stock?.cash) ? stock.cash : null;
    return finite(debt) && finite(cash) ? debt - cash : null;
  }

  function computedEnterpriseValue(stock) {
    const mcap = stock?.mcap;
    const netDebt = netDebtMillions(stock);
    return finite(mcap) && finite(netDebt) ? mcap + netDebt : null;
  }

  function storedEnterpriseValue(stock) {
    for (const key of ['EV', 'ev', 'fmp_official_ev']) {
      const value = Number(stock?.[key]);
      if (finite(value)) return value;
    }
    return null;
  }

  function reportingCurrency(stock) {
    const code = String(stock?.reportedCurrency || stock?.sourceReportedCurrency || '').trim().toUpperCase();
    return code || null;
  }

  function calculationCurrency(stock) {
    const code = String(stock?.calculationCurrency || 'USD').trim().toUpperCase();
    return code || 'USD';
  }

  /** True when statements report in a currency other than the calculation currency. */
  function needsTranslatedMarketEv(stock) {
    const reported = reportingCurrency(stock);
    return !!(reported && reported !== calculationCurrency(stock));
  }

  /**
   * Detect FMP enterprise-values left in local currency while mcap/debt are translated.
   * Typical FX leftovers are >>2.5× the balance-derived EV (KRW≈1e3, JPY≈1e2, TWD≈3e1).
   */
  function looksUnconvertedLocalEv(stored, computed, mcap) {
    if (!finite(stored) || !finite(computed)) return false;
    const scale = Math.max(Math.abs(mcap) || 0, Math.abs(computed), 1);
    return Math.abs(stored) > 2.5 * Math.max(Math.abs(computed), scale * 0.5)
      && Math.abs(stored - computed) > Math.max(2500, 0.35 * scale);
  }

  function quotedEnterpriseValue(stock) {
    const computed = computedEnterpriseValue(stock);
    const stored = storedEnterpriseValue(stock);
    // Prefer balance-derived EV (mcap + debt − cash) in the calculation currency.
    // FMP `/enterprise-values` can lag the quote or remain in reportedCurrency after FX
    // translation (#56 SKHY/ASX). Front-table / screener coverage follows this formula.
    if (finite(computed)) {
      if (needsTranslatedMarketEv(stock)) return computed;
      if (finite(stored) && looksUnconvertedLocalEv(stored, computed, stock.mcap)) return computed;
      return computed;
    }
    return stored;
  }

  function ttmEbitdaMillions(stock) {
    const series = stock?.statements_raw?.income?.ebitda;
    if (Array.isArray(series)) {
      const last = series.filter(finite).at(-1);
      if (finite(last)) return last;
    }
    const debt = stock?.debt;
    const debtToEbitda = stock?.debt_to_ebitda;
    if (finite(debt) && finite(debtToEbitda) && debtToEbitda > 0) return debt / debtToEbitda;
    const netDebt = netDebtMillions(stock);
    const netDebtToEbitda = stock?.net_debt_to_ebitda;
    if (finite(netDebt) && finite(netDebtToEbitda) && netDebtToEbitda !== 0) {
      return netDebt / netDebtToEbitda;
    }
    return null;
  }

  function applyEnterpriseValue(stock, ev = computedEnterpriseValue(stock)) {
    if (!stock || !finite(ev)) return stock;
    const ebitda = ttmEbitdaMillions(stock);
    const fcf0 = stock.fcf0;
    stock.ev = Math.round(ev * 10) / 10;
    stock.fmp_official_ev = stock.ev;
    stock.enterpriseValueBasis = `${calculationCurrency(stock)} market capitalization + ${calculationCurrency(stock)} debt - ${calculationCurrency(stock)} cash and short-term investments`;
    stock.ev_to_ebitda = finite(ebitda) && ebitda > 0 ? Math.round((stock.ev / ebitda) * 10) / 10 : stock.ev_to_ebitda ?? null;
    stock.fcf_to_ev = finite(fcf0) && stock.ev > 0 ? Math.round((fcf0 / stock.ev) * 10000) / 100 : stock.fcf_to_ev ?? null;
    return stock;
  }

  return {
    netDebtMillions,
    computedEnterpriseValue,
    storedEnterpriseValue,
    quotedEnterpriseValue,
    needsTranslatedMarketEv,
    looksUnconvertedLocalEv,
    applyEnterpriseValue,
    ttmEbitdaMillions
  };
});
