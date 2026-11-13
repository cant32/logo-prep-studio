// PDF and Illustrator files (modern .ai files are PDFs inside), read with
// pdf.js in the browser. For each page we can tell whether the logo is real
// vector artwork or a picture pasted in, and get at either one.
// pdfjsLib is loaded as a global by index.html.

import { assetUrl } from './assets.js';

let configured = false;
function lib() {
  if (!configured) {
    const src = assetUrl('vendor/pdfjs/pdf.worker.min.js');
    pdfjsLib.GlobalWorkerOptions.workerSrc = src;
    // Opened straight from disk the page has no web origin, and pdf.js would
    // refuse its own worker; creating it here and handing it over works.
    if (location.protocol === 'file:') {
      try { pdfjsLib.GlobalWorkerOptions.workerPort = new Worker(src); } catch (e) { console.warn('PDF worker unavailable', e); }
    }
    configured = true;
  }
  return pdfjsLib;
}

export async function openPdf(buffer) {
  return lib().getDocument({ data: new Uint8Array(buffer), isEvalSupported: false }).promise;
}

// What's on a page: embedded pictures, vector drawing and live text.
export async function inspectPage(doc, n = 1) {
  const pdf = lib(), page = await doc.getPage(n);
  const ops = await page.getOperatorList();
  const O = pdf.OPS, images = [], seen = new Set();
  let paths = 0, text = 0;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === O.paintImageXObject || fn === O.paintImageXObjectRepeat) {
      const name = ops.argsArray[i][0];
      if (seen.has(name)) continue;
      seen.add(name);
      const img = await getImage(page, name).catch(() => null);
      if (img && img.width * img.height >= 64 * 64) images.push({ name, width: img.width, height: img.height });
    } else if (fn === O.constructPath) paths++;
    else if (fn === O.showText || fn === O.showSpacedText) text++;
  }
  return { page, ops, images, paths, text, pages: doc.numPages };
}

function getImage(page, name) {
  const store = name.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve, reject) => {
    try { store.get(name, resolve); } catch (e) { reject(e); }
    setTimeout(() => reject(new Error('image not ready')), 8000);
  });
}

// An embedded picture as ImageData, at its own full resolution.
export async function imageData(page, name) {
  const img = await getImage(page, name);
  const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d');
  if (img.bitmap) { x.drawImage(img.bitmap, 0, 0); return x.getImageData(0, 0, img.width, img.height); }
  const out = x.createImageData(img.width, img.height), d = img.data, o = out.data, n = img.width * img.height;
  if (img.kind === 3) o.set(d.subarray(0, n * 4));
  else if (img.kind === 2) for (let i = 0; i < n; i++) { o[i * 4] = d[i * 3]; o[i * 4 + 1] = d[i * 3 + 1]; o[i * 4 + 2] = d[i * 3 + 2]; o[i * 4 + 3] = 255; }
  else {   // 1 bit per pixel greyscale
    const row = (img.width + 7) >> 3;
    for (let y = 0; y < img.height; y++) for (let xx = 0; xx < img.width; xx++) {
      const v = (d[y * row + (xx >> 3)] >> (7 - (xx & 7))) & 1 ? 255 : 0, i = (y * img.width + xx) * 4;
      o[i] = o[i + 1] = o[i + 2] = v; o[i + 3] = 255;
    }
  }
  return out;
}

// The page's vector drawing as an SVG string, cropped to the artwork.
export async function pageSvg({ page, ops }) {
  const vp = page.getViewport({ scale: 1 });
  const gfx = new (lib().SVGGraphics)(page.commonObjs, page.objs, true);
  gfx.embedFonts = true;
  const el = await gfx.getSVG(ops, vp);
  return new XMLSerializer().serializeToString(el);
}

// The whole page rendered to pixels (long side `size`), transparent where
// the page is empty, trimmed to the artwork.
// Render the page's artwork so its longest side is `size` pixels. A quick
// small render finds where the artwork sits; then only that area is drawn at
// full resolution. (Drawing the whole page and trimming left a small logo on
// an A4 letterhead at a few hundred pixels.)
export async function renderPage(page, size = 2400) {
  const base = page.getViewport({ scale: 1 });
  const draw = async (vp, w, h) => {   // used for the quick look only
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const x = c.getContext('2d', { willReadFrequently: true });
    await page.render({ canvasContext: x, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    return x.getImageData(0, 0, w, h);
  };
  // 1. where is the artwork?
  const s0 = 800 / Math.max(base.width, base.height), vp0 = page.getViewport({ scale: s0 });
  const small = await draw(vp0, Math.ceil(vp0.width), Math.ceil(vp0.height));
  const box = inkBox(small);
  if (!box) return trim(small);
  // 2. just that area, a little margin round it, at full size
  const m = 3;   // px at the small scale
  const rx = Math.max(0, box.l - m) / s0, ry = Math.max(0, box.t - m) / s0;
  const rw = Math.min(small.width, box.r + m + 1) / s0 - rx, rh = Math.min(small.height, box.b + m + 1) / s0 - ry;
  let s1 = size / Math.max(rw, rh);
  s1 = Math.min(s1, 16000 / Math.max(base.width, base.height) * 4);   // keep the maths sane on huge pages
  return renderRegion(page, { x: rx, y: ry, w: rw, h: rh }, size);
}

// Draw one area of the page (in page units) so its longest side is `size`
// pixels. The result remembers which area of the page it shows (`region`),
// so a later crop can be re-drawn sharp from the PDF.
export async function renderRegion(page, region, size = 2400) {
  const base = page.getViewport({ scale: 1 });
  const s1 = Math.min(size / Math.max(region.w, region.h), 64000 / Math.max(base.width, base.height));
  const w = Math.max(1, Math.ceil(region.w * s1)), h = Math.max(1, Math.ceil(region.h * s1));
  const vp = page.getViewport({ scale: s1, offsetX: -region.x * s1, offsetY: -region.y * s1 });
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: x, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
  const out = trim(x.getImageData(0, 0, w, h));
  const o = out.offset || { l: 0, t: 0 };
  out.region = { x: region.x + o.l / s1, y: region.y + o.t / s1, w: out.width / s1, h: out.height / s1 };
  return out;
}

// Bounding box of the non-empty (not transparent, not white) pixels.
function inkBox(id) {
  const { width: w, height: h, data: d } = id;
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (d[i + 3] < 10 || (d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248)) continue;
    if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
  }
  return r < 0 ? null : { l, t, r, b };
}

// Crop away empty (transparent or white) margins, keeping a small border.
export function trim(id, pad = 8) {
  const { width: w, height: h, data: d } = id;
  const empty = i => d[i + 3] < 10 || (d[i] > 248 && d[i + 1] > 248 && d[i + 2] > 248);
  let l = w, t = h, r = -1, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!empty((y * w + x) * 4)) {
    if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y;
  }
  if (r < 0) return id;
  l = Math.max(0, l - pad); t = Math.max(0, t - pad); r = Math.min(w - 1, r + pad); b = Math.min(h - 1, b + pad);
  const c = new OffscreenCanvas(w, h); c.getContext('2d').putImageData(id, 0, 0);
  const out = c.getContext('2d').getImageData(l, t, r - l + 1, b - t + 1);
  out.offset = { l, t };
  return out;
}
