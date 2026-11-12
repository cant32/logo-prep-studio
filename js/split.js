// Split PDF: pick pages from a multi-page PDF (or a PDF-based .ai) and save
// them as their own PDFs. Pages are copied exactly as they are, vector,
// fonts and colours untouched, with pdf-lib; nothing is redrawn. Everything
// happens in the browser: the file is never uploaded.

import { assetUrl } from './assets.js';
import { openPdf } from './pdf.js';
import { download } from './export.js';

const $ = s => document.querySelector(s);

let loading;
function pdfLib() {
  if (globalThis.PDFLib) return Promise.resolve(globalThis.PDFLib);
  return loading ||= new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = assetUrl('vendor/pdf-lib/pdf-lib.min.js');
    s.onload = () => globalThis.PDFLib ? ok(globalThis.PDFLib) : fail(new Error('The PDF tools did not load.'));
    s.onerror = () => { loading = null; fail(new Error('The PDF tools could not be loaded.')); };
    document.head.appendChild(s);
  });
}

const baseName = name => (name || 'document').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_') || 'document';

// Copy the given pages (1-based) into new PDFs: one file per page, or one file with them all.
export async function savePages(bytes, name, pages, { together = false } = {}) {
  const { PDFDocument } = await pdfLib();
  let src;
  try { src = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }); }
  catch (e) { console.error(e); throw new Error('This PDF could not be opened for splitting. It may be damaged or password-protected.'); }
  const make = async list => {
    const out = await PDFDocument.create();
    const copied = await out.copyPages(src, list.map(n => n - 1));
    copied.forEach(p => out.addPage(p));
    out.setProducer('Logo Prep Studio'); out.setCreator('Logo Prep Studio');
    return out.save();
  };
  const base = baseName(name);
  if (together || pages.length === 1) {
    const label = pages.length === 1 ? `page-${pages[0]}` : `pages-${pages.join('-')}`.slice(0, 60);
    await download(`${base}_${label}.pdf`, await make(pages), 'application/pdf');
    return 1;
  }
  for (const n of pages) {
    await download(`${base}_page-${n}.pdf`, await make([n]), 'application/pdf');
    await new Promise(r => setTimeout(r, 350));   // browsers drop downloads fired all at once
  }
  return pages.length;
}

// ---------------------------------------------------------------- dialog

const state = { bytes: null, name: '', selected: new Set(), pages: 0 };
const toast = (msg, ms) => window.dispatchEvent(new CustomEvent('lps-toast', { detail: { msg, ms } }));

function refreshButtons() {
  const n = state.selected.size;
  $('#splitEach').disabled = !n;
  $('#splitOne').disabled = n < 2;
  $('#splitEach').textContent = n > 1 ? `Download ${n} pages as separate PDFs` : 'Download page as PDF';
  $('#splitAll').textContent = state.pages && n === state.pages ? 'Clear selection' : 'Select all';
  $('#splitAll').hidden = state.pages < 2;
}

async function showFile(file) {
  const grid = $('#splitGrid'), info = $('#splitInfo');
  grid.innerHTML = ''; state.selected.clear(); state.pages = 0; refreshButtons();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!new TextDecoder('latin1').decode(bytes.subarray(0, 1024)).includes('%PDF-')) {
    info.textContent = 'That isn\'t a PDF. Choose a PDF, or an .ai file saved with PDF compatibility.';
    return;
  }
  state.bytes = bytes; state.name = file.name || 'document.pdf';
  info.textContent = `Opening ${state.name}…`;
  let doc;
  try { doc = await openPdf(bytes.slice().buffer); }
  catch { info.textContent = 'That PDF could not be read.'; return; }
  state.pages = doc.numPages;
  info.textContent = `${state.name}: ${doc.numPages} page${doc.numPages > 1 ? 's' : ''}. Tick the pages you want.`;
  for (let n = 1; n <= doc.numPages; n++) {
    const card = document.createElement('button');
    card.type = 'button'; card.className = 'stk-pick ui splitpage'; card.setAttribute('aria-pressed', 'false');
    card.innerHTML = `<span class="thumb"><canvas></canvas></span><span class="kind">Page ${n}</span><span class="from"></span>`;
    card.addEventListener('click', () => {
      state.selected.has(n) ? state.selected.delete(n) : state.selected.add(n);
      card.setAttribute('aria-pressed', state.selected.has(n)); card.classList.toggle('on', state.selected.has(n));
      refreshButtons();
    });
    grid.appendChild(card);
    // thumbnail and size, a page at a time so big files stay responsive
    const page = await doc.getPage(n);
    const [x0, y0, x1, y1] = page.view, mm = v => Math.round(Math.abs(v) / 72 * 25.4);
    card.querySelector('.from').textContent = `${mm(x1 - x0)} × ${mm(y1 - y0)} mm`;
    const base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: 240 / Math.max(base.width, base.height) });
    const c = card.querySelector('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: x, viewport: vp }).promise.catch(() => {});
  }
  if (doc.numPages === 1) { state.selected.add(1); grid.firstChild.classList.add('on'); grid.firstChild.setAttribute('aria-pressed', 'true'); refreshButtons(); }
}

export function openSplit(file) {
  const dlg = $('#splitDlg');
  if (!dlg.open) dlg.showModal();
  if (file) showFile(file).catch(e => { console.error(e); $('#splitInfo').textContent = 'That PDF could not be read.'; });
}

export function initSplit() {
  $('#splitFile').addEventListener('change', e => { if (e.target.files[0]) showFile(e.target.files[0]); e.target.value = ''; });
  $('#splitClose').addEventListener('click', () => $('#splitDlg').close());
  $('#splitAll').addEventListener('click', () => {
    const all = state.selected.size !== state.pages;
    state.selected = new Set(all ? Array.from({ length: state.pages }, (_, i) => i + 1) : []);
    document.querySelectorAll('#splitGrid .splitpage').forEach((c, i) => { c.classList.toggle('on', all); c.setAttribute('aria-pressed', all); });
    refreshButtons();
  });
  const go = together => async () => {
    const pages = [...state.selected].sort((a, b) => a - b);
    if (!pages.length || !state.bytes) return;
    try {
      const files = await savePages(state.bytes, state.name, pages, { together });
      toast(files === 1 ? 'Saved as a PDF.' : `Saved ${files} PDFs.`);
    } catch (e) { console.error(e); toast(e.message, 6000); }
  };
  $('#splitEach').addEventListener('click', go(false));
  $('#splitOne').addEventListener('click', go(true));
  // drop a PDF straight onto the open dialog
  $('#splitDlg').addEventListener('dragover', e => e.preventDefault());
  $('#splitDlg').addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files[0]) showFile(e.dataTransfer.files[0]); });
  refreshButtons();
}
