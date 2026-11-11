// Raster logo -> one vector layer per ink.
//
// 1. find the logo's flat colours (palette.js)
// 2. snap every pixel to one of them and tidy edges / specks
// 3. optionally drop the outer background so the logo sits on nothing
// 4. trace each ink on its own with vtracer, so layers never stack and
//    hiding a colour leaves a true knock-out

import initVtracer, { to_svg } from '../vendor/vtracer/vtracer.js';
import { findPalette, snapToPalette } from './palette.js';
import { assetUrl } from './assets.js';

let ready = null;
const init = () => ready || (ready = initVtracer({ module_or_path: assetUrl('vendor/vtracer/vtracer.wasm') }));

export const hex = c => '#' + c.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// The background is the ink touching the image edge the most.
export function detectBackground(labels, w, h) {
  const counts = new Map();
  const add = i => { const l = labels[i]; if (l !== 255) counts.set(l, (counts.get(l) || 0) + 1); };
  for (let x = 0; x < w; x++) { add(x); add((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { add(y * w); add(y * w + w - 1); }
  let best = -1, bn = 0;
  for (const [l, n] of counts) if (n > bn) { bn = n; best = l; }
  // only call it a background if it really frames the logo
  return bn > (w + h) * 2 * 0.5 ? best : -1;
}

// Clear the background colour where it connects to the image edge. The same
// colour inside the logo (white lettering on a badge) is kept.
export function removeOuter(labels, w, h, bg) {
  const out = labels.slice(), stack = [];
  const push = i => { if (out[i] === bg) { out[i] = 255; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  return out;
}

// Smooth colour changes inside the artwork (gradients, shading). The image is
// blurred first so JPEG noise averages out and only gradual changes are
// left; then each ink's solid inside (edges skipped) is checked against the
// ink it was given. Returns the largest share for any one ink: near 0 for
// flat artwork, high when an element has a gradient.
export function measureShading(imageData, labels, palette, w, h) {
  const d = imageData.data, B = 4, R = 8;   // R > B plus soft edges, so edges never leak in
  // box blur via an integral image per channel
  const W = w + 1, sums = [0, 1, 2].map(() => new Float64Array(W * (h + 1)));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    const S = sums[c];
    S[(y + 1) * W + x + 1] = d[(y * w + x) * 4 + c] + S[y * W + x + 1] + S[(y + 1) * W + x] - S[y * W + x];
  }
  const blur = (x, y, c) => {
    const x0 = Math.max(0, x - B), x1 = Math.min(w, x + B + 1), y0 = Math.max(0, y - B), y1 = Math.min(h, y + B + 1), S = sums[c];
    return (S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
  };
  const edgeCount = new Map();
  for (let x = 0; x < w; x++) for (const i of [x, (h - 1) * w + x]) edgeCount.set(labels[i], (edgeCount.get(labels[i]) || 0) + 1);
  const bg = [...edgeCount].sort((a, b) => b[1] - a[1])[0][0];
  const inside = new Map(), off = new Map();
  for (let y = R; y < h - R; y += 2) for (let x = R; x < w - R; x += 2) {
    const i = y * w + x, L = labels[i];
    if (L === 255 || L === bg) continue;
    let solid = true;
    for (let dy = -R; dy <= R && solid; dy += 2) for (let dx = -R; dx <= R; dx += 2) if (labels[i + dy * w + dx] !== L) { solid = false; break; }
    if (!solid) continue;
    inside.set(L, (inside.get(L) || 0) + 1);
    const c = palette[L];
    if (Math.hypot(blur(x, y, 0) - c[0], blur(x, y, 1) - c[1], blur(x, y, 2) - c[2]) > 22) off.set(L, (off.get(L) || 0) + 1);
  }
  let worst = 0;
  for (const [L, n] of inside) if (n >= 150) worst = Math.max(worst, (off.get(L) || 0) / n);
  return worst;
}

// Background colour enclosed by the logo: the middle of an "o" or "e", the
// gap inside a symbol. Those are holes, so the garment should show through,
// not print as white. A piece that is small next to the shape around it
// (white lettering on a coloured badge) is artwork and stays.
export function removeHoles(labels, w, h, bg) {
  const comp = new Int32Array(w * h).fill(-1), info = [], stack = [];
  for (let s = 0; s < w * h; s++) {
    if (comp[s] >= 0 || labels[s] === 255) continue;
    const id = info.length, L = labels[s], c = { L, n: 0, x0: w, x1: 0, y0: h, y1: 0, pixels: L === bg ? [] : null };
    info.push(c); comp[s] = id; stack.push(s);
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      c.n++; if (c.pixels) c.pixels.push(i);
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) {
        if (j >= 0 && comp[j] < 0 && labels[j] === L) { comp[j] = id; stack.push(j); }
      }
    }
  }
  const out = labels.slice(), box = c => (c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1);
  for (const c of info) {
    if (!c.pixels) continue;
    // the shape around it: the neighbour it shares the most edge with
    const around = new Map();
    for (const i of c.pixels) {
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) {
        if (j >= 0 && comp[j] >= 0 && labels[j] !== c.L) around.set(comp[j], (around.get(comp[j]) || 0) + 1);
      }
    }
    if (!around.size) continue;
    const outer = info[[...around].sort((a, b) => b[1] - a[1])[0][0]];
    if (box(c) >= box(outer) * 0.02) for (const i of c.pixels) out[i] = 255;
  }
  return out;
}

function traceMask(mask, w, h, o) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < mask.length; i++) {
    const v = mask[i] ? 0 : 255;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v; px[i * 4 + 3] = 255;
  }
  // vtracer-wasm takes raw units: speckle is an area, angles are radians
  const svg = to_svg(px, w, h, {
    binary: true, mode: o.mode, hierarchical: 'cutout',
    filterSpeckle: o.speckle, colorPrecision: 0, layerDifference: 0,
    cornerThreshold: o.corner * Math.PI / 180, lengthThreshold: 4, maxIterations: 10,
    spliceThreshold: Math.PI / 4, pathPrecision: 2,
  });
  return (svg.match(/<path\b[^>]*\/>/g) || []).map(p => p.replace(/\sfill="[^"]*"/, ''));
}

// opts: { inks: 0 = auto, removeBackground, detail: 1..10, corners: degrees, mode }
export async function vectorise(imageData, opts = {}) {
  await init();
  const { width: w, height: h } = imageData;
  const o = { inks: 0, removeBackground: true, detail: 6, corners: 60, mode: 'spline', ...opts };
  const palette = findPalette(imageData, { count: o.inks });
  // detail 1 (smooth, drops small bits) .. 10 (keeps tiny details)
  const minArea = Math.max(4, Math.round(w * h / (470 * 2 ** (o.detail - 1))));
  let { labels } = snapToPalette(imageData, palette, { minArea });

  const shading = measureShading(imageData, labels, palette, w, h);
  const bg = detectBackground(labels, w, h);
  if (o.removeBackground && bg >= 0) labels = removeHoles(removeOuter(labels, w, h, bg), w, h, bg);

  const area = new Array(palette.length).fill(0);
  for (let i = 0; i < labels.length; i++) if (labels[i] !== 255) area[labels[i]]++;
  const layers = [];
  for (let k = 0; k < palette.length; k++) {
    if (!area[k]) continue;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = labels[i] === k ? 1 : 0;
    // the colour clean-up has already removed real specks (and kept dots), so
    // the tracer only drops crumbs
    const paths = traceMask(mask, w, h, { mode: o.mode, speckle: Math.max(4, Math.round(minArea / 10)), corner: o.corners });
    if (paths.length) layers.push({ color: hex(palette[k]), area: area[k], paths });
  }
  layers.sort((a, b) => b.area - a.area);
  const body = layers.map(l => `<g fill="${l.color}">${l.paths.join('')}</g>`).join('');
  return {
    width: w, height: h, layers, shading,
    // which pixels are logo (background and holes removed), for the gradient PNG
    keep: Uint8Array.from(labels, l => l === 255 ? 0 : 1),
    // smooth colour changes inside the artwork (gradients, shading) that
    // flat inks can only approximate
    gradient: shading > 0.08,
    background: bg >= 0 ? hex(palette[bg]) : null,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`,
  };
}
