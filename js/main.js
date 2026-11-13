import { Editor, normColor } from './editor.js';
import { upscale, autoScale, resize } from './upscale.js';
import { vectorise } from './trace.js';
import { FONTS, addFontFile } from './text.js';
import { METHODS, runChecks } from './checks.js';
import { buildSVG, buildEPS, download, pngBlob, rasterPngBlob, pdfBlob, separationsBlob } from './export.js';
import { openPdf, inspectPage, imageData as pdfImage, pageSvg, renderPage, renderRegion } from './pdf.js';
import { epsToPdf, sniff } from './eps.js';
import { listZip, unzipEntry } from './zip.js';
import { LIVE_SERVER } from './config.js';
import { loadStats, countLoad } from './stats.js';
import { initSplit, openSplit, savePages } from './split.js';

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
  onCropped: n => toast(n ? `Kept what's inside the box (${n} shape${n > 1 ? 's' : ''} removed). Undo brings them back.` : 'Everything was already inside the box.'),
  onChange: () => { $('#undo').disabled = editor.history.length < 2; renderInks(); renderLiveText(); refreshExportSoon(); },
  onSelect: obj => showTextProps(obj && obj.isText ? obj : null),
});

initSplit();
window.addEventListener('lps-toast', e => toast(e.detail.msg, e.detail.ms));
$('#splitOpen').addEventListener('click', () => openSplit());
$('#pdfPageSave').addEventListener('click', async () => {
  if (!state.pdf) return;
  const n = +$('#pdfPage').value || 1;
  try { await savePages(new Uint8Array(await state.pdf.file.arrayBuffer()), state.pdf.file.name, [n]); toast(`Saved page ${n} as a PDF.`); }
  catch (e) { console.error(e); toast(e.message, 6000); }
});

loadStats();
setInterval(() => { if (!document.hidden) loadStats(); }, 60_000);

if (new URLSearchParams(location.search).has('debug')) globalThis.lpsEditor = editor;   // for tests

// ---------------------------------------------------------------- loading

async function loadFile(file) {
  if (!file) return;
  state.name = (file.name || 'logo').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'logo';
  const name = file.name || '';
  $('#pdfChoice').hidden = true;
  if (/\.(pdf|ai|eps|epsf|ps|svgz?|zip)$/i.test(name) || /pdf|postscript|illustrator|svg|zip/.test(file.type)) {
    return openBytes(new Uint8Array(await file.arrayBuffer()), name);
  }
  const url = URL.createObjectURL(file);
  const img = new Image(); img.src = url;
  try { await img.decode(); } catch { URL.revokeObjectURL(url); toast('That file could not be read as an image.'); return; }
  const data = imageToData(img);
  setSourceUrl(url);
  vectorCheck('raster', 'Pixel image, not vector: it will be traced to vector for print.');
  useImage(data, name || 'Pasted image');
}

// PDF, AI, EPS, SVG or zip: what it really is comes from its first bytes,
// since names lie (an .ai can be PDF inside or old PostScript; .eps may be either).
async function openBytes(bytes, name) {
  state.name = name.replace(/^.*\//, '').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'logo';
  $('#pdfChoice').hidden = true;
  const kind = sniff(bytes);
  if (kind === 'pdf') return loadPdf(new File([bytes], name));
  if (kind === 'eps') return loadEps(bytes, name);
  if (kind === 'svg') return loadSvg(new TextDecoder().decode(bytes), { name });
  if (kind === 'gzip') {   // .svgz: compressed SVG
    const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text().catch(() => '');
    if (/<svg\b/i.test(text)) return loadSvg(text, { name });
  }
  if (kind === 'zip') return showZip(bytes, name);
  if (/\.ai$/i.test(name)) return toast('This .ai file could not be read. Ask for a PDF, or re-save it in Illustrator with "Create PDF Compatible File" ticked.', 7000);
  const blob = new Blob([bytes]), url = URL.createObjectURL(blob);
  try {
    const id = await decodeImage(url);
    setSourceUrl(url);
    vectorCheck('raster', 'Pixel image, not vector: it will be traced to vector for print.');
    return useImage(id, name.replace(/^.*\//, ''));
  } catch { URL.revokeObjectURL(url); }
  toast('That file could not be read. Use a PDF, AI, EPS, SVG, PNG or JPG.', 5000);
}

// EPS is turned into PDF in the browser, then opened like any PDF.
async function loadEps(bytes, name) {
  const ai = /\.ai$/i.test(name);
  progress(25, `Reading the ${ai ? 'Illustrator' : 'EPS'} file…`);
  let pdf;
  try { pdf = await epsToPdf(bytes); }
  catch (e) {
    console.error(e);
    return toast(ai ? 'This old-format .ai file could not be read. Ask for a PDF, or re-save it in Illustrator with "Create PDF Compatible File" ticked.'
      : e.message.includes('download') ? e.message : 'This EPS could not be read. Ask the client for a PDF or AI file instead.', 7000);
  } finally { progress(null); }
  return loadPdf(new File([pdf], name), { kind: ai ? 'Illustrator file' : 'EPS' });
}

// A zip (usually a brand pack): list the logo files in it to pick from.
async function showZip(bytes, name) {
  let entries;
  try { entries = listZip(bytes); } catch (e) { return toast(e.message, 5000); }
  const fmt = n => (n.match(/\.(ai|eps|pdf|svgz?|png|jpe?g)$/i) || [])[1];
  const rank = e => ({ ai: 6, eps: 5, pdf: 4, svg: 3, svgz: 3, png: 2 }[fmt(e.name).toLowerCase()] || 1)
    + (/logo|brand|mark/i.test(e.name) ? 3 : 0) - (/white|reverse|negative|knock|black|mono/i.test(e.name) ? 1 : 0);
  const usable = entries.filter(e => fmt(e.name)).sort((a, b) => rank(b) - rank(a)).slice(0, 40);
  const status = $('#webStatus'), box = $('#webResults');
  status.hidden = false;
  if (!usable.length) { status.textContent = `No logo files (AI, EPS, PDF, SVG, PNG) in ${name.replace(/^.*\//, '')}.`; box.hidden = true; return; }
  status.textContent = `${usable.length} logo file${usable.length > 1 ? 's' : ''} in ${name.replace(/^.*\//, '')}${entries.length > usable.length ? ` (other files left out)` : ''}. Pick one: AI, EPS and PDF are the print masters.`;
  box.innerHTML = '';
  for (const e of usable) {
    const f = fmt(e.name).toLowerCase().replace('svgz', 'svg').replace('jpeg', 'jpg');
    const card = pickCard({ badge: f.toUpperCase(), kind: /ai|eps|pdf|svg/.test(f) ? 'Print file' : 'Picture', vector: /ai|eps|pdf|svg/.test(f), from: e.name.replace(/^.*\//, ''), title: e.name });
    card.addEventListener('click', () => choose(card, async () => openBytes(await unzipEntry(bytes, e), e.name)));
    // small previews for SVG and PNG
    if (/svg|png|jpg/.test(f) && e.usize < 1_500_000) unzipEntry(bytes, e).then(d => {
      if (f === 'svg' && sniff(d) !== 'svg') return;
      showThumb(card, URL.createObjectURL(new Blob([d], { type: f === 'svg' ? 'image/svg+xml' : 'image/' + (f === 'jpg' ? 'jpeg' : 'png') })));
    }).catch(() => {});
    box.appendChild(card);
  }
  box.hidden = false;
  $('#webResults').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// One choice card in the results grid.
function pickCard({ thumb, badge, kind, vector, from, title }) {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'stk-pick ui';
  b.innerHTML = `<span class="thumb"></span><span class="kind ${vector ? 'vector' : ''}"></span><span class="from"></span>`;
  b.querySelector('.kind').textContent = kind;
  b.querySelector('.from').textContent = from;
  if (title) b.title = title;
  if (thumb) showThumb(b, thumb);
  else { const s = document.createElement('span'); s.className = 'fmt'; s.textContent = badge; b.querySelector('.thumb').appendChild(s); }
  return b;
}
function showThumb(card, src) {
  const t = card.querySelector('.thumb'), img = new Image();
  img.alt = ''; img.src = src;
  img.onload = () => { const badge = t.querySelector('.fmt'); if (badge) { badge.classList.add('corner'); } t.prepend(img); };
}
function choose(card, fn) {
  $('#webResults').querySelectorAll('.stk-pick').forEach(x => x.classList.toggle('on', x === card));
  card.classList.add('loading');
  fn().catch(err => { console.error(err); toast('That one could not be opened: ' + err.message, 6000); })
    .finally(() => card.classList.remove('loading'));
}

function setSourceUrl(url) {
  if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
  state.sourceUrl = url;
}

// One more logo for the counter, once per source file (switching between a
// PDF's options, or re-running, isn't a new logo).
function counted(label) {
  const key = String(label).replace(/ \(page \d+\)$/, '');
  if (state.countedAs === key) return;
  state.countedAs = key;
  countLoad();
}

// Start the enhance + trace pipeline on a raster image.
function useImage(id, label, note = '') {
  counted(label);
  state.pdfSource = null;   // set again by the PDF page path, which can re-draw crops sharp
  $('#gradSteps').value = '0';   // a new logo starts with its gradient as traced
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
  counted(label);
  $('#gradientNote').hidden = true;
  state.gradientArt = null;
  state.original = null;
  $('#cropBtn').hidden = false;   // crop works on vector too: drag a box on the canvas
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
  return imageToData(img);
}

// A decoded picture as pixels, shrunk on the way in if it is bigger than the
// app works at, so a huge photo or scan never sits in memory at full size.
function imageToData(img) {
  const s = Math.min(1, MAX_INPUT / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = new OffscreenCanvas(w, h), x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(img, 0, 0, w, h);
  return x.getImageData(0, 0, w, h);
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

// Website search ------------------------------------------------------------
// The server fetches the site and suggests logos (a browser page can't read
// other websites itself). The double-click copy of the app, or one run from
// a local launcher, asks the live server instead.


async function searchSite(site) {
  const ask = async base => {
    const r = await fetch(`${base}/api/logos?url=${encodeURIComponent(site)}`);
    if (r.status === 404 && base === '') return null;   // no search on this server: try the live one
    const data = await r.json().catch(() => ({ error: 'The search service gave an unreadable answer.' }));
    if (!r.ok) throw new Error(data.error || 'The search failed.');
    return data;
  };
  return (location.protocol.startsWith('http') && await ask('')) || ask(LIVE_SERVER);
}

// A download the search found (press-kit PDF, AI, EPS…), fetched by the
// server because the browser isn't allowed to read other sites directly.
async function fetchWebFile(url) {
  const ask = async base => {
    const r = await fetch(`${base}/api/file?url=${encodeURIComponent(url)}`);
    if (r.status === 404 && base === '') return null;
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'The download failed.');
    return new Uint8Array(await r.arrayBuffer());
  };
  return (location.protocol.startsWith('http') && await ask('')) || ask(LIVE_SERVER);
}

$('#webForm').addEventListener('submit', async e => {
  e.preventDefault();
  const site = $('#webUrl').value.trim(), status = $('#webStatus'), box = $('#webResults');
  if (!site) { $('#webUrl').focus(); return; }
  status.hidden = false; status.textContent = 'Searching the site…'; box.hidden = true; box.innerHTML = '';
  $('#webGo').disabled = true;
  try {
    const data = await searchSite(site);
    if (!data.candidates.length && !(data.files || []).length) {
      status.textContent = (data.tooSmall ? `Only small pictures (under ${data.minPicture} px) on ${data.host}, too small to print from. ` : '') + `No logo found on ${data.host}. Some sites only draw their logo with JavaScript: try the address of a page that shows it, or save the logo from the site and drop it in.`;
      return;
    }
    const files = data.files || [];
    const vectors = data.candidates.filter(c => c.type === 'svg').length;
    const pages = (data.brandPages || []).map(p => new URL(p.url).pathname).join(', ');
    const sure = files.filter(f => !f.maybe).length, maybes = files.length - sure;
    status.textContent = (sure
      ? `Found ${sure} logo download${sure > 1 ? 's' : ''}${pages ? ` (from ${pages})` : ''} and ${data.candidates.length} on the page. The AI, EPS and PDF downloads are usually the master print artwork.`
      : vectors ? `Found ${data.candidates.length} on ${data.host}. Vector SVGs are marked in orange: pick the real logo.`
      : data.candidates.length ? `Found ${data.candidates.length} on ${data.host}, but no vector version: these are pictures and will be traced.`
      : `No logo image found on ${data.host}.`)
      + (maybes ? ` Also ${maybes} other PDF${maybes > 1 ? 's' : ''} from the site (menus, brochures…), listed last: these often have the logo as vector. Open one, then use Crop to keep just the logo.` : '')
      + (data.tooSmall ? ` ${data.tooSmall} picture${data.tooSmall > 1 ? 's' : ''} under ${data.minPicture} px ${data.tooSmall > 1 ? 'were' : 'was'} left out as too small to print from.` : '')
      + ' Check it\'s the current version before it goes to print.';
    for (const f of files) {
      const card = pickCard({ badge: f.format.toUpperCase(), kind: f.maybe ? 'PDF on the site' : f.format === 'zip' ? 'Logo pack' : 'Print file', vector: !f.maybe, from: `${f.name} · ${f.source}`, title: f.url });
      card.addEventListener('click', () => choose(card, async () => {
        status.textContent = `Downloading ${f.name}…`;
        const bytes = await fetchWebFile(f.url);
        status.textContent = `Opened ${f.name} from ${data.host}. Check it's the current version before it goes to print.`;
        await openBytes(bytes, f.name);
      }));
      box.appendChild(card);
    }
    data.candidates.forEach((c, i) => {
      const src = c.type === 'svg' ? URL.createObjectURL(new Blob([c.svg], { type: 'image/svg+xml' })) : c.dataUrl;
      const card = pickCard({ thumb: src, kind: c.type === 'svg' ? 'Vector SVG' : c.w ? `Picture · ${c.w} × ${c.h} px` : 'Picture', vector: c.type === 'svg', from: c.source });
      card.querySelector('.thumb').dataset.alt = `Option ${i + 1} from ${data.host}`;
      card.addEventListener('click', () => choose(card, () => useWebLogo(c, data.host)));
      box.appendChild(card);
    });
    box.hidden = false;
  } catch (err) {
    status.textContent = /fetch|network/i.test(err.message) ? 'The search service couldn\'t be reached. Check the internet connection.' : err.message;
  } finally {
    $('#webGo').disabled = false;
  }
});

async function useWebLogo(c, host) {
  const name = host.replace(/[^\w-]+/g, '_');
  state.name = name;
  $('#pdfChoice').hidden = true;
  if (c.type === 'svg') return loadSvg(c.svg, { name: `${host} logo.svg` });
  const id = await decodeImage(c.dataUrl);
  setSourceUrl(c.dataUrl);
  vectorCheck('raster', 'Picture from the website, not vector: it will be traced to vector for print.');
  useImage(id, `${host} logo`, ' · from the website');
}

// PDF / AI ------------------------------------------------------------------

async function loadPdf(file, { kind } = {}) {
  let doc;
  try { doc = await openPdf(await file.arrayBuffer()); }
  catch (e) {
    console.error(e);
    return toast(/\.ai$/i.test(file.name) ? 'This .ai file has no PDF inside it (old Illustrator format). Re-save it with "Create PDF Compatible File" ticked, or export a PDF or SVG.' : 'That PDF could not be read.', 7000);
  }
  if (state.pdf?.doc && state.pdf.doc !== doc) state.pdf.doc.destroy().catch(() => {});
  state.pdf = { doc, file, kind };
  const sel = $('#pdfPage'); sel.innerHTML = '';
  for (let i = 1; i <= doc.numPages; i++) sel.add(new Option(`Page ${i} of ${doc.numPages}`, i));
  $('#pdfPages').hidden = doc.numPages < 2;
  showPdfPage(1, true);
}

async function showPdfPage(n, auto) {
  const { doc, file } = state.pdf;
  const info = await inspectPage(doc, n);
  state.pdf.info = info;
  const kind = state.pdf.kind || (/\.ai$/i.test(file.name) ? 'Illustrator file' : 'PDF');
  const pics = info.images.map(i => `${i.width} × ${i.height} px`).join(', ');
  if (info.images.length && info.paths < 4) vectorCheck('warn', `Not true vector: the logo in this ${kind} is a picture (${pics}). Use the picture below to trace it to real vector.`);
  else if (info.images.length) vectorCheck('warn', `Mixed: vector shapes plus ${info.images.length} pasted-in picture${info.images.length > 1 ? 's' : ''} (${pics}). Suppliers may reject the pictures.`);
  else if (info.paths) vectorCheck('ok', `True vector ${kind}: no pasted-in pictures.` + (info.text ? ' It has live text, so the fonts may be missing at the printer: tracing the page outlines them.' : ''));
  else vectorCheck('warn', `This page has no artwork that could be found.`);

  const box = $('#pdfButtons'); box.innerHTML = '';
  const add = (title, sub, fn) => {
    const b = document.createElement('button');
    b.append(Object.assign(document.createElement('b'), { textContent: title }), Object.assign(document.createElement('span'), { textContent: sub }));
    b.addEventListener('click', () => fn().catch(e => { console.error(e); toast('That did not work: ' + e.message, 5000); }));
    box.appendChild(b);
    return fn;
  };
  const label = `${file.name.replace(/^.*\//, '')}${doc.numPages > 1 ? ` (page ${n})` : ''}`;
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
    useImage(id, label, ' · page rendered from ' + kind + ' · Crop re-draws sharp from the PDF');
    state.pdfSource = id.region ? { page: info.page, region: id.region } : null;
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
  let scale = $('#scale').value === 'auto' ? autoScale(src.width, src.height) : +$('#scale').value;
  // never upscale past about 4,000 px: no visible gain, and big enough to crash a tab
  while (scale > 1 && Math.max(src.width, src.height) * scale > 4000) scale /= 2;
  if (scale < 2) scale = 1;
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
      removeBackground: $('#removeBg').checked, gradientSteps: +$('#gradSteps').value,
    });
    if (!result.layers.length) { toast('Nothing left to trace: try turning off "Remove background".'); return; }
    $('#gradientNote').hidden = !result.gradient;
    state.gradientArt = result.gradient ? gradientArtwork(img, result.keep, result.background) : null;
    $('#gradientInks').textContent = result.layers.length === 1 ? 'one solid ink' : `${result.layers.length} solid inks`;
    $('#empty').hidden = true;
    await editor.setLogo(result.svg);
    if (state.refit) { editor.fitAll(); state.refit = false; }   // after a crop the shape changed: fit it again
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

// The original (upscaled) picture with its gradient, background and holes cut
// out using the trace, cropped to the logo. Edge pixels in the original are
// part background (a pale rim on a dark garment), so along the edges each
// pixel takes its colour from just inside the shape and its transparency
// from how much background was mixed in. Digital print (DTG/DTF) uses this
// instead of flattened inks.
function gradientArtwork(img, keep, background) {
  const { width: w, height: h, data: d } = img;
  const B = background ? [1, 3, 5].map(i => parseInt(background.slice(i, i + 2), 16)) : null;
  let x0 = w, x1 = -1, y0 = h, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (keep[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return null;
  const P = 3;   // margin so soft edges aren't clipped
  x0 = Math.max(0, x0 - P); y0 = Math.max(0, y0 - P); x1 = Math.min(w - 1, x1 + P); y1 = Math.min(h - 1, y1 + P);
  const K = (x, y) => x >= 0 && y >= 0 && x < w && y < h ? keep[y * w + x] : 0;
  // solidly inside: logo here and all around
  const inside = (x, y) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (!K(x + dx, y + dy)) return false; return true; };
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1, out = new ImageData(cw, ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const sx = x + x0, sy = y + y0, i = sy * w + sx, o = (y * cw + x) * 4;
    if (inside(sx, sy)) { out.data.set([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4 + 3]], o); continue; }
    // near the edge: is there logo close by at all?
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2; dx++) if (K(sx + dx, sy + dy)) { near = true; break; }
    if (!near) continue;
    // colour from the nearest solidly-inside pixel
    let C = null, best = Infinity;
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const xx = sx + dx, yy = sy + dy, r = dx * dx + dy * dy;
      if (r < best && xx >= 0 && yy >= 0 && xx < w && yy < h && inside(xx, yy)) { best = r; const j = yy * w + xx; C = [d[j * 4], d[j * 4 + 1], d[j * 4 + 2]]; }
    }
    const px = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]];
    if (!C) C = px;
    let a;
    if (B) {
      // how far this pixel is from the background, toward the ink: the ink's share
      const cb = [C[0] - B[0], C[1] - B[1], C[2] - B[2]], len2 = cb[0] ** 2 + cb[1] ** 2 + cb[2] ** 2;
      a = len2 < 400 ? K(sx, sy) : ((px[0] - B[0]) * cb[0] + (px[1] - B[1]) * cb[1] + (px[2] - B[2]) * cb[2]) / len2;
    } else a = K(sx, sy);
    a = Math.max(0, Math.min(1, a));
    out.data.set([C[0], C[1], C[2], Math.round(a * d[i * 4 + 3])], o);
  }
  const c = document.createElement('canvas'); c.width = cw; c.height = ch;
  c.getContext('2d').putImageData(out, 0, 0);
  return c;
}

function afterLogo() {
  for (const id of ['#step-colours', '#step-text', '#step-export']) openStep(id);
  $('#step-enhance').setAttribute('data-done', '');
  renderInks();
  refreshExportSoon();
}

$('#run').addEventListener('click', run);
const rerun = debounce(() => { if (state.original && editor.logo) run(); }, 350);
['#inks', '#removeBg', '#scale', '#quality', '#gradSteps'].forEach(s => $(s).addEventListener('change', rerun));
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
      <input type="text" class="hex" value="${ink.color.toUpperCase()}" maxlength="7" spellcheck="false" aria-label="Hex code for ${ink.color}"><span class="meta">${ink.count} shape${ink.count > 1 ? 's' : ''}</span>`;
    li.querySelector('input[type=checkbox]').addEventListener('change', e => editor.setInkHidden(ink.color, !e.target.checked));
    const pick = li.querySelector('input[type=color]');
    pick.addEventListener('input', e => { li.querySelector('.chip').style.background = e.target.value; });
    pick.addEventListener('change', e => editor.recolor(ink.color, e.target.value));
    // type an exact colour (e.g. the client's brand hex); applied on Enter or leaving the box
    const hexBox = li.querySelector('.hex');
    const applyHex = () => {
      let v = hexBox.value.trim().replace(/^#?/, '#');
      if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + [...v.slice(1)].map(c => c + c).join('');
      if (!/^#[0-9a-f]{6}$/i.test(v)) { hexBox.value = ink.color.toUpperCase(); if (hexBox.value !== v.toUpperCase()) toast('Type a colour as a 6-digit hex code, like #FF7712.'); return; }
      if (v.toLowerCase() !== ink.color) editor.recolor(ink.color, v);
    };
    hexBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyHex(); } else if (e.key === 'Escape') hexBox.value = ink.color.toUpperCase(); });
    hexBox.addEventListener('change', applyHex);
    list.appendChild(li);
  }
}
// Live text from imported artwork: offer to outline it.
function renderLiveText() {
  const texts = editor.liveTexts();
  $('#liveText').hidden = !texts.length;
  if (!texts.length) return;
  const fonts = [...new Set(texts.map(t => String(t.fontFamily).split(',')[0].replace(/['"]/g, '').trim()))];
  $('#liveTextNote').textContent = `This artwork has live text in ${fonts.join(', ')}. Printers may not have ${fonts.length > 1 ? 'these fonts' : 'that font'}, so convert it to curves before exporting.`;
}
$('#outlineText').addEventListener('click', async () => {
  const btn = $('#outlineText'); btn.disabled = true;
  try {
    const r = await editor.convertLiveText({ askComputer: true });
    if (r.missing.length) {
      openStep('#step-text');
      toast(`${r.done.length ? `Converted ${r.done.length}. ` : ''}Font not found: ${r.missing.join(', ')}. Load its font file in the Text step ("Use your own font file"), then convert again.`, 8000);
    } else if (r.done.length) toast(`Converted ${r.done.length} text item${r.done.length > 1 ? 's' : ''} to curves (${[...new Set(r.done)].join(', ')}).`);
  } catch (e) { console.error(e); toast('Converting the text failed: ' + e.message, 5000); }
  finally { btn.disabled = false; }
});

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
  if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
  if (mod && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); editor.redo(); }
  else if (mod && k === 'z') { e.preventDefault(); editor.undo(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); editor.deleteSelected(); }
  else if (e.key === 'Escape' && editor.tool) setTool(editor.tool);
});

// ---------------------------------------------------------------- export

Object.entries(METHODS).forEach(([k, m]) => $('#method').add(new Option(m.label, k)));

const EXPORTS = {
  screen: [
    ['pdf', 'Vector PDF', 'Flat colours, one layer per ink, actual size'],
    ['seps', 'Separations PDF', 'One black film page per ink, with registration marks'],
    ['eps', 'Vector EPS', 'Flat colours, one layer per ink, text outlined'],
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
  pad: [
    ['pdf', 'Vector PDF', 'Flat colours, one layer per ink, actual size'],
    ['seps', 'Separations PDF', 'One page per ink for the pad plates, with registration marks'],
    ['eps', 'Vector EPS', 'Flat colours, one layer per ink'],
  ],
  sublimation: [
    ['png', 'Print PNG (300 dpi)', 'Transparent background, full colour'],
    ['pdf', 'Vector PDF', 'Actual size'],
  ],
  doming: [
    ['png', 'Print PNG (300 dpi)', 'Full colour sticker artwork'],
    ['pdf', 'Vector PDF', 'Actual size, the outline sets the sticker shape'],
    ['pdf-cut', 'Shape PDF', 'Outline only, for the sticker cut shape'],
  ],
  firing: [
    ['pdf', 'Vector PDF', 'Flat colours, one layer per ink, actual size'],
    ['seps', 'Separations PDF', 'One page per ink, with registration marks'],
    ['eps', 'Vector EPS', 'Flat colours, one layer per ink'],
  ],
  sandblast: [
    ['pdf-black', 'Stencil PDF', 'Solid black, actual size'],
    ['eps-black', 'Stencil EPS', 'Solid black, actual size'],
  ],
  emboss: [
    ['pdf-black', 'Die PDF', 'Solid black for the die maker, actual size'],
    ['eps-black', 'Die EPS', 'Solid black, actual size'],
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
  const list = [...EXPORTS[method]];
  // digital print can print a gradient: offer the original artwork first
  if (state.gradientArt && M.gradients) list.unshift(['png-gradient', 'Gradient PNG (300 dpi)', 'The original artwork with its gradient kept, upscaled, background cut out. Colour edits and added text made here aren\'t in it']);
  for (const [kind, title, sub] of list) {
    const b = document.createElement('button');
    b.append(Object.assign(document.createElement('b'), { textContent: title }), Object.assign(document.createElement('span'), { textContent: sub }));
    b.addEventListener('click', () => doExport(kind, method).catch(e => { console.error(e); toast('Export failed: ' + e.message, 5000); }));
    ex.appendChild(b);
  }
  const res = await runChecks(built, method);
  if (state.gradientArt && !M.gradients) res.issues.push({ level: 'info', text: `This logo has a gradient. ${M.label} can't print gradients, so it goes out as the flat inks shown. Gradients only print with DTG, DTF, sublimation or doming.` });
  const lost = editor.unexportable();
  if (lost.gradients.length) res.issues.unshift({ level: 'warn', text: `${lost.gradients.length} shape${lost.gradients.length > 1 ? 's have' : ' has'} a gradient fill and will be missing from these files. Use "Flatten gradients" below, or trace the logo instead.`, flatten: true });
  if (lost.pictures.length) res.issues.unshift({ level: 'warn', text: `${lost.pictures.length} pasted-in picture${lost.pictures.length > 1 ? 's' : ''} will be missing from these files: trace the logo to turn ${lost.pictures.length > 1 ? 'them' : 'it'} into vector.` });
  const live = [...new Set(editor.leaves().filter(o => o.visible && /text/i.test(o.type || '')).map(o => o.fontFamily))];
  if (live.length) res.issues.push({ level: 'warn', text: `This artwork still has live text (${live.join(', ')}). The printer may not have that font: use "Convert text to curves" in Colours first.` });
  if ($('#mirror').checked) res.issues = res.issues.filter(i => !/tick \"Mirror\"/.test(i.text));
  if (res.issues.some(i => i.level === 'warn')) res.issues = res.issues.filter(i => i.level !== 'ok');
  // built as text, never HTML: font names and other values come from imported files
  const checks = $('#checks'); checks.innerHTML = '';
  for (const i of res.issues) {
    const d = document.createElement('div'); d.className = i.level; d.textContent = i.text;
    if (i.flatten) {
      const b = Object.assign(document.createElement('button'), { className: 'stk-btn ghost small', type: 'button', textContent: 'Flatten gradients' });
      b.style.marginTop = '6px'; b.addEventListener('click', () => { const n = editor.flattenGradients(); toast(`Flattened ${n} gradient${n > 1 ? 's' : ''} to solid colours.`); });
      d.append(document.createElement('br'), b);
    }
    checks.appendChild(d);
  }
  const img = $('#checkPreview');
  img.hidden = !res.issues.some(i => i.level === 'warn');
  img.src = res.preview;
}
const refreshExportSoon = debounce(refreshExport, 400);
['#method', '#widthMm', '#mirror'].forEach(s => $(s).addEventListener('input', refreshExportSoon));

function saveEps(name, r) {
  if (r.skipped.length) toast(`EPS saved without ${r.skipped.join(', ')} items (pictures or live text). Use PDF for those.`, 5000);
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
    case 'png-gradient': {
      const r = await rasterPngBlob(state.gradientArt, o.widthMm, 300, o.mirror);
      toast(`Gradient PNG ${r.w} × ${r.h} px at ${r.dpi} dpi`);
      return download(base + '_gradient.png', r.blob);
    }
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
  if (!src) {
    // vector artwork: drag a box on the canvas, keep what's inside
    if (!editor.logo) return;
    setTool(null); editor.setTool('keep');
    toast('Drag a box around the logo you want to keep. Everything else is removed (Undo brings it back).', 6000);
    return;
  }
  crop.img.src = imageDataUrl(src);
  // show small logos enlarged so they're easy to crop
  const k = Math.min(Math.min(innerWidth * 0.85, 860) / src.width, innerHeight * 0.6 / src.height);
  Object.assign(crop.img.style, { width: Math.round(src.width * k) + 'px', height: Math.round(src.height * k) + 'px' });
  crop.rect = null; crop.box.hidden = true;
  crop.dlg.showModal();
});
$('#cropCancel').addEventListener('click', () => crop.dlg.close());
$('#cropReset').addEventListener('click', () => {
  if (state.uncropped) { state.original = state.uncropped; state.uncropped = null; state.upscaled.clear(); state.refit = true; run(); }
  crop.dlg.close();
});
$('#cropApply').addEventListener('click', () => {
  if (!crop.rect || crop.rect.w < 4 || crop.rect.h < 4) { toast('Drag across the part of the logo you want to keep.'); return; }
  const src = state.uncropped || state.original;
  const sx = src.width / crop.img.clientWidth, sy = src.height / crop.img.clientHeight;
  const x = Math.round(crop.rect.x * sx), y = Math.round(crop.rect.y * sy);
  const w = Math.max(1, Math.round(crop.rect.w * sx)), h = Math.max(1, Math.round(crop.rect.h * sy));
  crop.dlg.close();
  const pdf = state.pdfSource;
  if (pdf) {
    // from a PDF: draw just the cropped area again, sharp, instead of enlarging pixels
    const R = pdf.region, region = { x: R.x + x / src.width * R.w, y: R.y + y / src.height * R.h, w: w / src.width * R.w, h: h / src.height * R.h };
    renderRegion(pdf.page, region, 2400).then(id => {
      state.uncropped = src; state.original = id; state.upscaled.clear(); state.refit = true;
      $('#sourceInfo').textContent = `Cropped and re-drawn from the PDF at ${id.width} × ${id.height} px`;
      run();
    }).catch(e => { console.error(e); toast('Re-drawing from the PDF failed: ' + e.message, 5000); });
    return;
  }
  const c = new OffscreenCanvas(src.width, src.height); c.getContext('2d').putImageData(src, 0, 0);
  state.uncropped = src;
  state.original = c.getContext('2d').getImageData(x, y, w, h);
  state.upscaled.clear(); state.refit = true;
  $('#sourceInfo').textContent = `Cropped to ${w} × ${h} px` + (Math.max(w, h) < 600 ? ' · will be upscaled' : '');
  run();
});
const wrap = $('#cropWrap');
// the drag can start anywhere in the dialog (just outside the picture's
// edge is natural), not only on the picture itself; it is clamped to it
crop.dlg.addEventListener('pointerdown', e => {
  if (e.target.closest('button, .row') || e.button > 0) return;
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
