const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = 'https://www.federalreserve.gov/releases/h10/data/FRB_h10_xml.zip';
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
        if date >= '2018-01-01' and value > 0:
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
  const target = path.join(__dirname, '..', 'cache', 'fx', 'usd_rates.json');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(rates) + '\n');
  console.log(`Historical USD rates: ${Object.keys(rates.currencies).length} currencies; official release ${rates.prepared}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
