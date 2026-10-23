// The design canvas (Fabric.js). Holds the vector logo as a group of ink
// shapes plus any text, and handles recolouring, knock-outs, erasing
// individual shapes, moving things around and undo.

import { Canvas, Group, Path, Point, Color, FabricObject, loadSVGFromString, util } from '../vendor/fabric.min.js';

// selection handles in brand orange
Object.assign(FabricObject.ownDefaults, { borderColor: '#ee7623', cornerColor: '#ee7623', cornerStrokeColor: '#25282a', cornerStyle: 'circle', transparentCorners: false, cornerSize: 11, borderScaleFactor: 1.5 });
import { layoutText, loadFont } from './text.js';

const KEEP = ['isLogo', 'isText', 'textProps', 'subTargetCheck', 'inkLocked'];

export const normColor = c => {
  if (!c || typeof c !== 'string' || c === 'none' || c === 'transparent') return null;
  try { return '#' + new Color(c).toHex().toLowerCase().slice(0, 6); } catch { return null; }
};

export class Editor {
  constructor(el, host, { onChange, onSelect } = {}) {
    this.host = host;
    this.onChange = onChange || (() => {});
    this.onSelect = onSelect || (() => {});
    this.canvas = new Canvas(el, { preserveObjectStacking: true, selectionColor: 'rgba(238,118,35,.1)', selectionBorderColor: '#ee7623' });
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
      const shape = e.target && e.target.isLogo ? e.subTargets && e.subTargets[0] : e.target;
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
    const { objects } = await loadSVGFromString(svg);
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
