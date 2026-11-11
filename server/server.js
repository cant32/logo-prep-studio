// Logo Prep Studio server: hands out the app's files and runs the website
// logo search (/api/logos, and /api/file to fetch one logo download it found). The app itself runs in each person's browser;
// client logos never come here. No dependencies beyond Node itself.

import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { findLogos } from './find-logos.js';
import { safeGet } from './safe-fetch.js';
import { getStats, count } from './stats.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8080;
// Every deploy gets its own version stamp on the app's file links, so a
// browser can never mix cached code from an older version with a new page.
const VERSION = String(process.env.RAILWAY_GIT_COMMIT_SHA || Date.now().toString(36)).slice(0, 12);
const stamp = u => /^(https?:|data:|blob:|#|\/\/)/.test(u) || u.includes('?') ? u : `${u}?v=${VERSION}`;
// index.html: the page's own stylesheets, scripts and logo
const stampHtml = html => html.replace(/(\s(?:src|href)=")((?:css|js|vendor)\/[^"]+)"/g, (m, a, u) => `${a}${stamp(u)}"`);
// the app's modules: their imports of each other and of vendor code
const stampJs = js => js.replace(/(\bfrom\s*['"]|\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+\.js)(['"])/g, (m, a, u, b) => `${a}${stamp(u)}${b}`);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.wasm': 'application/wasm', '.bin': 'application/octet-stream', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.otf': 'font/otf', '.ttf': 'font/ttf', '.md': 'text/plain; charset=utf-8', '.ico': 'image/x-icon',
};
const COMPRESS = /^(text\/|application\/(json|wasm|octet-stream)|image\/svg|font\/(otf|ttf))/;
// repo and build files that aren't part of the app
const PRIVATE = /^\/(server|tools|node_modules)\/|^\/(Dockerfile|Caddyfile|serve\.ps1|package(-lock)?\.json)$|\.(bat|command)$|\/\./;

const gzCache = new Map();
const gzip = (buf, opts) => new Promise((ok, fail) => zlib.gzip(buf, opts, (e, out) => e ? fail(e) : ok(out)));
async function sendFile(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel.endsWith('/')) rel += 'index.html';
  if (PRIVATE.test(rel)) return notFound(res);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep)) return notFound(res);
  let stat;
  try { stat = await fs.stat(file); } catch { return notFound(res); }
  if (!stat.isFile()) return notFound(res);
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'x-content-type-options': 'nosniff' };
  // the double-click copy of the app loads the EPS reader from here
  if (rel.startsWith('/vendor/ghostscript/')) headers['access-control-allow-origin'] = '*';
  // a stamped link names one exact version, so it can be kept; anything else is rechecked
  const versioned = new URL(req.url, 'http://local').searchParams.get('v') === VERSION;
  headers['cache-control'] = versioned ? 'public, max-age=31536000, immutable'
    : /^\/(vendor|fonts)\//.test(rel) ? 'public, max-age=604800' : 'no-cache';
  const etag = `"${VERSION}-${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  headers.etag = etag;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
  let body = await fs.readFile(file);
  if (rel === '/index.html') body = Buffer.from(stampHtml(body.toString('utf8')));
  else if (/^\/js\/.+\.js$/.test(rel)) body = Buffer.from(stampJs(body.toString('utf8')));
  if (COMPRESS.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && body.length > 1024) {
    const key = file + etag;
    if (!gzCache.has(key)) gzCache.set(key, gzip(body, { level: 7 }));
    body = await gzCache.get(key);
    headers['content-encoding'] = 'gzip';
    headers.vary = 'accept-encoding';
  }
  headers['content-length'] = body.length;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

function notFound(res) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found'); }

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json', 'cache-control': 'no-store',
    // the double-click copy of the app (opened from disk) calls this too
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

// A few searches a minute per person is plenty; this stops the endpoint
// being used as a general-purpose fetcher.
const hits = new Map();
function allowed(ip) {
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v[v.length - 1] > 60_000) hits.delete(k);
  return recent.length <= 30;   // an office shares one address, so allow for a few people at once
}

// One logo download from a public website (a press-kit PDF, AI, EPS, SVG or
// zip). Only those file types are passed on, judged by their content, so this
// can't be used to fetch anything else.
const FILE_KINDS = [
  ['pdf', b => b.slice(0, 1024).includes('%PDF-')],           // PDF and PDF-based .ai
  ['eps', b => b.slice(0, 4).equals(Buffer.from([0xc5, 0xd0, 0xd3, 0xc6])) || b.slice(0, 4).toString() === '%!PS'],
  ['zip', b => b.slice(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))],
  ['svgz', b => b[0] === 0x1f && b[1] === 0x8b],
  ['svg', b => /<svg\b/i.test(b.slice(0, 4000).toString('utf8'))],
];
async function sendRemoteFile(res, target) {
  const started = Date.now();
  try {
    const r = await safeGet(target, { maxBytes: 60_000_000, timeoutMs: 45_000 });
    if (r.status >= 400) throw Object.assign(new Error(`The site answered ${r.status} for that file.`), { status: 502 });
    const kind = (FILE_KINDS.find(([, test]) => test(r.body)) || [])[0];
    if (!kind) throw Object.assign(new Error('That link isn\'t a logo file (PDF, AI, EPS, SVG or zip). The site may need you to sign in to download it.'), { status: 422 });
    console.log(`file ${new URL(r.url).hostname} ${kind} ${(r.body.length / 1e6).toFixed(1)}MB in ${Date.now() - started}ms`);
    res.writeHead(200, {
      'content-type': 'application/octet-stream', 'content-length': r.body.length, 'cache-control': 'no-store',
      'x-file-kind': kind, 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-file-kind',
      'x-content-type-options': 'nosniff', 'content-disposition': 'attachment',
    });
    res.end(r.body);
  } catch (e) {
    console.log(`file failed: ${e.message}`);
    const msg = e.status === 413 ? 'That file is over 60 MB, too big to open here. Download it from the site instead.' : e.message || 'The download failed.';
    json(res, e.status && e.status < 600 ? e.status : 502, { error: msg });
  }
}

// counter events: a few per person per minute at most, so a stuck page can't inflate them
const statHits = new Map();
function statAllowed(ip) {
  const now = Date.now(), recent = (statHits.get(ip) || []).filter(t => now - t < 60_000);
  recent.push(now); statHits.set(ip, recent);
  if (statHits.size > 5000) for (const [k, v] of statHits) if (now - v[v.length - 1] > 60_000) statHits.delete(k);
  return recent.length <= 120;
}

// Railway volumes are owned by root. The container starts as root only to
// hand the data folder to the unprivileged "node" user, then drops to it
// before taking any requests.
if (process.getuid && process.getuid() === 0) {
  const data = process.env.DATA_DIR || '/data', NODE_UID = 1000, NODE_GID = 1000;
  try {
    if (fsSync.existsSync(data)) {
      fsSync.chownSync(data, NODE_UID, NODE_GID);
      for (const f of fsSync.readdirSync(data)) fsSync.chownSync(path.join(data, f), NODE_UID, NODE_GID);
    }
  } catch (e) { console.log(`data folder not prepared: ${e.message}`); }
  process.setgid(NODE_GID); process.setuid(NODE_UID);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
    if (url.pathname === '/api/stats') {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST' }); return res.end(); }
      if (req.method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
        const event = url.searchParams.get('e');
        if (statAllowed(ip)) count(event);
      }
      return json(res, 200, getStats());
    }
    if (url.pathname === '/api/logos') {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' }); return res.end(); }
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!allowed(ip)) return json(res, 429, { error: 'Too many searches in a minute. Wait a moment and try again.' });
      const site = url.searchParams.get('url');
      const started = Date.now();
      try {
        const result = await findLogos(site);
        console.log(`logos ${result.host} ${result.candidates.length} found in ${Date.now() - started}ms`);
        return json(res, 200, result);
      } catch (e) {
        console.log(`logos failed: ${e.message}`);
        return json(res, e.status && e.status < 600 ? e.status : 502, { error: e.message || 'The search failed.' });
      }
    }
    if (url.pathname === '/api/file') {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET' }); return res.end(); }
      if (req.method !== 'GET') return json(res, 405, { error: 'Use GET.' });
      const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (!allowed(ip)) return json(res, 429, { error: 'Too many requests in a minute. Wait a moment and try again.' });
      return sendRemoteFile(res, url.searchParams.get('url'));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Not allowed.' });
    if (url.pathname === '/healthz') return json(res, 200, { ok: true });
    return await sendFile(req, res, url.pathname);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Server error.' });
    else res.end();
  }
});

server.listen(PORT, () => console.log(`Logo Prep Studio on port ${PORT}`));
