(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Liquidation = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

  function calculate(snapshot, ticker) {
    const result = { values: [null, null, null], reasons: [], warnings: [],
      balanceDate: null, quoteDate: null, shares: null };
    const unavailable = reason => ({ ...result, reasons: [reason, reason, reason] });
    if (!snapshot) return unavailable('missingSnapshot');
    const currency = ticker.endsWith('.HK') ? 'HKD' : 'USD';
    if (currency === 'HKD' && snapshot.shareBasis === 'unverifiedMixedShareClasses') return unavailable('shareBasisUnverified');
    if (snapshot.version !== 1 || snapshot.ticker !== ticker || snapshot.currency !== currency
        || snapshot.receivablesBasis !== 'trade' || snapshot.shareBasis !== 'marketCapOverPrice'
        || !date(snapshot.balanceDate) || !date(snapshot.quoteDate)
        || typeof snapshot.fetchedAt !== 'string' || !date(snapshot.fetchedAt.slice(0, 10))
        || snapshot.balanceDate > snapshot.fetchedAt.slice(0, 10)
        || snapshot.quoteDate > snapshot.fetchedAt.slice(0, 10)) return unavailable('invalidSnapshot');
    result.balanceDate = snapshot.balanceDate;
    result.quoteDate = snapshot.quoteDate;
    const fx = snapshot.fx;
    if (fx?.reason || fx?.basis !== 'closing' || !finite(fx?.rate) || fx.rate <= 0 || !date(fx.observationDate)
        || fx.observationDate > snapshot.balanceDate
        || (Date.parse(snapshot.balanceDate) - Date.parse(fx.observationDate)) / 86400000 > 7) {
      return unavailable('missingFx');
    }
    const quote = snapshot.quote;
    if (quote?.currency !== currency || !finite(quote.price) || quote.price <= 0
        || !finite(quote.marketCap) || quote.marketCap <= 0) return unavailable('invalidShares');
    const shares = quote.marketCap / quote.price;
    if (!finite(shares) || shares <= 0) return unavailable('invalidShares');
    result.shares = shares;
    const amounts = snapshot.amounts || {};
    if (!finite(amounts.preferredStock)) result.warnings.push('preferredUnknown');
    else if (amounts.preferredStock > 0) result.warnings.push('preferredClaims');
    const { currentAssets, totalLiabilities, cashAndShortTermInvestments, tradeReceivables, inventory } = amounts;
    const formulas = [
      { inputs: [currentAssets, totalLiabilities], numerator: () => currentAssets - totalLiabilities },
      { inputs: [cashAndShortTermInvestments, tradeReceivables, inventory, totalLiabilities],
        numerator: () => cashAndShortTermInvestments + tradeReceivables * 0.8 + inventory * 0.5 - totalLiabilities },
      { inputs: [cashAndShortTermInvestments, totalLiabilities],
        numerator: () => cashAndShortTermInvestments - totalLiabilities }
    ];
    formulas.forEach((formula, i) => {
      if (!formula.inputs.every(finite)) result.reasons[i] = 'missingInputs';
      else {
        const value = formula.numerator() / shares;
        result.values[i] = finite(value) ? value : null;
        result.reasons[i] = finite(value) ? null : 'invalidCalculation';
      }
    });
    return result;
  }
  return { calculate };
});
