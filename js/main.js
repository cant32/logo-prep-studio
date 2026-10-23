import { Editor, normColor } from './editor.js';
import { upscale, autoScale, resize } from './upscale.js';
import { vectorise } from './trace.js';
import { FONTS, addFontFile } from './text.js';
import { METHODS, runChecks } from './checks.js';
import { buildSVG, buildEPS, download, pngBlob, pdfBlob, separationsBlob } from './export.js';
import { openPdf, inspectPage, imageData as pdfImage, pageSvg, renderPage } from './pdf.js';

const $ = s => document.querySelector(s);
const MAX_INPUT = 2400;       // larger images are scaled down before processing

const state = { name: 'logo', original: null, uncropped: null, sourceUrl: null, upscaled: new Map(), busy: false, afterRun: null };

// ---------------------------------------------------------------- helpers

function toast(msg, ms = 2600) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms);
}
const tick = () => new Promise(r => setTimeout(r, 16));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function openStep(id, { only = false } = {}) {
  const s = $(id); s.removeAttribute('data-disabled');
  if (only) document.querySelectorAll('.step').forEach(x => x.toggleAttribute('data-open', x === s));
  else s.setAttribute('data-open', '');
}
document.querySelectorAll('.step h2').forEach(h => h.addEventListener('click', () => {
  const s = h.parentElement; if (!s.hasAttribute('data-disabled')) s.toggleAttribute('data-open');
  if (s.id === 'step-export' && s.hasAttribute('data-open')) refreshExport();
}));
function progress(pct, text) {
  $('#progress').hidden = pct == null;
  if (pct != null) { $('#bar').style.width = pct + '%'; $('#progressText').textContent = text || ''; }
}

// ---------------------------------------------------------------- editor

const editor = new Editor($('#canvas'), $('#canvasHost'), {
  onChange: () => { $('#undo').disabled = editor.history.length < 2; renderInks(); refreshExportSoon(); },
  onSelect: obj => showTextProps(obj && obj.isText ? obj : null),
});

// ---------------------------------------------------------------- loading

async function loadFile(file) {
  if (!file) return;
  state.name = (file.name || 'logo').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'logo';
  const name = file.name || '';
  $('#pdfChoice').hidden = true;
  if (/\.eps$/i.test(name) || file.type === 'application/postscript' && !/\.ai$/i.test(name)) {
    return toast('EPS files can\'t be opened in the browser. Ask for a PDF, AI, SVG or PNG, or save it as PDF from Illustrator.', 6000);
  }
  if (file.type === 'application/pdf' || /\.(pdf|ai)$/i.test(name)) return loadPdf(file);
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(name)) return loadSvg(await file.text(), file);
  const url = URL.createObjectURL(file);
  const img = new Image(); img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); toast('That file could not be read as an image.'); return; }
  const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, 0, 0);
  setSourceUrl(url);
  vectorCheck('raster', 'Pixel image, not vector: it will be traced to vector for print.');
  useImage(c.getContext('2d').getImageData(0, 0, c.width, c.height), name || 'Pasted image');
}

function setSourceUrl(url) {
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = url;
}

// Start the enhance + trace pipeline on a raster image.
function useImage(id, label, note = '') {
  const s = Math.min(1, MAX_INPUT / Math.max(id.width, id.height));
  if (s < 1) id = resize(id, Math.round(id.width * s), Math.round(id.height * s));
  state.original = id;
  state.uncropped = null;
  state.upscaled.clear();
  if (!state.sourceUrl) setSourceUrl(imageDataUrl(id));
  showSource(label, `${id.width} × ${id.height} px` + (Math.max(id.width, id.height) < 600 ? ' · low-res, will be upscaled' : '') + note);
  $('#cropBtn').hidden = false;
  openStep('#step-enhance', { only: true });
  $('#step-load').setAttribute('data-open', '');
  $('#step-load').setAttribute('data-done', '');
  $('#enhanceHint').textContent = '';
  run();
}

function imageDataUrl(id) {
  const c = document.createElement('canvas'); c.width = id.width; c.height = id.height;
  c.getContext('2d').putImageData(id, 0, 0);
  return c.toDataURL('image/png');
}

// "Is this actually vector?" result shown under the file name.
function vectorCheck(kind, text) {
  const v = $('#vcheck');
  v.hidden = false; v.className = 'vcheck ' + kind; v.textContent = text;
}

// Vector artwork goes straight into the editor, no tracing.
async function useVector(svg, label, info) {
  state.original = null;
  $('#cropBtn').hidden = true;
  showSource(label, info);
  $('#empty').hidden = true;
  editor.clear();
  await editor.setLogo(svg);
  if (editor.removePageBackground()) toast('Removed the white page background behind the logo. Undo brings it back.');
  $('#step-load').setAttribute('data-done', '');
  $('#step-enhance').setAttribute('data-disabled', '');
  $('#step-enhance').removeAttribute('data-open');
  afterLogo();
}

function loadSvg(text, file) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) { toast('That SVG file could not be read.'); return; }
  doc.querySelectorAll('script, foreignObject').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => [...n.attributes].forEach(a => { if (/^on/i.test(a.name)) n.removeAttribute(a.name); }));
  const svg = new XMLSerializer().serializeToString(doc.documentElement);
  setSourceUrl(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })));
  const pictures = doc.querySelectorAll('image').length;
  const shapes = doc.querySelectorAll('path, rect, circle, ellipse, polygon, polyline, line, text').length;
  if (pictures) {
    vectorCheck('warn', `Not true vector: this SVG has ${pictures} picture${pictures > 1 ? 's' : ''} pasted inside it, which suppliers may reject. It has been traced to real vector below.`);
    // a lone pasted-in picture is traced from its own pixels so it can be AI-upscaled
    const img = doc.querySelector('image');
    const href = img.getAttribute('href') || img.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
    const go = pictures === 1 && !shapes && href.startsWith('data:image/')
      ? decodeImage(href) : rasteriseSvg(svg);
    return go.then(id => useImage(id, file.name, ' · traced from SVG'))
      .catch(() => toast('The picture inside this SVG could not be read.'));
  }
  vectorCheck('ok', `True vector: ${shapes} shape${shapes === 1 ? '' : 's'}, no pasted-in pictures.`);
  useVector(svg, file.name, 'Already vector: no tracing needed');
}

async function decodeImage(src) {
  const img = new Image(); img.src = src; await img.decode();
  const c = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
  c.getContext('2d').drawImage(img, 0, 0);
  return c.getContext('2d').getImageData(0, 0, c.width, c.height);
}

async function rasteriseSvg(svg, size = 2000) {
  const img = new Image();
  img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  await img.decode();
  const s = size / Math.max(img.naturalWidth || size, img.naturalHeight || size);
  const c = document.createElement('canvas');
  c.width = Math.round((img.naturalWidth || size) * s); c.height = Math.round((img.naturalHeight || size) * s);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c.getContext('2d').getImageData(0, 0, c.width, c.height);
}

// PDF / AI ------------------------------------------------------------------

async function loadPdf(file) {
  let doc;
  try { doc = await openPdf(await file.arrayBuffer()); }
  catch (e) {
    console.error(e);
    return toast(/\.ai$/i.test(file.name) ? 'This .ai file has no PDF inside it (old Illustrator format). Re-save it with "Create PDF Compatible File" ticked, or export a PDF or SVG.' : 'That PDF could not be read.', 7000);
  }
  state.pdf = { doc, file };
  const sel = $('#pdfPage'); sel.innerHTML = '';
  for (let i = 1; i <= doc.numPages; i++) sel.add(new Option(`Page ${i} of ${doc.numPages}`, i));
  $('#pdfPages').hidden = doc.numPages < 2;
  showPdfPage(1, true);
}

async function showPdfPage(n, auto) {
  const { doc, file } = state.pdf;
  const info = await inspectPage(doc, n);
  state.pdf.info = info;
  const kind = /\.ai$/i.test(file.name) ? 'Illustrator file' : 'PDF';
  const pics = info.images.map(i => `${i.width} × ${i.height} px`).join(', ');
  if (info.images.length && info.paths < 4) vectorCheck('warn', `Not true vector: the logo in this ${kind} is a picture (${pics}). Use the picture below to trace it to real vector.`);
  else if (info.images.length) vectorCheck('warn', `Mixed: vector shapes plus ${info.images.length} pasted-in picture${info.images.length > 1 ? 's' : ''} (${pics}). Suppliers may reject the pictures.`);
  else if (info.paths) vectorCheck('ok', `True vector ${kind}: no pasted-in pictures.` + (info.text ? ' It has live text, so the fonts may be missing at the printer: tracing the page outlines them.' : ''));
  else vectorCheck('warn', `This page has no artwork that could be found.`);

  const box = $('#pdfButtons'); box.innerHTML = '';
  const add = (title, sub, fn) => {
    const b = document.createElement('button');
    b.innerHTML = `<b>${title}</b><span>${sub}</span>`;
    b.addEventListener('click', () => fn().catch(e => { console.error(e); toast('That did not work: ' + e.message, 5000); }));
    box.appendChild(b);
    return fn;
  };
  const label = `${file.name}${doc.numPages > 1 ? ` (page ${n})` : ''}`;
  const actions = {};
  if (info.paths) actions.vector = add('Use the vector artwork', 'Keeps the original shapes exactly, no tracing', async () => {
    setSourceUrl(imageDataUrl(await renderPage(info.page, 600)));
    await useVector(await pageSvg(info), label, `Vector ${kind}: no tracing needed`);
  });
  info.images.forEach((im, i) => {
    actions['img' + i] = add(`Use the picture${info.images.length > 1 ? ' ' + (i + 1) : ''} (${im.width} × ${im.height} px)`, 'Traces the embedded picture at its full resolution', async () => {
      const id = await pdfImage(info.page, im.name);
      setSourceUrl(imageDataUrl(id));
      useImage(id, label, ' · picture from ' + kind);
    });
  });
  actions.page = add('Trace the whole page', 'Renders everything on the page, then traces it', async () => {
    const id = await renderPage(info.page);
    setSourceUrl(imageDataUrl(id));
    useImage(id, label, ' · page rendered from ' + kind);
  });
  $('#pdfChoice').hidden = false;
  $('#source').hidden = false;
  $('#sourceName').textContent = label;
  $('#sourceInfo').textContent = `${kind} · choose how to use it below`;
  if (!auto) return;
  // sensible default: real vector as-is, a lone picture traced, otherwise the whole page
  const go = info.paths && !info.images.length && !info.text ? actions.vector
    : info.images.length === 1 && info.paths < 4 ? actions.img0 : actions.page;
  go().catch(e => { console.error(e); toast('That did not work: ' + e.message, 5000); });
}
$('#pdfPage').addEventListener('change', e => showPdfPage(+e.target.value, false));

function showSource(name, info) {
  $('#source').hidden = false;
  $('#sourceImg').src = state.sourceUrl;
  $('#sourceName').textContent = name;
  $('#sourceInfo').textContent = info;
  $('#compare').disabled = false;
}

$('#file').addEventListener('change', e => loadFile(e.target.files[0]));
const drop = $('#drop');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || e.target === document.documentElement) drop.classList.remove('over'); }));
document.addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
document.addEventListener('paste', e => {
  if (e.target.closest('input, textarea')) return;
  const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
  if (item) loadFile(item.getAsFile());
});

// ---------------------------------------------------------------- enhance + vectorise

async function run() {
  if (!state.original) return;
  if (state.busy) { state.pendingRun = true; return; }
  state.busy = true; $('#run').disabled = true;
  const src = state.original;
  const scale = $('#scale').value === 'auto' ? autoScale(src.width, src.height) : +$('#scale').value;
  const quality = $('#quality').value;
  try {
    let img = src;
    if (scale > 1) {
      const key = scale + quality;
      if (!state.upscaled.has(key)) {
        progress(0, `Upscaling ${scale}× with AI…`);
        const t0 = performance.now();
        const out = await upscale(src, { scale, quality, onProgress: p => progress(p * 0.85, `Upscaling ${scale}× with AI… ${Math.round(p)}%`) });
        state.upscaled.set(key, out);
        const secs = (performance.now() - t0) / 1000;
        if (secs > 20 && tf.getBackend() !== 'webgl') $('#enhanceHint').textContent = 'Upscaling ran on the processor because no graphics acceleration was available, so it was slow. "Faster" quality helps.';
      }
      img = state.upscaled.get(key);
    }
    if (Math.max(img.width, img.height) > MAX_INPUT) {
      const s = MAX_INPUT / Math.max(img.width, img.height);
      img = resize(img, Math.round(img.width * s), Math.round(img.height * s));
    }
    progress(90, 'Cleaning colours and tracing…'); await tick();
    const result = await vectorise(img, {
      inks: +$('#inks').value, detail: +$('#detail').value, corners: +$('#corners').value,
      removeBackground: $('#removeBg').checked,
    });
    if (!result.layers.length) { toast('Nothing left to trace: try turning off "Remove background".'); return; }
    $('#empty').hidden = true;
    await editor.setLogo(result.svg);
    progress(100, `Done: ${result.layers.length} colour${result.layers.length > 1 ? 's' : ''}, ${result.width} × ${result.height} px traced.`);
    afterLogo();
    if (state.afterRun && !state.pendingRun) { const f = state.afterRun; state.afterRun = null; f(); }
  } catch (e) {
    console.error(e);
    progress(null);
    toast('Something went wrong: ' + e.message, 5000);
  } finally {
    state.busy = false; $('#run').disabled = false;
    if (state.pendingRun) { state.pendingRun = false; run(); }
  }
}

function afterLogo() {
  for (const id of ['#step-colours', '#step-text', '#step-export']) openStep(id);
  $('#step-enhance').setAttribute('data-done', '');
  renderInks();
  refreshExportSoon();
}

$('#run').addEventListener('click', run);
const rerun = debounce(() => { if (state.original && editor.logo) run(); }, 350);
['#inks', '#removeBg', '#scale', '#quality'].forEach(s => $(s).addEventListener('change', rerun));
$('#detail').addEventListener('input', e => { $('#detailOut').textContent = e.target.value; rerun(); });
$('#corners').addEventListener('input', e => {
  const v = +e.target.value; $('#cornersOut').textContent = v < 45 ? 'Sharp' : v > 90 ? 'Smooth' : 'Balanced'; rerun();
});

// ---------------------------------------------------------------- colours

function renderInks() {
  const chips = $('#textInks'); chips.innerHTML = '';
  for (const ink of editor.inks().filter(i => !i.hidden).slice(0, 6)) {
    const b = document.createElement('button');
    b.style.background = ink.color; b.title = `Use logo colour ${ink.color.toUpperCase()}`; b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => { $('#tcolor').value = ink.color; liveUpdate(); });
    chips.appendChild(b);
  }
  const paint = $('#paintInks'); paint.innerHTML = '';
  for (const ink of editor.inks().filter(i => !i.hidden)) {
    const b = document.createElement('button');
    b.style.background = ink.color; b.title = `Paint with ${ink.color.toUpperCase()}`; b.setAttribute('aria-label', b.title);
    b.setAttribute('aria-pressed', editor.paintColor === ink.color);
    b.addEventListener('click', () => {
      editor.paintColor = ink.color; $('#paintPick').value = ink.color;
      if (editor.tool !== 'paint') setTool('paint');
      renderInks();
    });
    paint.appendChild(b);
  }
  const list = $('#inkList'); list.innerHTML = '';
  for (const ink of editor.inks()) {
    const li = document.createElement('li');
    li.classList.toggle('off', ink.hidden);
    li.innerHTML = `<input type="checkbox" ${ink.hidden ? '' : 'checked'} aria-label="Print ${ink.color}">
      <label class="chip" style="background:${ink.color}"><input type="color" value="${ink.color}" aria-label="Change ${ink.color}"></label>
      <code>${ink.color.toUpperCase()}</code><span class="meta">${ink.count} shape${ink.count > 1 ? 's' : ''}</span>`;
    li.querySelector('input[type=checkbox]').addEventListener('change', e => editor.setInkHidden(ink.color, !e.target.checked));
    const pick = li.querySelector('input[type=color]');
    pick.addEventListener('input', e => { li.querySelector('.chip').style.background = e.target.value; });
    pick.addEventListener('change', e => editor.recolor(ink.color, e.target.value));
    list.appendChild(li);
  }
}
$('#oneColour').addEventListener('click', () => {
  const to = normColor($('#oneColourPick').value);
  for (const ink of editor.inks()) if (!ink.hidden) editor.recolor(ink.color, to);
  toast('Logo set to one colour. Use Undo to go back.');
});
function setTool(tool) {
  editor.setTool(editor.tool === tool ? null : tool);
  $('#erase').setAttribute('aria-pressed', editor.tool === 'erase');
  $('#paint').setAttribute('aria-pressed', editor.tool === 'paint');
  if (editor.tool === 'erase') toast('Click shapes to delete them. Press Esc to stop.');
  if (editor.tool === 'paint') toast('Click shapes to paint them. Press Esc to stop.');
}
$('#erase').addEventListener('click', () => setTool('erase'));
$('#paint').addEventListener('click', () => setTool('paint'));
$('#paintPick').addEventListener('input', e => { editor.paintColor = normColor(e.target.value); renderInks(); });

// ---------------------------------------------------------------- text

const fontSel = $('#font'), weightSel = $('#weight');
FONTS.forEach((f, i) => fontSel.add(new Option(f.name, i)));
function fillWeights(keep) {
  const f = FONTS[+fontSel.value];
  weightSel.innerHTML = '';
  Object.keys(f.weights).forEach(w => weightSel.add(new Option(w, w)));
  const pref = keep && f.weights[keep] ? keep : (f.weights.Bold ? 'Bold' : Object.keys(f.weights)[0]);
  weightSel.value = pref;
}
fillWeights();
$('#fontFile').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const { index, style } = await addFontFile(f);
    if (![...fontSel.options].some(o => +o.value === index)) fontSel.add(new Option(FONTS[index].name, index));
    fontSel.value = index; fillWeights(style); liveUpdate();
    toast(`Added ${FONTS[index].name} ${style}`);
  } catch (err) { toast('That font file could not be read.'); }
  e.target.value = '';
});

let selectedText = null;
function textProps() {
  const f = FONTS[+fontSel.value];
  return {
    text: $('#txt').value, fontIndex: +fontSel.value, weight: weightSel.value, file: f.weights[weightSel.value],
    size: Math.max(6, +$('#tsize').value || 64), color: $('#tcolor').value,
    spacing: +$('#tspacing').value, curve: +$('#tcurve').value,
  };
}
function showTextProps(obj) {
  selectedText = obj;
  $('#addText').textContent = obj ? 'Add another' : 'Add text';
  $('#delText').hidden = !obj;
  if (!obj) return;
  const p = obj.textProps;
  openStep('#step-text');
  $('#txt').value = p.text; fontSel.value = p.fontIndex; fillWeights(p.weight);
  $('#tsize').value = p.size; $('#tcolor').value = normColor(obj.fill) || p.color;
  $('#tspacing').value = p.spacing; $('#tcurve').value = p.curve;
  syncTextOutputs();
}
function syncTextOutputs() {
  $('#tspacingOut').textContent = $('#tspacing').value;
  const c = +$('#tcurve').value;
  $('#tcurveOut').textContent = c === 0 ? 'Straight' : c > 0 ? `Arc up ${c}` : `Arc down ${-c}`;
}
const liveUpdate = debounce(async () => {
  if (!selectedText || !$('#txt').value.trim()) return;
  selectedText = await editor.updateText(selectedText, textProps());
}, 120);
fontSel.addEventListener('change', () => { fillWeights(weightSel.value); liveUpdate(); });
['#txt', '#weight', '#tsize', '#tcolor', '#tspacing', '#tcurve'].forEach(s => $(s).addEventListener('input', () => { syncTextOutputs(); liveUpdate(); }));
$('#addText').addEventListener('click', async () => {
  if (!$('#txt').value.trim()) { $('#txt').focus(); toast('Type some text first.'); return; }
  selectedText = await editor.addText(textProps());
});
$('#delText').addEventListener('click', () => editor.deleteSelected());

// ---------------------------------------------------------------- toolbar

document.querySelectorAll('.swatch[data-bg]').forEach(b => {
  if (b.dataset.bg !== 'checker') b.style.background = b.dataset.bg;
  b.addEventListener('click', () => setGarment(b.dataset.bg, b));
});
$('#bgPick').addEventListener('input', e => setGarment(e.target.value, e.target.parentElement));
function setGarment(bg, btn) {
  const host = $('#canvasHost');
  host.classList.toggle('checker', bg === 'checker');
  host.style.background = bg === 'checker' ? '' : bg;
  document.querySelectorAll('.swatch').forEach(s => s.setAttribute('aria-pressed', s === btn));
}
setGarment('checker', document.querySelector('.swatch[data-bg="checker"]'));

$('#undo').addEventListener('click', () => editor.undo());
$('#fit').addEventListener('click', () => editor.fitAll());
$('#compare').addEventListener('click', e => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  e.currentTarget.setAttribute('aria-pressed', on);
  const img = $('#compareImg'), logo = editor.logo;
  img.hidden = !on || !logo;
  if (on && logo) {
    const b = logo.getBoundingRect();
    img.src = state.sourceUrl;
    Object.assign(img.style, { left: b.left + 'px', top: b.top + 'px', width: b.width + 'px', height: b.height + 'px' });
  }
});
document.addEventListener('keydown', e => {
  if (e.target.closest('input, textarea, select')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); editor.undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelected(); }
  else if (e.key === 'Escape' && editor.tool) setTool(editor.tool);
});

// ---------------------------------------------------------------- export

Object.entries(METHODS).forEach(([k, m]) => $('#method').add(new Option(m.label, k)));

const EXPORTS = {
  screen: [
    ['pdf', 'Vector PDF', 'Spot colours, actual size, for the printer or RIP'],
    ['seps', 'Separations PDF', 'One black film page per ink, with registration marks'],
    ['eps', 'Vector EPS', 'Spot colours, actual size, text outlined'],
  ],
  dtg: [
    ['png', 'Print PNG (300 dpi)', 'Transparent background, full colour'],
    ['pdf', 'Vector PDF', 'Actual size'],
    ['eps', 'Vector EPS', 'Actual size'],
  ],
  dtf: [
    ['png', 'Print PNG (300 dpi)', 'Transparent background, full colour'],
    ['pdf', 'Vector PDF', 'Actual size'],
    ['eps', 'Vector EPS', 'Actual size'],
  ],
  engrave: [
    ['pdf-black', 'Engrave PDF', 'Solid black, actual size (LightBurn, RDWorks, etc.)'],
    ['eps-black', 'Engrave EPS', 'Solid black, actual size'],
    ['png-black', 'Engrave PNG (600 dpi)', 'For raster engraving'],
  ],
  vinyl: [
    ['pdf-cut', 'Cut PDF', 'Outlines only, one colour per layer (Cricut, Silhouette, Roland)'],
    ['eps-cut', 'Cut EPS', 'Outlines only, for cutter software that takes EPS'],
    ['pdf', 'Filled PDF', 'Solid shapes in their colours, actual size'],
  ],
  lasercut: [
    ['pdf-hairline', 'Cut PDF', 'Red hairline outlines, actual size'],
    ['eps-hairline', 'Cut EPS', 'Red hairline outlines, actual size'],
    ['pdf-black', 'Solid PDF', 'Filled black, for engrave + cut jobs'],
  ],
  embroidery: [
    ['pdf', 'Artwork PDF', 'Clean vector for the digitiser'],
    ['eps', 'Artwork EPS', 'For digitising software that takes EPS'],
    ['png', 'Artwork PNG (300 dpi)', 'Transparent background'],
  ],
};

function exportOpts() {
  return { widthMm: Math.max(5, +$('#widthMm').value || 250), mirror: $('#mirror').checked && $('#mirror').closest('label').style.display !== 'none' };
}

async function refreshExport() {
  if (!$('#step-export').hasAttribute('data-open') || !editor.logo) return;
  const method = $('#method').value, M = METHODS[method];
  $('#mirrorRow').style.display = method === 'vinyl' || method === 'dtf' ? '' : 'none';
  $('#mirrorRow').lastChild.textContent = method === 'dtf' ? ' Mirror (only if your DTF printer needs it)' : ' Mirror (for heat-transfer vinyl)';
  const built = buildSVG(editor, { ...exportOpts(), mirror: false });
  if (!built) { $('#checks').innerHTML = '<div class="info">Nothing visible to export.</div>'; $('#exports').innerHTML = ''; return; }
  $('#sizeInfo').textContent = `Print size ${built.widthMm.toFixed(0)} × ${built.heightMm.toFixed(0)} mm · ${built.inks.length} colour${built.inks.length > 1 ? 's' : ''}`;
  const ex = $('#exports'); ex.innerHTML = '';
  for (const [kind, title, sub] of EXPORTS[method]) {
    const b = document.createElement('button');
    b.innerHTML = `<b>${title}</b><span>${sub}</span>`;
    b.addEventListener('click', () => doExport(kind, method).catch(e => { console.error(e); toast('Export failed: ' + e.message, 5000); }));
    ex.appendChild(b);
  }
  const res = await runChecks(built, method);
  const live = [...new Set(editor.leaves().filter(o => o.visible && /text/i.test(o.type || '')).map(o => o.fontFamily))];
  if (live.length) res.issues.push({ level: 'warn', text: `This SVG has live text (${live.join(', ')}). The printer may not have that font: retype it with the Text tool, or outline it in your design app first.` });
  if ($('#mirror').checked) res.issues = res.issues.filter(i => !/tick \"Mirror\"/.test(i.text));
  $('#checks').innerHTML = res.issues.map(i => `<div class="${i.level}">${i.text}</div>`).join('');
  const img = $('#checkPreview');
  img.hidden = !res.issues.some(i => i.level === 'warn');
  img.src = res.preview;
}
const refreshExportSoon = debounce(refreshExport, 400);
['#method', '#widthMm', '#mirror'].forEach(s => $(s).addEventListener('input', refreshExportSoon));

function saveEps(name, r) {
  if (r.skipped.length) toast(`EPS saved without ${r.skipped.join(', ')} items (pictures or live text). Use SVG or PDF for those.`, 5000);
  return download(name, r.eps, 'application/postscript');
}

async function doExport(kind, method) {
  const o = exportOpts();
  const base = `${state.name}_${method}_${Math.round(o.widthMm)}mm${o.mirror ? '_mirrored' : ''}`;
  const single = { ...o, mode: 'single', color: '#000000' };
  switch (kind) {
    case 'eps': return saveEps(base + '.eps', buildEPS(editor, o));
    case 'eps-black': return saveEps(base + '.eps', buildEPS(editor, single));
    case 'eps-cut': return saveEps(base + '_cut.eps', buildEPS(editor, { ...o, mode: 'outline', color: 'ink', strokeMm: 0.1 }));
    case 'eps-hairline': return saveEps(base + '_cut.eps', buildEPS(editor, { ...o, mode: 'outline', color: '#ff0000', strokeMm: 0.01 }));
    case 'pdf': return download(base + '.pdf', await pdfBlob(buildSVG(editor, o)));
    case 'pdf-black': return download(base + '.pdf', await pdfBlob(buildSVG(editor, single)));
    case 'pdf-cut': return download(base + '_cut.pdf', await pdfBlob(buildSVG(editor, { ...o, mode: 'outline', color: 'ink', strokeMm: 0.1 })));
    case 'pdf-hairline': return download(base + '_cut.pdf', await pdfBlob(buildSVG(editor, { ...o, mode: 'outline', color: '#ff0000', strokeMm: 0.01 })));
    case 'png': { const r = await pngBlob(buildSVG(editor, o), 300); toast(`PNG ${r.w} × ${r.h} px at ${r.dpi} dpi`); return download(base + '.png', r.blob); }
    case 'png-black': { const r = await pngBlob(buildSVG(editor, single), 600); toast(`PNG ${r.w} × ${r.h} px at ${r.dpi} dpi`); return download(base + '.png', r.blob); }
    case 'seps': {
      toast('Building separations…');
      const r = await separationsBlob(editor, o);
      toast(`${r.inks.length} separation page${r.inks.length > 1 ? 's' : ''}`);
      return download(base + '_separations.pdf', r.blob);
    }
  }
}

// ---------------------------------------------------------------- presets

const PRESETS = {
  screen2: { inks: '2', method: 'screen' },
  screen: { inks: '0', method: 'screen' },
  digital: { inks: '0', method: 'dtg', detail: 7 },
  mono: { inks: '0', method: 'engrave', mono: true },
};
document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const p = PRESETS[b.dataset.preset];
  $('#inks').value = p.inks;
  if (p.detail) { $('#detail').value = p.detail; $('#detailOut').textContent = p.detail; }
  $('#method').value = p.method;
  document.querySelectorAll('[data-preset]').forEach(x => x.setAttribute('aria-pressed', x === b));
  // one colour: dark and mid inks become black, near-white inks are knocked out
  state.afterRun = p.mono ? () => {
    for (const ink of editor.inks()) {
      const [r, g, bl] = [1, 3, 5].map(i => parseInt(ink.color.slice(i, i + 2), 16));
      if (0.299 * r + 0.587 * g + 0.114 * bl > 225) editor.setInkHidden(ink.color, true);
      else editor.recolor(ink.color, '#000000');
    }
  } : null;
  if (state.original) run();
  else if (p.mono && editor.logo) { state.afterRun(); state.afterRun = null; }
  refreshExportSoon();
}));

// ---------------------------------------------------------------- crop

const crop = { dlg: $('#cropDlg'), img: $('#cropImg'), box: $('#cropBox'), rect: null };
$('#cropBtn').addEventListener('click', () => {
  const src = state.uncropped || state.original;
  if (!src) return;
  crop.img.src = imageDataUrl(src);
  // show small logos enlarged so they're easy to crop
  const k = Math.min(Math.min(innerWidth * 0.85, 860) / src.width, innerHeight * 0.6 / src.height);
  Object.assign(crop.img.style, { width: Math.round(src.width * k) + 'px', height: Math.round(src.height * k) + 'px' });
  crop.rect = null; crop.box.hidden = true;
  crop.dlg.showModal();
});
$('#cropCancel').addEventListener('click', () => crop.dlg.close());
$('#cropReset').addEventListener('click', () => {
  if (state.uncropped) { state.original = state.uncropped; state.uncropped = null; state.upscaled.clear(); run(); }
  crop.dlg.close();
});
$('#cropApply').addEventListener('click', () => {
  if (!crop.rect || crop.rect.w < 4 || crop.rect.h < 4) { toast('Drag across the part of the logo you want to keep.'); return; }
  const src = state.uncropped || state.original;
  const sx = src.width / crop.img.clientWidth, sy = src.height / crop.img.clientHeight;
  const x = Math.round(crop.rect.x * sx), y = Math.round(crop.rect.y * sy);
  const w = Math.max(1, Math.round(crop.rect.w * sx)), h = Math.max(1, Math.round(crop.rect.h * sy));
  const c = new OffscreenCanvas(src.width, src.height); c.getContext('2d').putImageData(src, 0, 0);
  state.uncropped = src;
  state.original = c.getContext('2d').getImageData(x, y, w, h);
  state.upscaled.clear();
  crop.dlg.close();
  $('#sourceInfo').textContent = `Cropped to ${w} × ${h} px` + (Math.max(w, h) < 600 ? ' · will be upscaled' : '');
  run();
});
const wrap = $('#cropWrap');
wrap.addEventListener('pointerdown', e => {
  const r = crop.img.getBoundingClientRect();
  const at = ev => ({ x: Math.min(Math.max(ev.clientX - r.left, 0), r.width), y: Math.min(Math.max(ev.clientY - r.top, 0), r.height) });
  const a = at(e);
  wrap.setPointerCapture(e.pointerId);
  const move = ev => {
    const b = at(ev);
    crop.rect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    Object.assign(crop.box.style, { left: crop.rect.x + 'px', top: crop.rect.y + 'px', width: crop.rect.w + 'px', height: crop.rect.h + 'px' });
    crop.box.hidden = false;
  };
  const up = () => { wrap.removeEventListener('pointermove', move); wrap.removeEventListener('pointerup', up); };
  wrap.addEventListener('pointermove', move);
  wrap.addEventListener('pointerup', up);
});
