// Find a company's logo on its website. Reads the page's HTML (no browser, so
// sites that only draw their header with JavaScript may show just fallbacks)
// and ranks what it finds: SVG first, the header and anything called "logo"
// above the rest, raster icons last.

import { safeGet } from './safe-fetch.js';

const MAX_CANDIDATES = 8;

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[2] ?? m[3] ?? m[4] ?? '').trim() : '';
};
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const looksLogo = s => /logo|brand|wordmark|site-?mark/i.test(s);

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

  // 2. <img> tags, srcset, data-src
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const src = attr(tag, 'src') || attr(tag, 'data-src') || (attr(tag, 'srcset').split(/\s+/)[0] || '');
    if (!src || src.startsWith('data:image/gif')) continue;
    const url = src.startsWith('data:') ? src : abs(src);
    if (!url) continue;
    const label = [attr(tag, 'alt'), attr(tag, 'class'), attr(tag, 'id'), src].join(' ');
    const isSvg = /\.svg(\?|#|$)/i.test(url) || url.startsWith('data:image/svg');
    const logoish = looksLogo(label) || looksLogo(context(html, m.index).slice(-300)) || new RegExp(brandWord, 'i').test(label);
    if (!isSvg && !logoish) continue;
    let score = (isSvg ? 50 : 20) + (logoish ? 40 : 0) + (inHeader(html, m.index) ? 25 : 0) - m.index / html.length * 15;
    add(url, { kind: isSvg ? 'svg-url' : 'image-url', source: 'Image on the page', score, url });
  }

  // 2b. links straight to .svg files (download links, file listings)
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(m[0], 'href');
    if (!/\.svgz?(\?|#|$)/i.test(href)) continue;
    const url = abs(href); if (!url) continue;
    const label = [href, attr(m[0], 'title'), attr(m[0], 'class'), html.slice(m.index, m.index + 300).replace(/<[^>]+>/g, ' ')].join(' ');
    const score = 30 + (looksLogo(label) ? 40 : 0) + (new RegExp(brandWord, 'i').test(label) ? 15 : 0) - m.index / html.length * 10;
    add(url, { kind: 'svg-url', source: 'Linked SVG file', score, url });
  }

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

  // Fetch the best few. SVGs come back as text; pictures as data URIs.
  const ranked = [...found.values()].sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES * 2);
  const results = [];
  for (const c of ranked) {
    if (results.length >= MAX_CANDIDATES) break;
    try {
      if (c.kind === 'svg') { results.push({ type: 'svg', source: c.source, svg: c.svg }); continue; }
      if (c.url.startsWith('data:')) {
        if (c.url.startsWith('data:image/svg')) {
          const comma = c.url.indexOf(','), meta = c.url.slice(0, comma);
          const text = /;base64/.test(meta) ? Buffer.from(c.url.slice(comma + 1), 'base64').toString('utf8') : decodeURIComponent(c.url.slice(comma + 1));
          results.push({ type: 'svg', source: c.source, svg: cleanSvg(text) });
        } else if (c.url.length < 2_800_000) results.push({ type: 'image', source: c.source, dataUrl: c.url });
        continue;
      }
      const res = await safeGet(c.url, { maxBytes: 2_000_000, timeoutMs: 8000 });
      const type = res.contentType.split(';')[0].trim().toLowerCase();
      const text = res.body.slice(0, 600).toString('utf8');
      if (type === 'image/svg+xml' || /<svg\b/i.test(text)) {
        results.push({ type: 'svg', source: c.source, svg: cleanSvg(res.body.toString('utf8')), url: c.url });
      } else if (/^image\/(png|jpe?g|webp|gif)$/.test(type)) {
        results.push({ type: 'image', source: c.source, dataUrl: `data:${type};base64,${res.body.toString('base64')}`, url: c.url });
      }
    } catch { /* skip candidates that don't load */ }
  }
  // the same artwork can turn up twice (inline and as a file)
  const seen = new Set();
  return {
    site: page.url, host,
    candidates: results.filter(r => { const k = (r.svg || r.dataUrl).slice(0, 4000); if (seen.has(k)) return false; seen.add(k); return true; }),
  };
}
