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
export async function renderPage(page, size = 2000) {
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: size / Math.max(base.width, base.height) });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
  const x = c.getContext('2d', { willReadFrequently: true });
  await page.render({ canvasContext: x, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
  return trim(x.getImageData(0, 0, c.width, c.height));
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
  return c.getContext('2d').getImageData(l, t, r - l + 1, b - t + 1);
}
