const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = 'https://www.federalreserve.gov/releases/h10/data/FRB_h10_xml.zip';
const extension = process.argv.find(arg => arg.startsWith('--extend-from='));
// HKD cross-rates must retain 2010+ history for gaming JPY conversions / hkd_currency tests.
// Plain `--hkd` used to default to 2018-01-01 and overwrite the cache, truncating early years
// and failing Refresh HKEX after a successful moat remoat (no commit).
const hkdFlag = process.argv.includes('--hkd');
const from = extension ? extension.slice('--extend-from='.length) : (hkdFlag ? '2010-01-01' : '2018-01-01');
if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from))
    || new Date(from).toISOString().slice(0, 10) !== from) throw new Error('Invalid historical FX start date');
const parser = `
import sys, io, zipfile, json, xml.etree.ElementTree as E
archive = zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()))
root = E.fromstring(archive.read('H10_data.xml'))
currencies = {}
prepared = None
for element in root.iter():
    if element.tag.endswith('}Prepared'):
        prepared = element.text
    if not element.tag.endswith('}Series'):
        continue
    a = element.attrib
    currency = a.get('CURRENCY', '')
    if a.get('FREQ') != '9' or a.get('UNIT') != 'Currency' or len(currency) != 3 or currency == 'USD':
        continue
    name = a['SERIES_NAME']
    observations = []
    for obs in element:
        if not obs.tag.endswith('}Obs') or obs.attrib.get('OBS_STATUS') != 'A':
            continue
        date = obs.attrib.get('TIME_PERIOD', '')
        try:
            value = float(obs.attrib['OBS_VALUE'])
        except (ValueError, KeyError):
            continue
        if date >= '${from}' and value > 0:
            observations.append([date, value if '$US' in name else 1 / value])
    if observations:
        if currency in currencies:
            raise ValueError('Ambiguous FX series for ' + currency)
        currencies[currency] = {'series': name, 'observations': sorted(observations)}
if not all(currency in currencies for currency in ['TWD', 'EUR', 'MXN', 'CAD']):
    raise ValueError('Required currencies absent from Federal Reserve release')
print(json.dumps({'version': 1, 'source': '${source}', 'prepared': prepared, 'unit': 'USD per source currency unit', 'currencies': currencies}, separators=(',', ':')))
`;

(async () => {
  const response = await fetch(source, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Federal Reserve FX HTTP ${response.status}`);
  const parsed = spawnSync(process.env.PYTHON || 'python', ['-c', parser], {
    input: Buffer.from(await response.arrayBuffer()), encoding: 'utf8', maxBuffer: 10 * 1024 * 1024
  });
  if (parsed.status !== 0) throw new Error(parsed.stderr || parsed.error?.message || 'FX parser failed');
  const rates = JSON.parse(parsed.stdout);
  const hkd = hkdFlag;
  if (hkd) {
    if (!['HKD', 'CNY', 'JPY'].every(currency => rates.currencies[currency])) {
      throw new Error('Required HKD cross-rate observations are absent');
    }
    if (!process.argv.includes('--all-hkd-currencies')) {
      rates.currencies = Object.fromEntries(['HKD', 'CNY', 'JPY'].map(currency => [currency, rates.currencies[currency]]));
    }
  }
  const target = path.join(__dirname, '..', 'cache', 'fx', hkd ? 'hkd_rates.json' : 'usd_rates.json');
  if (extension) {
    const existing = JSON.parse(fs.readFileSync(target, 'utf8'));
    for (const [currency, series] of Object.entries(existing.currencies)) {
      const additional = rates.currencies[currency];
      if (!additional || additional.series !== series.series) throw new Error(`Missing or changed FX series: ${currency}`);
      const first = series.observations[0]?.[0];
      if (!first) throw new Error(`Existing FX observations absent: ${currency}`);
      series.observations = [...additional.observations.filter(([date]) => date < first), ...series.observations];
    }
    for (const [currency, series] of Object.entries(rates.currencies)) {
      if (!existing.currencies[currency]) {
        existing.currencies[currency] = { ...series, prepared: rates.prepared, capturedAt: new Date().toISOString() };
      }
    }
    existing.historicalExtension = { source, prepared: rates.prepared, from, capturedAt: new Date().toISOString(),
      basis: 'Earlier observations and missing currencies added without changing any previously cached date or value' };
    fs.writeFileSync(target, JSON.stringify(existing) + '\n');
    console.log(`Extended historical FX to ${from}; existing observations preserved`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(rates) + '\n');
  console.log(`${hkd ? 'HKD cross-rate source observations' : 'Historical USD rates'}: ${Object.keys(rates.currencies).length} currencies; official release ${rates.prepared}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
