import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import handler from './api/optimize.js';

// Local-only reuse of an existing credential file; no key is copied or printed.
if (process.env.DEEPSEEK_KEY_FILE && !process.env.DEEPSEEK_API_KEY) {
  const line = readFileSync(process.env.DEEPSEEK_KEY_FILE, 'utf8').split(/\r?\n/).find(line => /^\s*DEEPSEEK_API_KEY\s*=/.test(line));
  process.env.DEEPSEEK_API_KEY = line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') || '';
}
const files = { '/': ['index.html', 'text/html'], '/style.css': ['style.css', 'text/css'], '/app.js': ['app.js', 'text/javascript'], '/dialogue.js': ['dialogue.js', 'text/javascript'], '/example.json': ['example.json', 'application/json'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const server = createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/optimize') return void handler(req, res);
  const file = files[path];
  if (!file || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); return res.end('Not found'); }
  res.setHeader('Content-Type', file[1] + '; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(req.method === 'HEAD' ? undefined : readFileSync(new URL('./public/' + file[0], import.meta.url)));
});
server.requestTimeout = 150000;
server.listen(Number(process.env.PORT || 3030), '127.0.0.1', () => console.log(`Dialogue studio: http://127.0.0.1:${server.address().port}`));
