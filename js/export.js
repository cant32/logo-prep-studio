// Print-ready exports. Everything is sized in real millimetres from the
// print width the user enters; vector files keep one group per ink.

import { util } from '../vendor/fabric.min.js';
import { normColor } from './editor.js';

const ID = [1, 0, 0, 1, 0, 0];

// Bounds of everything visible, in canvas units.
export function bounds(leaves) {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (const o of leaves) for (const p of o.getCoords()) {
    l = Math.min(l, p.x); t = Math.min(t, p.y); r = Math.max(r, p.x); b = Math.max(b, p.y);
  }
  return l === Infinity ? null : { x: l, y: t, w: r - l, h: b - t };
}

// opts.mode: 'color' | 'single' (every ink -> one colour) | 'outline' (cut lines)
// opts.only: keep just this ink (for separations)   opts.mirror: flip for transfers
export function buildSVG(editor, { widthMm, mode = 'color', color = '#000000', only = null, mirror = false, strokeMm = 0.02 } = {}) {
  const leaves = editor.leaves().filter(o => o.visible && (normColor(o.fill) || normColor(o.stroke)));
  const box = bounds(leaves);
  if (!box) return null;
  const pxPerMm = box.w / widthMm, heightMm = box.h / pxPerMm;
  const byInk = new Map();
  for (const o of leaves) {
    const ink = normColor(o.fill) || normColor(o.stroke);
    if (only && ink !== only) continue;
    const saved = { fill: o.fill, stroke: o.stroke, strokeWidth: o.strokeWidth };
    if (mode === 'single') {
      if (normColor(o.fill)) o.fill = color;
      if (normColor(o.stroke)) o.stroke = color;
    } else if (mode === 'outline') {
      const scale = util.qrDecompose(o.calcTransformMatrix()).scaleX || 1;
      o.stroke = color === 'ink' ? ink : color;
      o.strokeWidth = strokeMm * pxPerMm / scale;
      o.fill = '';   // Fabric writes an empty fill as fill:none (a 'none' string would become black)
    }
    const m = o.group ? o.group.calcTransformMatrix() : ID;
    const el = `<g transform="matrix(${m.map(v => +v.toFixed(5)).join(' ')})">${o.toSVG()}</g>`;
    Object.assign(o, saved);
    if (!byInk.has(ink)) byInk.set(ink, []);
    byInk.get(ink).push(el);
  }
  const groups = [...byInk].map(([ink, els]) => `<g id="ink-${ink.slice(1)}">${els.join('')}</g>`).join('');
  const flip = mirror ? ` transform="matrix(-1 0 0 1 ${+(2 * box.x + box.w).toFixed(3)} 0)"` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${+widthMm.toFixed(3)}mm" height="${+heightMm.toFixed(3)}mm" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><g${flip}>${groups}</g></svg>`;
  return { svg, widthMm, heightMm, inks: [...byInk.keys()] };
}

// When hosted as a claude.ai artifact, files go through the viewer's save
// prompt; run locally, a normal browser download is used.
const hostDownloads = window.claude?.use ? window.claude.use('downloads').catch(() => null) : Promise.resolve(null);

export async function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const host = await hostDownloads;
  if (host) {
    try { await host.save({ filename: name, data: blob }); return 'saved'; }
    catch (e) { if (e && e.code === 'declined') return 'declined'; throw new Error(e?.message || 'the file could not be saved'); }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export async function svgToCanvas(svg, w, h) {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  URL.revokeObjectURL(img.src);
  return c;
}

// Transparent PNG at the given DPI, with the DPI written into the file so
// RIP / print software picks up the right physical size.
export async function pngBlob(built, dpi = 300) {
  const max = 12000;
  let w = Math.round(built.widthMm / 25.4 * dpi), h = Math.round(built.heightMm / 25.4 * dpi);
  if (Math.max(w, h) > max) { const s = max / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); dpi *= s; }
  const c = await svgToCanvas(built.svg, w, h);
  const blob = await new Promise(r => c.toBlob(r, 'image/png'));
  return { blob: await withDpi(blob, dpi), w, h, dpi: Math.round(dpi) };
}

async function withDpi(blob, dpi) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(21);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4);   // 'pHYs'
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const at = 33;  // straight after the IHDR chunk
  return new Blob([buf.subarray(0, at), chunk, buf.subarray(at)], { type: 'image/png' });
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function svgElement(svg) {
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-99999px;top:0;width:10px;height:10px;overflow:hidden';
  holder.innerHTML = svg;
  document.body.appendChild(holder);
  return { el: holder.firstElementChild, done: () => holder.remove() };
}

async function addSvgPage(doc, svg, x, y, w, h) {
  const { el, done } = svgElement(svg);
  try { await window.svg2pdf.svg2pdf(el, doc, { x, y, width: w, height: h }); } finally { done(); }
}

// Vector PDF at actual size with a small margin.
export async function pdfBlob(built, marginMm = 5) {
  const { jsPDF } = window.jspdf;
  const W = built.widthMm + marginMm * 2, H = built.heightMm + marginMm * 2;
  const doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: W > H ? 'l' : 'p', compress: true });
  await addSvgPage(doc, built.svg, marginMm, marginMm, built.widthMm, built.heightMm);
  return doc.output('blob');
}

// Screen-print separations: one page per ink, printed solid black as a film
// positive, with registration marks so the screens line up.
export async function separationsBlob(editor, opts, inkNames = {}) {
  const { jsPDF } = window.jspdf;
  const full = buildSVG(editor, opts);
  const m = 15, W = full.widthMm + m * 2, H = full.heightMm + m * 2;
  const doc = new jsPDF({ unit: 'mm', format: [W, H], orientation: W > H ? 'l' : 'p', compress: true });
  for (let i = 0; i < full.inks.length; i++) {
    const ink = full.inks[i];
    if (i) doc.addPage([W, H], W > H ? 'l' : 'p');
    const sep = buildSVG(editor, { ...opts, mode: 'single', color: '#000000', only: ink });
    // keep every page on the full artwork's frame so the screens register
    const frame = full.svg.match(/viewBox="([^"]+)"/)[1];
    await addSvgPage(doc, sep.svg.replace(/viewBox="[^"]+"/, `viewBox="${frame}"`), m, m, full.widthMm, full.heightMm);
    doc.setDrawColor(0); doc.setLineWidth(0.15);
    for (const [cx, cy] of [[m / 2, m / 2], [W - m / 2, m / 2], [m / 2, H - m / 2], [W - m / 2, H - m / 2]]) {
      doc.circle(cx, cy, 2.2); doc.line(cx - 4, cy, cx + 4, cy); doc.line(cx, cy - 4, cx, cy + 4);
    }
    doc.setFontSize(8); doc.setTextColor(0);
    doc.text(`Ink ${i + 1} of ${full.inks.length}: ${inkNames[ink] || ink.toUpperCase()}   |   ${full.widthMm.toFixed(0)} × ${full.heightMm.toFixed(0)} mm`, m, H - 3);
  }
  return { blob: doc.output('blob'), inks: full.inks };
}

// EPS (vector PostScript), still the format many suppliers ask for. Same
// modes as buildSVG; colours are RGB, sized in points from the print width.
export function buildEPS(editor, { widthMm, mode = 'color', color = '#000000', mirror = false, strokeMm = 0.02 } = {}) {
  const leaves = editor.leaves().filter(o => o.visible && (normColor(o.fill) || normColor(o.stroke)));
  const box = bounds(leaves);
  if (!box) return null;
  const pxPerMm = box.w / widthMm, k = 72 / 25.4 / pxPerMm;
  const W = box.w * k, H = box.h * k;
  const pt = (x, y) => {
    if (mirror) x = 2 * box.x + box.w - x;
    return `${((x - box.x) * k).toFixed(3)} ${((box.y + box.h - y) * k).toFixed(3)}`;
  };
  const rgb = hex => [1, 3, 5].map(i => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(4)).join(' ');
  const out = [], skipped = new Set();
  for (const o of leaves) {
    const cmds = toPathCommands(o);
    if (!cmds) { skipped.add(o.type); continue; }
    const m = util.multiplyTransformMatrices(o.calcTransformMatrix(), [1, 0, 0, 1, -(o.pathOffset?.x || 0), -(o.pathOffset?.y || 0)]);
    const T = (x, y) => { const p = util.transformPoint({ x, y }, m); return pt(p.x, p.y); };
    const ps = ['newpath'];
    let cx = 0, cy = 0, sx = 0, sy = 0;
    for (const c of cmds) {
      if (c[0] === 'M') { ps.push(`${T(c[1], c[2])} moveto`); cx = sx = c[1]; cy = sy = c[2]; }
      else if (c[0] === 'L') { ps.push(`${T(c[1], c[2])} lineto`); cx = c[1]; cy = c[2]; }
      else if (c[0] === 'C') { ps.push(`${T(c[1], c[2])} ${T(c[3], c[4])} ${T(c[5], c[6])} curveto`); cx = c[5]; cy = c[6]; }
      else if (c[0] === 'Q') {   // quadratic -> cubic
        const c1 = [cx + 2 / 3 * (c[1] - cx), cy + 2 / 3 * (c[2] - cy)], c2 = [c[3] + 2 / 3 * (c[1] - c[3]), c[4] + 2 / 3 * (c[2] - c[4])];
        ps.push(`${T(...c1)} ${T(...c2)} ${T(c[3], c[4])} curveto`); cx = c[3]; cy = c[4];
      } else if (c[0] === 'Z' || c[0] === 'z') { ps.push('closepath'); cx = sx; cy = sy; }
    }
    const ink = normColor(o.fill) || normColor(o.stroke);
    if (mode === 'outline') {
      ps.push(`${rgb(color === 'ink' ? ink : color)} setrgbcolor ${(strokeMm * 72 / 25.4).toFixed(4)} setlinewidth stroke`);
    } else {
      const fill = mode === 'single' ? color : normColor(o.fill);
      const stroke = normColor(o.stroke) && o.strokeWidth > 0 ? (mode === 'single' ? color : normColor(o.stroke)) : null;
      if (fill && stroke) ps.push('gsave');
      if (fill) ps.push(`${rgb(fill)} setrgbcolor ${o.fillRule === 'evenodd' ? 'eofill' : 'fill'}`);
      if (fill && stroke) ps.push('grestore');
      if (stroke) ps.push(`${rgb(stroke)} setrgbcolor ${(o.strokeWidth * util.qrDecompose(m).scaleX * k).toFixed(4)} setlinewidth stroke`);
    }
    out.push(`% ink ${ink}\n` + ps.join('\n'));
  }
  const eps = ['%!PS-Adobe-3.0 EPSF-3.0', `%%BoundingBox: 0 0 ${Math.ceil(W)} ${Math.ceil(H)}`, `%%HiResBoundingBox: 0 0 ${W.toFixed(3)} ${H.toFixed(3)}`,
    '%%Creator: Logo Prep Studio', '%%LanguageLevel: 2', '%%Pages: 1', '%%EndComments', '%%Page: 1 1', 'gsave', ...out, 'grestore', 'showpage', '%%EOF', ''].join('\n');
  return { eps, skipped: [...skipped] };
}

// Path commands (M L C Q Z) in the object's own coordinates, or null for
// things that aren't shapes (pictures, live text).
function toPathCommands(o) {
  if (o.path) return o.path;
  const K = 0.5523;
  if (o.type === 'rect') { const w = o.width / 2, h = o.height / 2; return [['M', -w, -h], ['L', w, -h], ['L', w, h], ['L', -w, h], ['Z']]; }
  if (o.type === 'circle' || o.type === 'ellipse') {
    const rx = o.rx ?? o.radius, ry = o.ry ?? o.radius;
    return [['M', rx, 0], ['C', rx, ry * K, rx * K, ry, 0, ry], ['C', -rx * K, ry, -rx, ry * K, -rx, 0],
      ['C', -rx, -ry * K, -rx * K, -ry, 0, -ry], ['C', rx * K, -ry, rx, -ry * K, rx, 0], ['Z']];
  }
  if (o.points) {   // polygon / polyline: points are in the parent's space, offset by pathOffset
    const p = o.points.map((q, i) => [i ? 'L' : 'M', q.x, q.y]);
    if (o.type === 'polygon') p.push(['Z']);
    return p;
  }
  if (o.type === 'line') { const l = o.calcLinePoints(); return [['M', l.x1, l.y1], ['L', l.x2, l.y2]]; }
  return null;
}
