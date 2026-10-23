// Print checks. Renders the finished design at its real size and looks for
// lines too thin to print, and gaps too narrow to stay open, for the chosen
// method. Limits are typical shop guidance; printers vary, so check with yours.

import { svgToCanvas } from './export.js';

export const METHODS = {
  screen:     { label: 'Screen print',          minLine: 0.3,  minGap: 0.3, maxInks: 6 },
  dtg:        { label: 'Digital print (DTG)',   minLine: 0.3,  minGap: 0.3 },
  dtf:        { label: 'DTF / transfer',        minLine: 0.5,  minGap: 0.4, mirrorHint: false },
  engrave:    { label: 'Laser engrave',         minLine: 0.15, minGap: 0.15, single: true },
  vinyl:      { label: 'Vinyl / HTV cut',       minLine: 1.0,  minGap: 0.8, cut: true },
  lasercut:   { label: 'Laser cut',             minLine: 0.8,  minGap: 0.5, cut: true, single: true },
  embroidery: { label: 'Embroidery',            minLine: 1.2,  minGap: 1.0, maxInks: 8 },
};

// Chamfer distance (in pixels) from each pixel inside `mask` to the nearest
// pixel outside it.
function distance(mask, w, h) {
  const INF = 1e9, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? INF : 0;
  const a = 1, b = Math.SQRT2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x > 0) v = Math.min(v, d[i - 1] + a); else v = Math.min(v, a);
    if (y > 0) { v = Math.min(v, d[i - w] + a); if (x > 0) v = Math.min(v, d[i - w - 1] + b); if (x < w - 1) v = Math.min(v, d[i - w + 1] + b); } else v = Math.min(v, a);
    d[i] = v;
  }
  for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
    const i = y * w + x; if (!d[i]) continue;
    let v = d[i];
    if (x < w - 1) v = Math.min(v, d[i + 1] + a); else v = Math.min(v, a);
    if (y < h - 1) { v = Math.min(v, d[i + w] + a); if (x < w - 1) v = Math.min(v, d[i + w + 1] + b); if (x > 0) v = Math.min(v, d[i + w - 1] + b); } else v = Math.min(v, a);
    d[i] = v;
  }
  return d;
}

// Pixels of `mask` that disappear under a morphological opening of radius r:
// i.e. parts narrower than 2r.
function thinParts(mask, w, h, r) {
  const d = distance(mask, w, h);
  const core = new Uint8Array(w * h);
  for (let i = 0; i < core.length; i++) core[i] = d[i] > r ? 1 : 0;
  const notCore = new Uint8Array(w * h);
  for (let i = 0; i < core.length; i++) notCore[i] = core[i] ? 0 : 1;
  const dc = distance(notCore, w, h);
  const thin = new Uint8Array(w * h);
  let n = 0;
  for (let i = 0; i < thin.length; i++) if (mask[i] && dc[i] > r + 1) { thin[i] = 1; n++; }
  return { thin, n };
}

export async function runChecks(built, method) {
  const M = METHODS[method];
  const res = Math.min(12, 2400 / Math.max(built.widthMm, built.heightMm));   // px per mm
  const dw = Math.max(8, Math.round(built.widthMm * res)), dh = Math.max(8, Math.round(built.heightMm * res));
  // pad so open space round the design never looks like a narrow gap
  const pad = Math.ceil(Math.max(M.minLine, M.minGap) * res) + 4;
  const w = dw + pad * 2, h = dh + pad * 2;
  const art = await svgToCanvas(built.svg, dw, dh);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(art, pad, pad);
  const data = c.getContext('2d').getImageData(0, 0, w, h).data;

  const ink = new Uint8Array(w * h);
  for (let i = 0; i < ink.length; i++) ink[i] = data[i * 4 + 3] > 127 ? 1 : 0;

  const issues = [];
  const overlay = new ImageData(w, h);
  const paint = (mask, rgb) => { for (let i = 0; i < mask.length; i++) if (mask[i]) { overlay.data.set(rgb, i * 4); overlay.data[i * 4 + 3] = 255; } };

  const lineR = M.minLine / 2 * res;
  if (lineR >= 0.5) {
    const { thin, n } = thinParts(ink, w, h, lineR);
    if (n > res * res * 0.5) {
      issues.push({ level: 'warn', text: `Some lines or details are thinner than ${M.minLine} mm and may not print cleanly (shown in red).` });
      paint(thin, [230, 30, 50]);
    }
  }
  const gapR = M.minGap / 2 * res;
  if (gapR >= 0.5) {
    // only gaps inside the design count, not the open space around it
    const gap = new Uint8Array(w * h);
    for (let i = 0; i < gap.length; i++) gap[i] = ink[i] ? 0 : 1;
    const { thin, n } = thinParts(gap, w, h, gapR);
    if (n > res * res * 0.5) {
      issues.push({ level: 'warn', text: `Some gaps are narrower than ${M.minGap} mm and may fill in (shown in orange).` });
      paint(thin, [245, 140, 0]);
    }
  }
  const inkCount = built.inks.length;
  if (M.maxInks && inkCount > M.maxInks) issues.push({ level: 'warn', text: `${inkCount} colours: more than ${M.maxInks} is costly for ${M.label.toLowerCase()}. Try merging similar colours.` });
  if (M.single && inkCount > 1) issues.push({ level: 'info', text: `${M.label} is one colour: all ${inkCount} colours will be exported as a single colour.` });
  if (method === 'vinyl') issues.push({ level: 'info', text: 'Heat-transfer vinyl is cut from the back: tick "Mirror" when exporting for HTV.' });
  if (method === 'embroidery') issues.push({ level: 'info', text: 'Embroidery needs digitising into stitches; send the SVG/PNG to your digitiser. Keep text at least 5 mm tall.' });
  if (!issues.some(i => i.level === 'warn')) issues.unshift({ level: 'ok', text: `No problems found for ${M.label.toLowerCase()} at ${built.widthMm.toFixed(0)} × ${built.heightMm.toFixed(0)} mm.` });

  const oc = document.createElement('canvas');
  oc.width = w; oc.height = h;
  const ox = oc.getContext('2d');
  ox.globalAlpha = 0.35; ox.drawImage(c, 0, 0); ox.globalAlpha = 1;
  const tmp = document.createElement('canvas'); tmp.width = w; tmp.height = h; tmp.getContext('2d').putImageData(overlay, 0, 0);
  ox.drawImage(tmp, 0, 0);
  return { issues, preview: oc.toDataURL('image/png'), inkCount };
}
