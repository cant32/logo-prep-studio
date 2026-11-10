// The design canvas (Fabric.js). Holds the vector logo as a group of ink
// shapes plus any text, and handles recolouring, knock-outs, erasing
// individual shapes, moving things around and undo.

import { Canvas, Group, Path, Point, Color, FabricObject, loadSVGFromString, util } from '../vendor/fabric.min.js';

// selection handles in brand orange
Object.assign(FabricObject.ownDefaults, { borderColor: '#e87928', cornerColor: '#e87928', cornerStrokeColor: '#24272c', cornerStyle: 'circle', transparentCorners: false, cornerSize: 11, borderScaleFactor: 1.5 });
import { layoutText, loadFont, resolveFont, outlineText } from './text.js';

const KEEP = ['isLogo', 'isText', 'textProps', 'subTargetCheck', 'inkLocked'];

export const normColor = c => {
  if (!c || typeof c !== 'string' || c === 'none' || c === 'transparent') return null;
  try { return '#' + new Color(c).toHex().toLowerCase().slice(0, 6); } catch { return null; }
};

// Designers' files often keep a whole wordmark as one compound path, so a
// click would paint or delete every letter at once. Split each compound path
// into its separate pieces: every outer outline keeps the holes inside it
// (the counter of an "o" stays with the "o"), so it looks exactly the same.
export function splitCompoundPaths(svg) {
  if (!/<path\b[^>]*\sd\s*=\s*["'][^"']*[Mm][^"']*[Mm]/.test(svg)) return svg;   // nothing compound
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  if (doc.querySelector('parsererror')) return svg;
  const ctx = new OffscreenCanvas(1, 1).getContext('2d');
  let changed = false;
  for (const el of doc.querySelectorAll('path')) {
    let rule = '';
    for (let n = el; n && n.getAttribute && !rule; n = n.parentNode) rule = n.getAttribute('fill-rule') || (/fill-rule\s*:\s*(\w+)/.exec(n.getAttribute('style') || '') || [])[1] || '';
    const pieces = splitPathData(el.getAttribute('d') || '', ctx, rule === 'evenodd');
    if (!pieces || pieces.length < 2) continue;
    for (const d of pieces) {
      const copy = el.cloneNode(false);
      copy.removeAttribute('id');
      copy.setAttribute('d', d);
      el.parentNode.insertBefore(copy, el);
    }
    el.remove();
    changed = true;
  }
  return changed ? new XMLSerializer().serializeToString(doc.documentElement) : svg;
}

function splitPathData(d, ctx, evenodd) {
  let cmds;
  try { cmds = util.makePathSimpler(util.parsePath(d)); } catch { return null; }
  const subs = [];
  for (const c of cmds) { if (c[0] === 'M' || !subs.length) subs.push([]); subs[subs.length - 1].push(c); }
  if (subs.length < 2 || subs.length > 3000) return null;
  const info = subs.map(cs => {
    const xs = [], ys = [];
    for (const c of cs) for (let i = 1; i + 1 < c.length; i += 2) { xs.push(c[i]); ys.push(c[i + 1]); }
    const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    // a point on this outline, to ask which other outline it sits inside
    const p = cs[0][0] === 'M' ? [cs[0][1], cs[0][2]] : [xs[0], ys[0]];
    return { cs, box, area: (box.x1 - box.x0) * (box.y1 - box.y0), p, path: new Path2D(util.joinPath(cs)), parent: -1, depth: 0 };
  });
  // parent = the smallest larger outline that contains this one
  const order = info.map((_, i) => i).sort((a, b) => info[b].area - info[a].area);
  order.forEach((i, k) => {
    const s = info[i];
    for (let j = k - 1; j >= 0; j--) {
      const o = info[order[j]];
      if (s.box.x0 < o.box.x0 - 1e-6 || s.box.y0 < o.box.y0 - 1e-6 || s.box.x1 > o.box.x1 + 1e-6 || s.box.y1 > o.box.y1 + 1e-6) continue;
      if (ctx.isPointInPath(o.path, s.p[0], s.p[1])) { s.parent = order[j]; s.depth = o.depth + 1; break; }
    }
  });
  // even depth = a piece, odd depth = a hole in its parent piece
  const tops = info.filter(s => s.depth % 2 === 0);
  if (tops.length < 2) return null;
  // with even-odd filling, pieces that overlap each other cancel out where
  // they cross; splitting would fill that in, so leave such paths whole
  const within = (s, o) => { for (let p = s.parent; p >= 0; p = info[p].parent) if (info[p] === o) return true; return false; };
  if (evenodd) for (let a = 0; a < tops.length; a++) for (let b = a + 1; b < tops.length; b++) {
    const A = tops[a].box, B = tops[b].box;
    if (A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1 && !within(tops[a], tops[b]) && !within(tops[b], tops[a])) {
      // overlapping boxes: only a problem if the outlines really cross
      if (ctx.isPointInPath(tops[a].path, tops[b].p[0], tops[b].p[1]) || ctx.isPointInPath(tops[b].path, tops[a].p[0], tops[a].p[1])) return null;
    }
  }
  return tops.map(t => {
    const i = info.indexOf(t);
    return util.joinPath([...t.cs, ...info.filter(h => h.parent === i && h.depth % 2 === 1).flatMap(h => h.cs)]);
  });
}

export class Editor {
  constructor(el, host, { onChange, onSelect } = {}) {
    this.host = host;
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.canvas = new Canvas(el, { preserveObjectStacking: true, selectionColor: 'rgba(232,121,40,.1)', selectionBorderColor: '#e87928' });
    this.tool = null;          // null | 'erase' | 'paint'
    this.paintColor = '#000000';
    this.history = [];
    this.resize();
    new ResizeObserver(() => this.resize()).observe(host);

    const c = this.canvas;
    c.on('object:modified', () => this.commit());
    c.on('selection:created', () => this.onSelect(c.getActiveObject()));
    c.on('selection:updated', () => this.onSelect(c.getActiveObject()));
    c.on('selection:cleared', () => this.onSelect(null));
    c.on('mouse:down', e => {
      if (!this.tool) return;
      const shape = this.shapeAt(c.getViewportPoint(e.e), c.getScenePoint(e.e));
      if (!shape) return;
      if (this.tool === 'erase') {
        if (shape.group) shape.group.remove(shape); else c.remove(shape);
      } else {
        shape.set('fill', this.paintColor);
        if (shape.isText) shape.textProps.color = this.paintColor;
      }
      c.discardActiveObject();
      c.requestRenderAll();
      this.commit();
    });
  }

  // The shape actually painted under a screen point, topmost first. Fabric
  // only checks bounding boxes, which picks the wrong shape whenever boxes
  // overlap (holes, rings, letters inside a badge). Each candidate is drawn
  // into a tiny canvas around the point to see if it really covers it; if
  // nothing is exactly under the point, a shape within a few pixels counts.
  shapeAt(pt, scene) {
    const R = 4, size = R * 2 + 1;
    const ctx = (this._hit ||= new OffscreenCanvas(size, size)).getContext('2d', { willReadFrequently: true });
    const vt = this.canvas.viewportTransform;
    const candidates = this.leaves().filter(o => this.isShown(o) && o.visible !== false).reverse();
    let near = null;
    for (const o of candidates) {
      const b = o.getBoundingRect(), r = R / (vt[0] || 1);   // box in scene units: a cheap first filter
      if (scene.x < b.left - r || scene.x > b.left + b.width + r || scene.y < b.top - r || scene.y > b.top + b.height + r) continue;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, size, size);
      ctx.setTransform(...util.multiplyTransformMatrices([1, 0, 0, 1, R - pt.x, R - pt.y], util.multiplyTransformMatrices(vt, o.calcTransformMatrix())));
      ctx.fillStyle = ctx.strokeStyle = '#000';
      ctx.lineWidth = o.strokeWidth || 0;
      ctx.globalAlpha = 1;
      try { o._render(ctx); } catch { continue; }
      const px = ctx.getImageData(0, 0, size, size).data;
      if (px[(R * size + R) * 4 + 3] > 20) return o;
      if (!near) for (let i = 3; i < px.length; i += 4) if (px[i] > 20) { near = o; break; }
    }
    return near;
  }

  // false for shapes inside a hidden group
  isShown(o) { for (let g = o.group; g; g = g.group) if (g.visible === false) return false; return true; }

  resize() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const prev = { w: this.canvas.width, h: this.canvas.height };
    this.canvas.setDimensions({ width: r.width, height: r.height });
    // keep the design in view when the window or layout changes size
    if (this.canvas.getObjects().length && (Math.abs(prev.w - r.width) > 40 || Math.abs(prev.h - r.height) > 40)) this.fitAll();
    this.canvas.requestRenderAll();
  }

  get logo() { return this.canvas.getObjects().find(o => o.isLogo) || null; }

  // Replace the logo with new vector artwork (an SVG string).
  async setLogo(svg) {
    const { objects } = await loadSVGFromString(splitCompoundPaths(svg));
    const shapes = objects.filter(Boolean);
    for (const s of shapes) {
      s.fill = normColor(s.fill) || s.fill;
      if (s.stroke) s.stroke = normColor(s.stroke) || s.stroke;
      s.objectCaching = false;
    }
    const old = this.logo;
    const group = new Group(shapes, { subTargetCheck: true, isLogo: true, objectCaching: false });
    if (old) {
      // keep the logo where the user put it, at the same on-screen width
      group.scaleToWidth(old.getScaledWidth());
      group.setPositionByOrigin(old.getCenterPoint(), 'center', 'center');
      this.canvas.remove(old);
    } else {
      this.fit(group);
    }
    this.canvas.insertAt(0, group);
    this.canvas.requestRenderAll();
    this.commit();
  }

  // Vector files often carry a white page-sized box behind the logo. Remove a
  // near-white shape that covers almost the whole artwork. Returns true if one went.
  removePageBackground() {
    const logo = this.logo;
    if (!logo) return false;
    const all = logo.getBoundingRect(), area = all.width * all.height;
    const bg = logo.getObjects().find(o => {
      const c = normColor(o.fill);
      if (!c || o.stroke && normColor(o.stroke)) return false;
      const [r, g, b] = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
      const br = o.getBoundingRect();
      return r > 245 && g > 245 && b > 245 && br.width * br.height > area * 0.92;
    });
    if (!bg) return false;
    logo.remove(bg);
    this.fit(logo);
    this.canvas.requestRenderAll();
    this.commit();
    return true;
  }

  fit(obj, share = 0.72) {
    const W = this.canvas.width, H = this.canvas.height;
    const s = Math.min(W * share / obj.width, H * share / obj.height);
    obj.set({ scaleX: s, scaleY: s });
    obj.setPositionByOrigin(new Point(W / 2, H / 2), 'center', 'center');
  }

  fitAll() {
    const objs = this.canvas.getObjects();
    if (!objs.length) return;
    let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
    for (const o of objs) { const br = o.getBoundingRect(); l = Math.min(l, br.left); t = Math.min(t, br.top); r = Math.max(r, br.left + br.width); b = Math.max(b, br.top + br.height); }
    const W = this.canvas.width, H = this.canvas.height;
    const s = Math.min(W * 0.8 / (r - l), H * 0.8 / (b - t));
    const cx = (l + r) / 2, cy = (t + b) / 2;
    for (const o of objs) {
      const c = o.getCenterPoint();
      o.set({ scaleX: o.scaleX * s, scaleY: o.scaleY * s });
      o.setPositionByOrigin(new Point(W / 2 + (c.x - cx) * s, H / 2 + (c.y - cy) * s), 'center', 'center');
      o.setCoords();
    }
    this.canvas.requestRenderAll();
  }

  // Every printable shape, flattened out of groups.
  leaves() {
    const out = [];
    const walk = o => {
      if (o instanceof Group) o.getObjects().forEach(walk);
      else out.push(o);
    };
    this.canvas.getObjects().forEach(walk);
    return out;
  }

  // Live text that came in with the artwork (not our outlined Text tool paths).
  liveTexts() {
    return this.leaves().filter(o => typeof o.text === 'string' && !o.isText);
  }

  // Replace live text with outlines. The app's own fonts go first; only the
  // leftovers ask for the computer's installed fonts (a permission prompt in
  // Chrome). Returns { done: [font names], missing: [font names] }.
  async convertLiveText({ askComputer = false } = {}) {
    const done = [];
    const pass = async computer => {
      for (const t of this.liveTexts()) {
        const found = await resolveFont(t.fontFamily, t.fontWeight, t.fontStyle, { askComputer: computer });
        if (!found) continue;
        const d = outlineText(found.font, t);
        if (!d) continue;
        const p = new Path(d, { fill: t.fill, stroke: t.stroke, strokeWidth: t.strokeWidth, opacity: t.opacity, visible: t.visible, objectCaching: false });
        // the outline sits exactly where the text was (in canvas coordinates: a group converts them on the way in)
        util.applyTransformToObject(p, util.multiplyTransformMatrices(t.calcTransformMatrix(), [1, 0, 0, 1, p.pathOffset.x, p.pathOffset.y]));
        const parent = t.group || this.canvas;
        const i = parent.getObjects().indexOf(t);
        parent.remove(t);
        parent.insertAt(i, p);
        done.push(found.name);
      }
    };
    await pass(false);
    if (askComputer && this.liveTexts().length) await pass(true);
    if (done.length) { this.canvas.requestRenderAll(); this.commit(); }
    const missing = [...new Set(this.liveTexts().map(t => String(t.fontFamily).split(',')[0].replace(/['"]/g, '').trim()))];
    return { done, missing };
  }

  // Inks in use: [{ color, count, hidden }] ordered by how much they're used.
  inks() {
    const m = new Map();
    for (const o of this.leaves()) {
      for (const c of [normColor(o.fill), normColor(o.stroke)]) {
        if (!c) continue;
        const e = m.get(c) || { color: c, count: 0, hidden: true };
        e.count += 1;
        if (o.visible) e.hidden = false;
        m.set(c, e);
      }
    }
    return [...m.values()].sort((a, b) => b.count - a.count);
  }

  recolor(from, to) {
    to = normColor(to);
    if (!to || from === to) return;
    for (const o of this.leaves()) {
      if (normColor(o.fill) === from) o.set('fill', to);
      if (normColor(o.stroke) === from) o.set('stroke', to);
      if (o.isText) o.textProps.color = normColor(o.fill);
    }
    this.canvas.requestRenderAll();
    this.commit();
  }

  // Hiding an ink knocks it out: the garment shows through.
  setInkHidden(color, hidden) {
    for (const o of this.leaves()) if (normColor(o.fill) === color || (!o.fill && normColor(o.stroke) === color)) o.visible = !hidden;
    this.canvas.requestRenderAll();
    this.commit();
  }

  get erasing() { return this.tool === 'erase'; }

  setTool(tool) {
    this.tool = tool;
    this.canvas.defaultCursor = tool ? 'crosshair' : 'default';
    this.canvas.hoverCursor = tool ? 'crosshair' : 'move';
    for (const o of this.canvas.getObjects()) o.selectable = !tool;
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
  }

  // Text -------------------------------------------------------------------

  async buildTextPath(p) {
    const font = await loadFont(p.file);
    const d = layoutText(font, p.text || ' ', p);
    return new Path(d || 'M0 0', { fill: p.color, isText: true, textProps: { ...p }, objectCaching: false });
  }

  async addText(p) {
    const t = await this.buildTextPath(p);
    const W = this.canvas.width, H = this.canvas.height;
    const logo = this.logo;
    const at = logo ? new Point(logo.getCenterPoint().x, logo.getBoundingRect().top + logo.getBoundingRect().height + t.height / 2 + 16) : new Point(W / 2, H / 2);
    t.setPositionByOrigin(new Point(Math.min(at.x, W), Math.min(at.y, H - t.height / 2)), 'center', 'center');
    this.canvas.add(t);
    this.canvas.setActiveObject(t);
    this.canvas.requestRenderAll();
    this.commit();
    return t;
  }

  async updateText(obj, p) {
    const t = await this.buildTextPath(p);
    t.set({ angle: obj.angle, scaleX: obj.scaleX, scaleY: obj.scaleY, flipX: obj.flipX, flipY: obj.flipY });
    t.setPositionByOrigin(obj.getCenterPoint(), 'center', 'center');
    const i = this.canvas.getObjects().indexOf(obj);
    this.canvas.remove(obj);
    this.canvas.insertAt(i, t);
    this.canvas.setActiveObject(t);
    this.canvas.requestRenderAll();
    this.commit();
    return t;
  }

  deleteSelected() {
    const sel = this.canvas.getActiveObjects();
    if (!sel.length) return;
    sel.forEach(o => this.canvas.remove(o));
    this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
    this.commit();
  }

  // Undo -------------------------------------------------------------------

  commit() {
    this.history.push(JSON.stringify(this.canvas.toObject(KEEP)));
    if (this.history.length > 40) this.history.shift();
    this.onChange();
  }

  async undo() {
    if (this.history.length < 2) return;
    this.history.pop();
    await this.canvas.loadFromJSON(JSON.parse(this.history[this.history.length - 1]));
    for (const o of this.canvas.getObjects()) o.selectable = !this.tool;
    this.canvas.requestRenderAll();
    this.onChange();
  }

  clear() {
    this.canvas.clear();
    this.history = [];
    this.onChange();
  }
}

export { util };
