// Text is built from the font's glyph outlines (opentype.js), not live font
// text. What you see is exactly what the printer gets: no missing fonts, and
// every export is already "converted to outlines".

import { parse } from '../vendor/opentype.module.js';
import { assetUrl } from './assets.js';

export const FONTS = [
  // the house faces, from the Stacked design system (vendor/stacked-ds/fonts)
  { name: 'Gotham Rounded', weights: { Light: 'ds:GothamRounded-Light.otf', Book: 'ds:GothamRounded-Book.otf', Medium: 'ds:GothamRounded-Medium.otf', Bold: 'ds:GothamRounded-Bold.otf', 'Book Italic': 'ds:GothamRounded-BookItalic.otf', 'Bold Italic': 'ds:GothamRounded-BoldItalic.otf' } },
  { name: 'Gotham', weights: { Light: 'ds:Gotham-Light.otf', Book: 'ds:Gotham-Book.otf', Medium: 'ds:Gotham-Medium.otf', Bold: 'ds:Gotham-Bold.otf', Black: 'ds:Gotham-Black.otf', 'Light Italic': 'ds:Gotham-LightItalic.otf', 'Black Italic': 'ds:Gotham-BlackItalic.otf' } },
  { name: 'Inter', weights: { Regular: 'inter-latin-400-normal.woff', Bold: 'inter-latin-700-normal.woff', Black: 'inter-latin-900-normal.woff' } },
  { name: 'Montserrat', weights: { Regular: 'montserrat-latin-400-normal.woff', Bold: 'montserrat-latin-700-normal.woff', ExtraBold: 'montserrat-latin-800-normal.woff' } },
  { name: 'Oswald', weights: { Medium: 'oswald-latin-500-normal.woff', Bold: 'oswald-latin-700-normal.woff' } },
  { name: 'Bebas Neue', weights: { Regular: 'bebas-neue-latin-400-normal.woff' } },
  { name: 'Anton', weights: { Regular: 'anton-latin-400-normal.woff' } },
  { name: 'Playfair Display', weights: { Regular: 'playfair-display-latin-400-normal.woff', Italic: 'playfair-display-latin-400-italic.woff', Bold: 'playfair-display-latin-700-normal.woff' } },
  { name: 'Roboto Slab', weights: { Regular: 'roboto-slab-latin-400-normal.woff', Bold: 'roboto-slab-latin-700-normal.woff' } },
  { name: 'Pacifico', weights: { Regular: 'pacifico-latin-400-normal.woff' } },
  { name: 'Lobster', weights: { Regular: 'lobster-latin-400-normal.woff' } },
  { name: 'Permanent Marker', weights: { Regular: 'permanent-marker-latin-400-normal.woff' } },
];

const loaded = new Map();
export async function loadFont(file) {
  if (!loaded.has(file)) {
    const path = file.startsWith('ds:') ? `vendor/stacked-ds/fonts/${file.slice(3)}` : `fonts/${file}`;
    loaded.set(file, fetch(assetUrl(path)).then(r => r.arrayBuffer()).then(parse));
  }
  return loaded.get(file);
}

// A font file chosen by the user (e.g. the licensed brand font). It stays in
// this browser tab only.
export async function addFontFile(fileObj) {
  const font = parse(await fileObj.arrayBuffer());
  const key = 'user:' + fileObj.name;
  loaded.set(key, Promise.resolve(font));
  const family = font.names.fontFamily?.en || fileObj.name.replace(/\.[^.]+$/, '');
  const style = font.names.fontSubfamily?.en || 'Regular';
  let entry = FONTS.find(f => f.name === family);
  if (!entry) { entry = { name: family, weights: {}, user: true }; FONTS.push(entry); }
  entry.weights[style] = key;
  return { index: FONTS.indexOf(entry), style };
}

// spacing: extra space between letters in 1/1000 em (like design apps)
// curve: -100..100, 0 = straight, 100 = text wrapped round the top of a full circle
export function layoutText(font, text, { size = 72, spacing = 0, curve = 0 } = {}) {
  const scale = size / font.unitsPerEm;
  const glyphs = font.stringToGlyphs(text);
  const placed = [];
  let x = 0;
  glyphs.forEach((g, i) => {
    const adv = (g.advanceWidth || 0) * scale;
    placed.push({ g, x, adv });
    x += adv + spacing / 1000 * size;
    if (i < glyphs.length - 1) x += font.getKerningValue(g, glyphs[i + 1]) * scale;
  });
  const width = Math.max(1, x - spacing / 1000 * size);
  const span = Math.abs(curve) / 100 * 2 * Math.PI;   // arc angle covered by the text
  const R = span > 0.001 ? width / span : 0;

  const parts = [];
  for (const { g, x: gx, adv } of placed) {
    const cmds = g.getPath(0, 0, size).commands;
    if (!cmds.length) continue;
    const s = gx + adv / 2 - width / 2;     // glyph centre along the baseline
    let map;
    if (!R) {
      map = (px, py) => [px + gx - width / 2, py];
    } else {
      // top arc: circle centre below the text; bottom arc: centre above, letters stay upright
      const top = curve > 0, th = s / R, rot = top ? th : -th;
      const cx = R * Math.sin(th), cy = top ? R * (1 - Math.cos(th)) : -R * (1 - Math.cos(th));
      const c = Math.cos(rot), sn = Math.sin(rot);
      map = (px, py) => { const lx = px - adv / 2; return [cx + lx * c - py * sn, cy + lx * sn + py * c]; };
    }
    for (const cmd of cmds) {
      const p = (X, Y) => map(X, Y).map(v => +v.toFixed(2)).join(' ');
      if (cmd.type === 'M') parts.push('M' + p(cmd.x, cmd.y));
      else if (cmd.type === 'L') parts.push('L' + p(cmd.x, cmd.y));
      else if (cmd.type === 'Q') parts.push('Q' + p(cmd.x1, cmd.y1) + ' ' + p(cmd.x, cmd.y));
      else if (cmd.type === 'C') parts.push('C' + p(cmd.x1, cmd.y1) + ' ' + p(cmd.x2, cmd.y2) + ' ' + p(cmd.x, cmd.y));
      else if (cmd.type === 'Z') parts.push('Z');
    }
  }
  return parts.join('');
}
