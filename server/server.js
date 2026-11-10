// Logo Prep Studio server: hands out the app's files and runs the website
// logo search (/api/logos). The app itself runs in each person's browser;
// client logos never come here. No dependencies beyond Node itself.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { findLogos } from './find-logos.js';

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
    if (!gzCache.has(key)) gzCache.set(key, zlib.gzipSync(body, { level: 7 }));
    body = gzCache.get(key);
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://local');
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
