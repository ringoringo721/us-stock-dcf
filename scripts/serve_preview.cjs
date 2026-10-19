const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '..', 'public');
const env = path.resolve(__dirname, '..', '.env.local');
if (fs.existsSync(env)) process.loadEnvFile(env);
const handler = require('../api/fmp.js');
const port = Number(process.argv[2] || 57102);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new RangeError('Invalid preview port');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/fmp') {
    handler(req, res).catch(error => {
      console.error('Preview API failed', error.name);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'PREVIEW_API_ERROR' }));
    });
    return;
  }
  let filename;
  try { filename = decodeURIComponent(url.pathname); }
  catch { res.writeHead(400).end(); return; }
  const file = path.resolve(root, '.' + (filename === '/' ? '/index.html' : filename));
  if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (error, body) => {
    if (error) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', file.endsWith('.html') ? 'text/html; charset=utf-8'
      : file.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'application/json');
    res.end(body);
  });
});
server.listen(port, '127.0.0.1', () => console.log(`Local preview: http://127.0.0.1:${port}`));
