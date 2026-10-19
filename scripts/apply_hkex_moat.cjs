const fs = require('node:fs');
const path = require('node:path');
const dimensions = ['m1_brand_pricing', 'm2_patents_regulatory', 'm3_high_switching_costs',
  'm4_network_effects', 'm5_cost_advantage_scale', 'm6_unique_geography_assets',
  'm7_operational_efficiency', 'm8_capital_allocation', 'm9_customer_retention', 'm10_durability'];

function applyReports(market, reports) {
  const result = structuredClone(market);
  for (const [ticker, assessment] of Object.entries(reports)) {
    const stock = result[ticker], report = assessment.report;
    if (!stock || report?.ticker !== ticker || assessment.lastError
        || !assessment.updatedAt || !Number.isFinite(Date.parse(assessment.updatedAt))
        || assessment.evidenceHash !== stock.ratingSources?.moat?.currentEvidenceHash) {
      throw new Error(`${ticker}: assessment identity, status or evidence does not match current financials`);
    }
    for (const key of dimensions) {
      const item = report[key];
      if (!item || item.score !== null && (!Number.isInteger(item.score) || item.score < 0 || item.score > 10)
          || !Array.isArray(item.sources) || item.score !== null && !item.sources.length
          || !item.comment_zh?.trim() || !item.comment_en?.trim()) {
        throw new Error(`${ticker}: incomplete or invalid cited bilingual dimension ${key}`);
      }
    }
    if (!report.overall_moat_verdict_zh?.trim() || !report.overall_moat_verdict_en?.trim()) {
      throw new Error(`${ticker}: missing bilingual verdict`);
    }
    const research = assessment.businessResearch;
    if (research) {
      if (research.ticker !== ticker || !research.summary?.trim() || !research.searchEntryPointHtml?.trim()
          || !Array.isArray(research.sources) || research.sources.length < 2
          || research.sources.some((source, index) => source.id !== `web:${index + 1}`
            || !/^https:\/\//.test(source.url) || !source.title?.trim())) {
        throw new Error(`${ticker}: incomplete or mismatched business research attribution`);
      }
      const ids = new Set(research.sources.map(source => source.id));
      if (dimensions.some(key => report[key].sources.some(id => id.startsWith('web:') && !ids.has(id)))) {
        throw new Error(`${ticker}: research citation does not exist`);
      }
    }
    stock.moat = structuredClone(report);
    stock.description_zh = report.description_zh || stock.description_zh;
    Object.assign(stock.ratingSources.moat, {
      evidenceHash: assessment.evidenceHash, updatedAt: assessment.updatedAt,
      lastError: null, reason: null, model: assessment.model,
      provider: assessment.provider, assessmentPolicy: assessment.assessmentPolicy
    });
    if (assessment.businessResearch) stock.ratingSources.moat.businessResearch = structuredClone(assessment.businessResearch);
    else delete stock.ratingSources.moat.businessResearch;
  }
  return result;
}

if (require.main === module) {
  const root = path.resolve(__dirname, '..');
  if (!process.argv[2]) throw new Error('Pass the downloaded assessment JSON path');
  const reports = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const market = JSON.parse(fs.readFileSync(path.join(root, 'hk_market_dcf.json'), 'utf8'));
  const updated = applyReports(market, reports);
  const cachePath = path.join(root, 'cache', 'hkex_moat.json');
  const previous = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  fs.writeFileSync(cachePath, JSON.stringify({ ...previous, ...reports }) + '\n');
  fs.writeFileSync(path.join(root, 'hk_market_dcf.json'), JSON.stringify(updated) + '\n');
  fs.writeFileSync(path.join(root, 'hk_market_data.js'), `window.HK_MARKET_DATA = ${JSON.stringify(updated)};\n`);
  console.log(`Applied ${Object.keys(reports).length} matching assessments without changing financials or valuation inputs.`);
}
module.exports = { applyReports };
