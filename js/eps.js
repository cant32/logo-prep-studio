// EPS (and old PostScript-based .ai) → PDF, in the browser, with Ghostscript
// compiled to WebAssembly. The file never leaves the computer. The reader is
// 16 MB, so it's only loaded the first time an EPS is opened. The
// double-click copy of the app borrows it from the live server.

import { LIVE_SERVER } from './config.js';

let ready;
function loadGhostscript() {
  if (ready) return ready;
  const base = location.protocol.startsWith('http') ? new URL('../vendor/ghostscript/', import.meta.url).href : LIVE_SERVER + '/vendor/ghostscript/';
  ready = new Promise((ok, fail) => {
    const s = document.createElement('script');
    s.src = base + 'gs.js';
    s.onload = () => {
      // gs.js defines a global factory called Module; take it and tidy up
      const factory = globalThis.Module;
      try { globalThis.Module = undefined; } catch { /* left as is */ }
      if (typeof factory !== 'function') return fail(new Error('The EPS reader did not load.'));
      ok(factory);
    };
    s.onerror = () => fail(new Error('The EPS reader could not be downloaded. Check the internet connection.'));
    document.head.appendChild(s);
  }).catch(e => { ready = null; throw e; });
  ready.base = base;
  return ready;
}

// A fresh Ghostscript for each file (it isn't built to run twice).
export async function epsToPdf(bytes) {
  const factory = await loadGhostscript();
  const log = [];
  const gs = await factory({ locateFile: f => ready.base + f, print: s => log.push(s), printErr: s => log.push(s), noInitialRun: true });
  gs.FS.writeFile('/in.eps', bytes);
  // -dEPSCrop: page = the artwork's bounding box. -dNOINTERPOLATE etc. keep pictures as they are.
  const code = gs.callMain(['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET', '-dEPSCrop', '-sDEVICE=pdfwrite',
    '-dAutoRotatePages=/None', '-dCompatibilityLevel=1.7', '-o', '/out.pdf', '/in.eps']);
  let pdf = null;
  try { pdf = gs.FS.readFile('/out.pdf'); } catch { /* no output */ }
  if (code !== 0 || !pdf || pdf.length < 200) {
    console.warn('ghostscript', code, log.join('\n'));
    throw new Error('This EPS could not be read.');
  }
  return pdf;
}

// What a file really is, from its first bytes (names and types can't be trusted).
export function sniff(bytes) {
  const b = bytes.subarray ? bytes : new Uint8Array(bytes);
  const head = new TextDecoder('latin1').decode(b.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (b[0] === 0xc5 && b[1] === 0xd0 && b[2] === 0xd3 && b[3] === 0xc6) return 'eps';   // EPS with a preview picture
  if (head.startsWith('%!PS')) return 'eps';
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (/<svg\b/i.test(new TextDecoder().decode(b.subarray(0, 4000)))) return 'svg';
  return null;
}
