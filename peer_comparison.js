(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PeerComparison = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  'use strict';
  // Comparison families broaden coverage; membership does not imply direct competition.
  const families = [
    ['Technology Hardware, Storage & Peripherals', 'Communications Equipment', 'Electronic Equipment & Instruments', 'Electronic Components'],
    ['Semiconductors', 'Semiconductor Materials & Equipment'],
    ['Systems Software', 'Application Software', 'IT Consulting & Other Services', 'Data Processing & Outsourced Services'],
    ['Wireless Telecommunication Services', 'Integrated Telecommunication Services', 'Cable & Satellite', 'Alternative Carriers'],
    ['Interactive Media & Services', 'Movies & Entertainment', 'Interactive Home Entertainment'],
    ['Broadline Retail', 'Home Improvement Retail', 'Apparel Retail', 'Specialty Stores', 'Footwear'],
    ['Automobile Manufacturers', 'Automotive Retail'],
    ['Restaurants', 'Hotels, Resorts & Cruise Lines', 'Casinos & Gaming', 'Personal Services'],
    ['Multi-Sector Holdings', 'Transaction & Payment Processing Services', 'Investment Banking & Brokerage',
      'Consumer Finance', 'Asset Management & Custody Banks', 'Financial Exchanges & Data'],
    ['Diversified Banks'],
    ['Property & Casualty Insurance', 'Multi-line Insurance', 'Life & Health Insurance', 'Insurance Brokers'],
    ['Pharmaceuticals', 'Biotechnology', 'Life Sciences Tools & Services'],
    ['Managed Healthcare', 'Health Care Equipment', 'Health Care Supplies', 'Health Care Services',
      'Health Care Distributors', 'Health Care Technology'],
    ['Consumer Staples Merchandise Retail'],
    ['Household Products'],
    ['Soft Drinks & Non-alcoholic Beverages', 'Tobacco', 'Packaged Foods & Meats', 'Agricultural Products & Services'],
    ['Aerospace & Defense'],
    ['Construction Machinery & Heavy Transportation Equipment', 'Agricultural & Farm Machinery', 'Industrial Machinery',
      'Electrical Components & Equipment', 'Building Products', 'Industrial Conglomerates'],
    ['Rail Transportation', 'Air Freight & Logistics', 'Airport Services'],
    ['Research & Consulting Services', 'Diversified Support Services', 'Human Resource & Employment Services',
      'Environmental & Facilities Services', 'Commercial & Professional Services'],
    ['Integrated Oil & Gas', 'Oil & Gas Exploration & Production', 'Oil & Gas Equipment & Services',
      'Oil & Gas Storage & Transportation', 'Oil & Gas Refining & Marketing'],
    ['Industrial Gases', 'Specialty Chemicals', 'Fertilizers & Agricultural Chemicals', 'Commodity Chemicals'],
    ['Copper', 'Gold'],
    ['Construction Materials'],
    ['Electric Utilities', 'Multi-Utilities', 'Water Utilities'],
    ['Industrial REITs', 'Telecom Tower REITs', 'Data Center REITs', 'Retail REITs', 'Real Estate Services', 'Hotel & Resort REITs']
  ];
  const text = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
  const symbol = value => typeof value === 'string' ? value.trim().toUpperCase().replace(/[.-]/g, '') : '';
  const family = new Map(families.flatMap((industries, i) => industries.map(industry => [text(industry), i])));
  const issuer = (stock, ticker) => text(stock.company_name || stock.companyName)
    .replace(/\s*\(?class\s+[a-z]\)?/g, '').replace(/[^a-z0-9]/g, '') || symbol(ticker);

  function select(universe, ticker, limit = 5) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw new RangeError('Peer limit must be between 1 and 5');
    const entries = Object.entries(universe || {});
    const target = entries.find(([key]) => symbol(key) === symbol(ticker));
    if (!target) throw new RangeError(`Unknown comparison ticker: ${ticker}`);
    const [targetTicker, current] = target;
    const provided = new Set((Array.isArray(current.peers) ? current.peers : [])
      .filter(value => typeof value === 'string').map(symbol));
    const targetIssuer = issuer(current, targetTicker);
    const targetFamily = family.get(text(current.industry));
    const candidates = [];
    for (const [key, stock] of entries) {
      if (!stock || symbol(key) === symbol(targetTicker) || issuer(stock, key) === targetIssuer) continue;
      const sameSector = text(stock.sector) && text(stock.sector) === text(current.sector);
      const sameIndustry = sameSector && text(stock.industry) && text(stock.industry) === text(current.industry);
      const related = sameSector && targetFamily !== undefined && family.get(text(stock.industry)) === targetFamily;
      const provider = provided.has(symbol(key));
      if (!sameIndustry && !provider && !related) continue;
      const basis = sameIndustry ? 'industry' : provider ? 'provider' : 'related';
      const priority = sameIndustry ? (provider ? 0 : 1) : provider ? 2 : 3;
      const distance = Number.isFinite(current.mcap) && Number.isFinite(stock.mcap)
        ? Math.abs(stock.mcap - current.mcap) : Infinity;
      candidates.push({ ticker: key, stock, basis, priority, distance });
    }
    candidates.sort((a, b) => a.priority - b.priority || a.distance - b.distance || a.ticker.localeCompare(b.ticker));
    const seenIssuers = new Set([targetIssuer]);
    const peers = candidates.filter(candidate => {
      const key = issuer(candidate.stock, candidate.ticker);
      if (seenIssuers.has(key)) return false;
      seenIssuers.add(key);
      return true;
    }).slice(0, limit).map(({ ticker, stock, basis }) => ({ ticker, stock, basis }));
    const available = new Set(entries.map(([key]) => symbol(key)));
    return {
      ticker: targetTicker, peers,
      counts: Object.fromEntries(['industry', 'provider', 'related'].map(basis => [basis, peers.filter(peer => peer.basis === basis).length])),
      unavailable: [...provided].filter(key => key !== symbol(targetTicker) && !available.has(key))
    };
  }
  return { select };
});
