// GET a public web address, safely. The website search fetches pages people
// type in, so it must never reach this machine, Railway's internal network or
// any private address: every connection's resolved IP is checked as the
// socket opens (redirects included, so a public site can't bounce us inward),
// and sizes and times are capped.

import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === '1';   // local tests only

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9')
    || v.startsWith('fea') || v.startsWith('feb') || v.startsWith('ff') || v.startsWith('64:ff9b');
}

// dns.lookup that refuses private answers; used by the socket itself.
function guardedLookup(hostname, options, cb) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return cb(err);
    const ok = addresses.filter(a => ALLOW_PRIVATE || !isPrivateAddress(a.address));
    if (!ok.length) return cb(Object.assign(new Error('That address is not a public website.'), { code: 'PRIVATE_ADDRESS' }));
    if (options.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  });
}

export function normaliseUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw Object.assign(new Error('Type a website address.'), { status: 400 });
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw Object.assign(new Error('That doesn\'t look like a website address.'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http and https addresses can be searched.'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Addresses with a login in them can\'t be searched.'), { status: 400 });
  if (!ALLOW_PRIVATE && (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, '')) || /^(localhost|.*\.local|.*\.internal|.*\.railway\.internal)$/i.test(u.hostname))) {
    throw Object.assign(new Error('That address is not a public website.'), { status: 400 });
  }
  return u;
}

const UA = 'Mozilla/5.0 (compatible; StackedLogoPrep/1.0; +https://stacked.ie)';

// Resolves { url, status, contentType, body: Buffer } for a 2xx response.
export function safeGet(input, { maxBytes = 3_000_000, timeoutMs = 10_000, maxRedirects = 5, accept = '*/*' } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const go = (url, redirects) => {
      let u;
      try { u = normaliseUrl(url); } catch (e) { return reject(e); }
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, {
        method: 'GET', lookup: guardedLookup, timeout: Math.max(1000, timeoutMs - (Date.now() - started)),
        headers: { 'user-agent': UA, accept, 'accept-encoding': 'gzip, deflate, br', 'accept-language': 'en-IE,en;q=0.9' },
      }, res => {
        const { statusCode = 0, headers } = res;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirects >= maxRedirects) return reject(Object.assign(new Error('Too many redirects.'), { status: 502 }));
          return go(new URL(headers.location, u).href, redirects + 1);
        }
        if (statusCode < 200 || statusCode >= 300) {
          res.resume();
          return reject(Object.assign(new Error(`The website answered ${statusCode}.`), { status: 502, upstream: statusCode }));
        }
        const enc = String(headers['content-encoding'] || '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate())
          : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks = []; let size = 0;
        stream.on('data', c => {
          size += c.length;
          if (size > maxBytes) { req.destroy(); stream.destroy(); reject(Object.assign(new Error('That file is too big.'), { status: 413 })); }
          else chunks.push(c);
        });
        stream.on('end', () => resolve({ url: u.href, status: statusCode, contentType: String(headers['content-type'] || ''), body: Buffer.concat(chunks) }));
        stream.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('The website took too long to answer.'), { status: 504 })));
      req.on('error', e => reject(e.code === 'PRIVATE_ADDRESS' ? Object.assign(e, { status: 400 })
        : e.status ? e : Object.assign(new Error(e.code === 'ENOTFOUND' ? 'That website couldn\'t be found.' : 'The website couldn\'t be reached.'), { status: 502 })));
      req.end();
    };
    go(input, 0);
  });
}
