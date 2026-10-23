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

  const bg = detectBackground(labels, w, h);
  if (o.removeBackground && bg >= 0) labels = removeOuter(labels, w, h, bg);

  const area = new Array(palette.length).fill(0);
  for (let i = 0; i < labels.length; i++) if (labels[i] !== 255) area[labels[i]]++;
  const layers = [];
  for (let k = 0; k < palette.length; k++) {
    if (!area[k]) continue;
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) mask[i] = labels[i] === k ? 1 : 0;
    const paths = traceMask(mask, w, h, { mode: o.mode, speckle: minArea, corner: o.corners });
    if (paths.length) layers.push({ color: hex(palette[k]), area: area[k], paths });
  }
  layers.sort((a, b) => b.area - a.area);
  const body = layers.map(l => `<g fill="${l.color}">${l.paths.join('')}</g>`).join('');
  return {
    width: w, height: h, layers,
    background: bg >= 0 ? hex(palette[bg]) : null,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`,
  };
}
