const assert = require('node:assert/strict');
const test = require('node:test');
const IndustryTaxonomy = require('../industry_taxonomy.js');

test('FMP Parent - Sub strings nest under the parent', () => {
  assert.deepEqual(IndustryTaxonomy.parse('Banks - Regional'), {
    parent: 'Banks', sub: 'Regional', full: 'Banks - Regional'
  });
  assert.deepEqual(IndustryTaxonomy.parse('Apparel - Manufacturers'), {
    parent: 'Apparel', sub: 'Manufacturers', full: 'Apparel - Manufacturers'
  });
  assert.deepEqual(IndustryTaxonomy.parse('Software - Infrastructure'), {
    parent: 'Software', sub: 'Infrastructure', full: 'Software - Infrastructure'
  });
});

test('baseline GICS labels fold into the same parents as FMP', () => {
  assert.equal(IndustryTaxonomy.parse('Diversified Banks').parent, 'Banks');
  assert.equal(IndustryTaxonomy.parse('Apparel Retail').parent, 'Apparel');
  assert.equal(IndustryTaxonomy.parse('Application Software').parent, 'Software');
  assert.equal(IndustryTaxonomy.parse('Systems Software').parent, 'Software');
  assert.equal(IndustryTaxonomy.parse('Insurance Brokers').parent, 'Insurance');
});

test('Chinese UI never falls back to English for known industries', () => {
  const samples = [
    'Banks - Regional',
    'Apparel - Manufacturers',
    'Agricultural - Machinery',
    'Software - Application',
    'Medical - Devices',
    'REIT - Retail',
    'Financial - Credit Services',
    'Diversified Banks',
    'Application Software',
    'Semiconductors'
  ];
  for (const industry of samples) {
    const label = IndustryTaxonomy.labelIndustry(industry, 'zh');
    assert.notEqual(label, industry, industry);
    assert.match(label, /[\u4e00-\u9fff]/);
  }
  assert.equal(IndustryTaxonomy.labelParent('Banks', 'zh'), '銀行');
  assert.equal(IndustryTaxonomy.labelParent('Apparel', 'zh'), '服裝');
  assert.equal(IndustryTaxonomy.labelSub(IndustryTaxonomy.parse('Banks - Regional'), 'zh'), '地區性');
  assert.equal(IndustryTaxonomy.labelSub(IndustryTaxonomy.parse('Banks - Regional'), 'en'), 'Regional');
});

test('English labels stay English', () => {
  assert.equal(IndustryTaxonomy.labelIndustry('Banks - Regional', 'en'), 'Banks - Regional');
  assert.equal(IndustryTaxonomy.labelParent('Banks', 'en'), 'Banks');
});

test('sector canonicalization maps FMP English sectors onto filter keys', () => {
  assert.equal(IndustryTaxonomy.canonicalSector('Technology'), '資訊科技');
  assert.equal(IndustryTaxonomy.canonicalSector('Financial Services'), '金融');
  assert.equal(IndustryTaxonomy.canonicalSector('Consumer Cyclical'), '非必需消費');
  assert.equal(IndustryTaxonomy.canonicalSector('資訊科技'), '資訊科技');
});

test('matches filters by parent and exact full industry', () => {
  assert.equal(IndustryTaxonomy.matches('Banks - Regional', 'Banks', 'ALL'), true);
  assert.equal(IndustryTaxonomy.matches('Banks - Diversified', 'Banks', 'ALL'), true);
  assert.equal(IndustryTaxonomy.matches('Diversified Banks', 'Banks', 'ALL'), true);
  assert.equal(IndustryTaxonomy.matches('Apparel - Retail', 'Banks', 'ALL'), false);
  assert.equal(IndustryTaxonomy.matches('Banks - Regional', 'Banks', 'Banks - Regional'), true);
  assert.equal(IndustryTaxonomy.matches('Banks - Diversified', 'Banks', 'Banks - Regional'), false);
});
