'use strict';
// ExamInfo games-only server: team lobby, play online queue, leave/return alerts, rematch. No keys, no payments.
const http = require('http');
const E = process.env;
const hits = new Map();
function limited(ip, key, max, ms) {
  const k = key + ip, now = Date.now(), arr = (hits.get(k) || []).filter((t) => now - t < ms);
  arr.push(now); hits.set(k, arr); return arr.length > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 600000)) hits.delete(k); }, 600000).unref();
function send(res, code, body, type, extra) {
  const h = Object.assign({ 'Content-Type': type || 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }, extra || {});
  res.writeHead(code, h); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function body(req, max) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > (max || 20000)) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const ipOf = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const community = require('./community')({ send, body, limited, ipOf, isAdmin: () => false, readJson: (f, d) => d, writeJson: () => {}, E, libQuestions: () => [] });
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  try { if (await community(req, res, u, u.pathname)) return; } catch (e) { return send(res, 500, { error: 'Server error' }); }
  if (u.pathname === '/' || u.pathname === '/health') return send(res, 200, 'ExamInfo game server is running', 'text/plain');
  send(res, 404, { error: 'Not found' });
}).listen(Number(E.PORT) || 3000, '0.0.0.0', () => console.log('ExamInfo game server running'));
