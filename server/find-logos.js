// Find a company's logo on its website. Reads the page's HTML (no browser, so
// sites that only draw their header with JavaScript may show just fallbacks)
// and ranks what it finds: SVG first, the header and anything called "logo"
// above the rest, raster icons last. It also looks for logo downloads (PDF,
// AI, EPS, SVG, zip packs) on the page and on the site's press / brand /
// media-kit pages: those are usually the master print artwork.

import zlib from 'node:zlib';
import { safeGet } from './safe-fetch.js';

const MAX_CANDIDATES = 8;
// pictures smaller than this (longest side, px) aren't worth offering: too
// little detail left to make a print logo from
const MIN_PICTURE = 300;

// Site builders serve resized copies with the size in the address. These
// rules ask for the uploaded original instead; the search fetches both and
// keeps whichever is bigger, so a wrong guess costs nothing.
export function originalUrls(u) {
  let x; try { x = new URL(u); } catch { return []; }
  const h = x.hostname, p = x.pathname, out = [];
  const bare = path => x.origin + path;
  if (h === 'static.wixstatic.com' && p.includes('/v1/')) out.push(bare(p.slice(0, p.indexOf('/v1/'))));      // Wix: drop /v1/fill/w_…
  if (/squarespace-cdn\.com$/.test(h) && x.search) out.push(bare(p));                                          // Squarespace: drop ?format=300w
  if (h === 'cdn.shopify.com' || p.includes('/cdn/shop/')) {                                                    // Shopify: logo_200x.png
    const q = p.replace(/_(?:\d+x\d*|x\d+)(?:_crop_[a-z]+)?(?:@\dx)?(?=\.[a-z0-9]+$)/i, '').replace(/_crop_[a-z]+(?=\.[a-z0-9]+$)/i, '');
    if (q !== p || x.search) out.push(bare(q));
  }
  if (p.includes('/wp-content/uploads/')) {                                                                     // WordPress: logo-300x120.png, -scaled
    const q = p.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, '').replace(/-scaled(?=\.[a-z0-9]+$)/i, '');
    if (q !== p || x.search) out.push(bare(q));
  }
  if (/^i[0-3]\.wp\.com$/.test(h)) out.push('https://' + p.slice(1));                                           // Jetpack's image CDN
  if (h === 'img1.wsimg.com' && p.includes('/:/')) out.push(bare(p.slice(0, p.indexOf('/:/'))));              // GoDaddy: /:/rs=w:300
  if (/website-files\.com$|webflow\.com$/.test(h)) { const q = p.replace(/-p-\d+(?=\.[a-z0-9]+$)/i, ''); if (q !== p) out.push(bare(q)); }  // Webflow -p-500
  if (p.endsWith('/_next/image') && x.searchParams.get('url')) { try { out.push(new URL(x.searchParams.get('url'), x.origin).href); } catch { /* bad url */ } }  // Next.js
  if (h === 'res.cloudinary.com') { const q = p.replace(/\/image\/upload\/(?:[a-z]{1,3}_[^/]+\/)+/i, '/image/upload/'); if (q !== p) out.push(bare(q)); }  // Cloudinary transforms
  if (/[?&](?:w|h|width|height|resize|fit|size|format)=/i.test(x.search) && !p.endsWith('/_next/image')) out.push(bare(p));                   // imgix, Netlify, Vercel…
  return [...new Set(out)].filter(v => v !== u);
}

// Every image address a tag offers (src, lazy-load copies, every srcset
// entry), largest srcset entry first.
function tagSources(tag, before = '') {
  const set = [];
  const fromSrcset = v => v.split(/,\s+(?=\S)/).map(e => { const [u, d] = e.trim().split(/\s+/); return { u, n: parseFloat(d) * (/x$/.test(d || '') ? 1000 : 1) || 0 }; }).filter(e => e.u);
  for (const a of ['srcset', 'data-srcset', 'data-lazy-srcset']) set.push(...fromSrcset(attr(tag, a)));
  // <picture><source srcset> before the <img>
  for (const m of before.matchAll(/<source\b[^>]*>/gi)) set.push(...fromSrcset(attr(m[0], 'srcset') || attr(m[0], 'data-srcset')));
  set.sort((a, b) => b.n - a.n);
  const singles = ['data-orig-file', 'data-large-file', 'data-image', 'data-lazy-src', 'data-original', 'data-src', 'src'].map(a => attr(tag, a)).filter(Boolean);
  return [...new Set([...set.map(e => e.u), ...singles])].filter(u => !u.startsWith('data:image/gif'));
}

// WordPress keeps the site logo and every upload in a public data feed.
async function wordpressLogos(html, pageUrl, brandWord) {
  if (!/wp-content|api\.w\.org/i.test(html)) return [];
  const link = html.match(/<link\b[^>]*rel=["']https:\/\/api\.w\.org\/["'][^>]*>/i);
  const api = link && attr(link[0], 'href') ? new URL(decode(attr(link[0], 'href')), pageUrl).href : new URL('/wp-json/', pageUrl).href;
  const getJson = async u => JSON.parse((await safeGet(u, { accept: 'application/json', maxBytes: 4_000_000, timeoutMs: 6000 })).body.toString('utf8'));
  const route = r => api.includes('rest_route=') ? `${api}${r}` : new URL(r.replace(/^\//, ''), api.endsWith('/') ? api : api + '/').href;
  const out = [];
  const asCandidate = (m, source, score) => {
    const url = m.source_url, mime = String(m.mime_type || '');
    if (!url) return;
    const title = String(m.title?.rendered || m.slug || '');
    if (/^image\//.test(mime)) out.push({ url, kind: /svg/.test(mime) ? 'svg-url' : 'image-url', source, score });
    else if (/pdf|postscript|illustrator|zip/.test(mime)) out.push({ url, file: true, format: /pdf/.test(mime) ? 'pdf' : /zip/.test(mime) ? 'zip' : /illustrator/.test(mime) ? 'ai' : 'eps', name: url.split('/').pop(), source, title });
  };
  try {
    const index = await getJson(api);
    if (index.site_logo) asCandidate(await getJson(route(`/wp/v2/media/${index.site_logo}`)), 'WordPress site logo', 110);
  } catch { /* feed off or no site logo set */ }
  try {
    const list = await getJson(route('/wp/v2/media?search=logo&per_page=30'));
    if (Array.isArray(list)) for (const m of list) asCandidate(m, 'WordPress media library', 60 + (new RegExp(brandWord, 'i').test(m.source_url || '') ? 10 : 0));
  } catch { /* feed off */ }
  return out;
}

// Width and height of a PNG, JPEG, GIF or WebP from its first bytes.
export function imageSize(b) {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };          // PNG IHDR
    if (b[0] === 0x47 && b[1] === 0x49) return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };            // GIF
    if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
      if (kind === 'VP8X') return { w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
    }
    if (b[0] === 0xff && b[1] === 0xd8) {                                                                // JPEG: find a SOF marker
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch { /* unreadable header */ }
  return null;
}
const MAX_FILES = 14;
const MAX_BRAND_PAGES = 3;
// file types worth offering as downloads
const FILE_EXT = /\.(pdf|ai|eps|svgz?|zip)(?:[?#]|$)/i;
// pages that usually hold the logo downloads
const BRAND_PAGE = /press|media|brand|logo|newsroom|identity|guidelines|downloads|assets|presskit|mediakit/i;
// usual addresses for those pages, tried when the home page links to none
const GUESS_PATHS = ['/press', '/brand', '/media-kit', '/press-kit', '/media', '/brand-assets', '/logos', '/about/press'];

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
};
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const looksLogo = s => /logo|brand|wordmark|site-?mark/i.test(s);
const isSvgUrl = u => /\.svgz?(\?|#|$)/i.test(u) || u.startsWith('data:image/svg');
const stripTags = s => decode(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
// a .svgz file is gzipped SVG; some servers also send plain .svg gzipped without saying so
const svgText = buf => (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf, { maxOutputLength: 20e6 }) : buf).toString('utf8');

// Every <svg>…</svg> at the top level, nested ones kept inside their parent.
function inlineSvgs(html) {
  const out = [], re = /<\/?svg\b[^>]*>/gi;
  let depth = 0, start = -1, m;
  while ((m = re.exec(html))) {
    if (m[0][1] !== '/') { if (depth++ === 0) start = m.index; }
    else if (depth > 0 && --depth === 0) out.push({ index: start, svg: html.slice(start, m.index + m[0].length) });
  }
  return out;
}

// Text around a position: the tags just before it, to see if it sits in a header or a "logo" link.
const context = (html, index) => html.slice(Math.max(0, index - 600), index);
const inHeader = (html, index) => {
  const before = html.slice(0, index).toLowerCase();
  return before.lastIndexOf('<header') > before.lastIndexOf('</header') || before.lastIndexOf('<nav') > before.lastIndexOf('</nav');
};

function cleanSvg(svg) {
  return svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href\s*=\s*["'])\s*javascript:[^"']*/gi, '$1#');
}

// An inline SVG must stand alone: give it the SVG namespace, and keep only
// ones with real drawing in them (not a 3-path hamburger icon).
function standaloneSvg(svg) {
  let s = cleanSvg(svg);
  if (!/\sxmlns\s*=/.test(s.slice(0, s.indexOf('>')))) s = s.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  const shapes = (s.match(/<(path|rect|circle|ellipse|polygon|polyline|text)\b/gi) || []).length;
  const d = (s.match(/\sd\s*=\s*"[^"]*"/gi) || []).reduce((n, a) => n + a.length, 0);
  return { svg: s, shapes, weight: d };
}

export async function findLogos(siteUrl) {
  const page = await safeGet(siteUrl, { accept: 'text/html,application/xhtml+xml', maxBytes: 4_000_000 });
  if (!/html|xml/i.test(page.contentType) && !/^\s*</.test(page.body.slice(0, 200).toString())) {
    throw Object.assign(new Error('That address isn\'t a web page.'), { status: 422 });
  }
  const html = page.body.toString('utf8');
  const baseTag = html.match(/<base\b[^>]*>/i);
  const base = baseTag && attr(baseTag[0], 'href') ? new URL(decode(attr(baseTag[0], 'href')), page.url).href : page.url;
  const abs = u => { try { return new URL(decode(u), base).href; } catch { return null; } };
  const host = new URL(page.url).hostname.replace(/^www\./, '');
  const brandWord = host.split('.')[0];

  const found = new Map();   // key -> candidate
  const files = new Map();   // url -> download link
  const add = (key, c) => { const old = found.get(key); if (!old || c.score > old.score) found.set(key, c); };

  // 1. inline SVG in the page
  for (const { index, svg } of inlineSvgs(html)) {
    const { svg: clean, shapes, weight } = standaloneSvg(svg);
    if (!shapes || weight < 120 || clean.length > 400_000) continue;
    const near = context(html, index) + svg.slice(0, svg.indexOf('>'));
    let score = 40;
    if (looksLogo(near.slice(-400)) || new RegExp(brandWord, 'i').test(near.slice(-300))) score += 40;
    if (inHeader(html, index)) score += 25;
    score += Math.min(20, weight / 400) - index / html.length * 15;
    add('inline:' + index, { kind: 'svg', source: 'In the page', score, svg: clean });
  }

  // 2. <img> tags: the largest of every address the tag (and its <picture>) offers
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const pic = html.lastIndexOf('<picture', m.index) > html.lastIndexOf('</picture', m.index) ? html.slice(html.lastIndexOf('<picture', m.index), m.index) : '';
    const srcs = tagSources(tag, pic);
    const src = srcs[0];
    if (!src) continue;
    const url = src.startsWith('data:') ? src : abs(src);
    if (!url) continue;
    const label = [attr(tag, 'alt'), attr(tag, 'class'), attr(tag, 'id'), ...srcs].join(' ');
    const isSvg = isSvgUrl(url);
    const logoish = looksLogo(label) || looksLogo(context(html, m.index).slice(-300)) || new RegExp(brandWord, 'i').test(label);
    if (!isSvg && !logoish) continue;
    let score = (isSvg ? 50 : 20) + (logoish ? 40 : 0) + (inHeader(html, m.index) ? 25 : 0) - m.index / html.length * 15;
    add(url, { kind: isSvg ? 'svg-url' : 'image-url', source: 'Image on the page', score, url });
  }

  // 2b. download links: SVG, PDF, AI, EPS files and zip packs
  collectFiles(html, abs, brandWord, 'Download on the page', false, files);

  // 3. icons and share images in <head>
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0], rel = attr(tag, 'rel').toLowerCase(), href = attr(tag, 'href');
    if (!href || !/icon/.test(rel)) continue;
    const url = abs(href); if (!url) continue;
    const isSvg = /\.svg(\?|#|$)/i.test(url) || /svg/.test(attr(tag, 'type'));
    const sizes = parseInt(attr(tag, 'sizes'), 10) || 0;
    if (!isSvg && sizes && sizes < 120) continue;
    add(url, { kind: isSvg ? 'svg-url' : 'image-url', source: isSvg ? 'Site icon (SVG)' : 'Site icon', score: isSvg ? 45 : 10 + Math.min(10, sizes / 50), url });
  }
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0], prop = (attr(tag, 'property') || attr(tag, 'name')).toLowerCase();
    if (!/^(og:logo|og:image|twitter:image)$/.test(prop)) continue;
    const url = abs(attr(tag, 'content')); if (!url) continue;
    add(url, { kind: /\.svg(\?|#|$)/i.test(url) ? 'svg-url' : 'image-url', source: prop === 'og:logo' ? 'Logo in page details' : 'Share image', score: prop === 'og:logo' ? 35 : 4, url });
  }
  // JSON-LD "logo": "https://…"
  for (const m of html.matchAll(/"logo"\s*:\s*(?:\{[^}]*?"url"\s*:\s*)?"([^"]+)"/gi)) {
    const url = abs(m[1].replace(/\\\//g, '/')); if (!url) continue;
    add(url, { kind: /\.svg(\?|#|$)/i.test(url) ? 'svg-url' : 'image-url', source: 'Logo in page details', score: /\.svg/i.test(url) ? 70 : 30, url });
  }

  // 4. press / brand / media-kit pages: follow a few and collect their downloads
  // 5. WordPress: the site logo and logo uploads from its public media feed
  const [brandPages, wp] = await Promise.all([scanBrandPages(html, page.url, abs, brandWord, files, add), wordpressLogos(html, page.url, brandWord)]);
  for (const c of wp) {
    if (c.file) { if (!files.has(c.url)) files.set(c.url, { format: c.format, source: c.source, url: c.url, name: decodeURIComponent(c.name).slice(0, 120), score: 95, maybe: false }); }
    else add(c.url, { kind: c.kind, source: c.source, score: c.score, url: c.url });
  }

  // Fetch the best few, 4 at a time. SVGs come back as text; pictures as
  // data URIs. For each picture the original upload is tried too, and the
  // bigger one kept.
  const ranked = [...found.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES * 3);
  const results = [];
  let tooSmall = 0;
  const fetchOne = async c => {
    try {
      if (c.kind === 'svg') return { type: 'svg', source: c.source, svg: c.svg, score: c.score };
      if (c.url.startsWith('data:')) {
        if (c.url.startsWith('data:image/svg')) {
          const comma = c.url.indexOf(','), meta = c.url.slice(0, comma);
          const text = /;base64/.test(meta) ? Buffer.from(c.url.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(c.url.slice(comma + 1));
          return { type: 'svg', source: c.source, svg: cleanSvg(text), score: c.score };
        }
        if (c.url.length >= 2_800_000) return null;
        const size = imageSize(Buffer.from(c.url.slice(c.url.indexOf(',') + 1), 'base64'));
        if (size && Math.max(size.w, size.h) < MIN_PICTURE) { tooSmall++; return null; }
        return { type: 'image', source: c.source, dataUrl: c.url, ...(size || {}), score: c.score };
      }
      let best = null;
      for (const u of [...originalUrls(c.url), c.url]) {
        let res;
        try { res = await safeGet(u, { maxBytes: 4_000_000, timeoutMs: 8000 }); } catch { continue; }
        const type = res.contentType.split(';')[0].trim().toLowerCase();
        const gz = res.body[0] === 0x1f && res.body[1] === 0x8b;
        const text = gz ? '' : res.body.slice(0, 600).toString('utf8');
        if (type === 'image/svg+xml' || /<svg\b/i.test(text) || gz && isSvgUrl(u)) return { type: 'svg', source: c.source, svg: cleanSvg(svgText(res.body)), url: u, score: c.score };
        if (!/^image\/(png|jpe?g|webp|gif)$/.test(type)) continue;
        const size = imageSize(res.body) || { w: 0, h: 0 };
        if (!best || size.w * size.h > best.w * best.h) best = { type: 'image', source: c.source, dataUrl: `data:${type};base64,${res.body.toString('base64')}`, url: u, ...size, original: u !== c.url, score: c.score };
      }
      if (!best) return null;
      if (best.w && Math.max(best.w, best.h) < MIN_PICTURE) { tooSmall++; return null; }
      if (best.original) best.source += ' (original upload)';
      return best;
    } catch { return null; }
  };
  for (let i = 0; i < ranked.length && results.length < MAX_CANDIDATES; i += 4) {
    results.push(...(await Promise.all(ranked.slice(i, i + 4).map(fetchOne))).filter(Boolean));
  }
  // bigger pictures first among pictures of the same rank
  const sizeBonus = r => r.type !== 'image' ? 0 : Math.max(r.w || 0, r.h || 0) >= 2000 ? 20 : Math.max(r.w || 0, r.h || 0) >= 1000 ? 10 : 0;
  results.sort((a, b) => (b.score + sizeBonus(b)) - (a.score + sizeBonus(a)));
  results.splice(MAX_CANDIDATES);
  for (const r of results) delete r.score;
  // the same artwork can turn up twice (inline and as a file)
  const seen = new Set();
  return {
    site: page.url, host, brandPages, tooSmall, minPicture: MIN_PICTURE,
    candidates: results.filter(r => { const k = (r.svg || r.dataUrl).slice(0, 4000); if (seen.has(k)) return false; seen.add(k); return true; }),
    // downloads aren't fetched now: the app fetches one when it's picked
    files: [...files.values()].sort((a, b) => b.score - a.score).slice(0, MAX_FILES)
      .map(({ format, source, url, name, maybe }) => ({ type: 'file', format, source, url, name, maybe: !!maybe })),
  };
}

// Links to logo files. On a brand page every file link counts; elsewhere
// ones that mention the logo or brand. Other PDFs (menus, brochures) come
// last, marked as maybe.
function collectFiles(html, abs, brandWord, source, onBrandPage, files) {
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = decode(attr(m[0], 'href'));
    const url = href && abs(href);
    if (!url || !/^https?:/.test(url)) continue;
    const path = new URL(url).pathname;
    const ext = (path.match(FILE_EXT) || [])[1];
    const dl = attr(m[0], 'download');
    if (!ext && !/\.(pdf|ai|eps|svgz?|zip)$/i.test(dl)) continue;
    const format = (ext || dl.match(/\.(\w+)$/)[1]).toLowerCase().replace('svgz', 'svg');
    const close = html.indexOf('</a', m.index);
    const text = stripTags(html.slice(m.index, close > 0 && close - m.index < 2000 ? close : m.index + 300));
    const label = [path, dl, attr(m[0], 'title'), attr(m[0], 'aria-label'), text].join(' ');
    const logoish = looksLogo(label) || /\bmark\b|identity|vector|wordmark|lockup|emblem|crest/i.test(label);
    const brandish = new RegExp(brandWord, 'i').test(label);
    const document = /menu|brochure|catalogue|catalog|price|report|newsletter|flyer|leaflet|timetable/i.test(label);
    const likely = logoish || (onBrandPage && !document && (brandish || format !== 'pdf' || /kit|asset|press|media/i.test(label)));
    // Any other PDF on the site (a menu, brochure, price list, letterhead)
    // usually has the logo on it as vector artwork: offered last, as a maybe.
    // Forms, policies and CVs rarely carry a usable logo.
    const maybe = !likely && (format === 'pdf' || format === 'ai') && !/terms|policy|privacy|gdpr|cookie|cv\b|resume|application|form\b|careers?|jobs?/i.test(label);
    if (!likely && !maybe) continue;
    let score = likely ? 50 + (logoish ? 40 : 0) + (brandish ? 10 : 0) + (onBrandPage ? 10 : 0) : 5 + (brandish ? 3 : 0);
    score += { ai: 25, eps: 22, pdf: 20, svg: 18, zip: 8 }[format] || 0;   // master artwork formats first
    if (/white|reverse|negative|knock|mono|black/i.test(label)) score -= 4;   // the usual full-colour version first
    const name = decodeURIComponent(path.split('/').pop() || dl || 'logo.' + format) || 'logo.' + format;
    const old = files.get(url);
    if (!old || old.score < score) files.set(url, { format, source: maybe ? 'Other PDF on the site, may contain the logo' : source, url, name: name.slice(0, 120), score, label: text.slice(0, 80), maybe });
  }
}

async function scanBrandPages(html, siteUrl, abs, brandWord, files, add) {
  const site = new URL(siteUrl), sameSite = u => u.hostname.replace(/^www\./, '') === site.hostname.replace(/^www\./, '');
  const links = new Map();
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = decode(attr(m[0], 'href'));
    const url = href && !href.startsWith('#') && abs(href);
    if (!url || !/^https?:/.test(url)) continue;
    const u = new URL(url); u.hash = '';
    if (!sameSite(u) || FILE_EXT.test(u.pathname) || u.pathname === site.pathname) continue;
    const close = html.indexOf('</a', m.index);
    const text = stripTags(html.slice(m.index, close > 0 && close - m.index < 1500 ? close : m.index + 200));
    const label = u.pathname + ' ' + text + ' ' + attr(m[0], 'title');
    if (!BRAND_PAGE.test(label) || /release|article|news\/\d|blog|careers|jobs|privacy|cookie|login|cart/i.test(u.pathname)) continue;
    const score = (/press-?kit|media-?kit|brand-?(assets|kit|guidelines|resources)|logos?\b/i.test(label) ? 30 : 0)
      + (/brand|press|media/i.test(u.pathname) ? 10 : 0) - u.pathname.split('/').length;
    const key = u.href;
    if (!links.has(key) || links.get(key) < score) links.set(key, score);
  }
  let targets = [...links.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_BRAND_PAGES).map(e => e[0]);
  const guessed = !targets.length;
  if (guessed) targets = GUESS_PATHS.map(p => new URL(p, site.origin).href);
  const visited = [];
  await Promise.all(targets.map(async target => {
    try {
      const res = await safeGet(target, { accept: 'text/html', maxBytes: 3_000_000, timeoutMs: guessed ? 5000 : 8000, maxRedirects: 3 });
      if (res.status >= 400 || !/html/i.test(res.contentType)) return;
      const landed = new URL(res.url);
      // a guessed address that just redirects home isn't a brand page
      if (!sameSite(landed) || landed.pathname === '/' || landed.pathname === site.pathname) return;
      const page = res.body.toString('utf8');
      const absHere = u => { try { return new URL(decode(u), res.url).href; } catch { return null; } };
      const label = 'Brand page ' + landed.pathname.replace(/\/$/, '');
      const before = files.size;
      collectFiles(page, absHere, brandWord, label, true, files);
      // logo pictures shown on the brand page (often the SVG preview of each download)
      for (const m of page.matchAll(/<img\b[^>]*>/gi)) {
        const src = attr(m[0], 'src') || attr(m[0], 'data-src');
        const url = src && !src.startsWith('data:') && absHere(src);
        if (!url || !isSvgUrl(url)) continue;
        const l = [attr(m[0], 'alt'), attr(m[0], 'class'), src].join(' ');
        if (looksLogo(l) || new RegExp(brandWord, 'i').test(l)) add(url, { kind: 'svg-url', source: label, score: 85, url });
      }
      visited.push({ url: res.url, files: files.size - before });
    } catch { /* missing or slow page: skip */ }
  }));
  return visited;
}
