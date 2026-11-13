// "Clean geometry": an optional pass after tracing that makes a trace look
// redrawn by a designer rather than auto-traced. For every outline:
//  - a near-perfect circle or upright ellipse becomes an exact one
//  - curves that are really straight become straight lines, and runs of
//    lines in one direction become a single line (fewer anchor points)
//  - lines within 2° of horizontal, vertical or 45° are snapped exactly,
//    with the neighbouring curve handles moved along so nothing kinks
// Tolerances are small so organic shapes and lettering are left alone.

import { util } from '../vendor/fabric.min.js';

const TOL = 0.9;            // px: how far a "straight" curve may bow
const SNAP = 2 * Math.PI / 180;

const bez = (s, t) => {     // point on a segment at t
  if (s.t === 'L') return [s.p0[0] + (s.p1[0] - s.p0[0]) * t, s.p0[1] + (s.p1[1] - s.p0[1]) * t];
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return [a * s.p0[0] + b * s.c1[0] + c * s.c2[0] + d * s.p1[0], a * s.p0[1] + b * s.c1[1] + c * s.c2[1] + d * s.p1[1]];
};
const distToLine = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1;
  return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / L;
};

// commands (absolute M/L/C/Q/Z) -> subpaths of segments sharing point objects
function toSubpaths(cmds) {
  const subs = [];
  let cur = null, pen = null, start = null;
  for (const c of cmds) {
    if (c[0] === 'M') { pen = [c[1], c[2]]; start = pen; cur = { start, segs: [], closed: false }; subs.push(cur); }
    else if (c[0] === 'L') { const p = [c[1], c[2]]; cur.segs.push({ t: 'L', p0: pen, p1: p }); pen = p; }
    else if (c[0] === 'C') { const p = [c[5], c[6]]; cur.segs.push({ t: 'C', p0: pen, c1: [c[1], c[2]], c2: [c[3], c[4]], p1: p }); pen = p; }
    else if (c[0] === 'Q') { const p = [c[3], c[4]], q = [c[1], c[2]]; cur.segs.push({ t: 'C', p0: pen, c1: [pen[0] + 2 / 3 * (q[0] - pen[0]), pen[1] + 2 / 3 * (q[1] - pen[1])], c2: [p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1])], p1: p }); pen = p; }
    else if (c[0] === 'Z' || c[0] === 'z') {
      if (cur) {
        cur.closed = true;
        const last = cur.segs[cur.segs.length - 1];
        // make the outline end on the very point it started from (shared object)
        if (last && Math.hypot(last.p1[0] - start[0], last.p1[1] - start[1]) < 0.01) last.p1 = start;
        else if (last) cur.segs.push({ t: 'L', p0: pen, p1: start });
      }
      pen = start;
    } else return null;   // anything unusual: leave the path as it is
  }
  return subs.filter(s => s.segs.length);
}

function samples(sub) {
  const pts = [];
  for (const s of sub.segs) for (const t of s.t === 'L' ? [0] : [0, 0.25, 0.5, 0.75]) pts.push(bez(s, t));
  return pts;
}
const signedArea = pts => { let a = 0; for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

// a closed outline that is a circle / upright ellipse to within ~1.5%
function asEllipse(sub) {
  if (!sub.closed || sub.segs.length < 4) return null;
  const pts = samples(sub);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, a = (x1 - x0) / 2, b = (y1 - y0) / 2;
  if (a < 6 || b < 6 || a / b > 6 || b / a > 6) return null;
  let worst = 0;
  const bins = new Array(16).fill(false);
  for (const [x, y] of pts) {
    const r = Math.hypot((x - cx) / a, (y - cy) / b);
    worst = Math.max(worst, Math.abs(r - 1));
    bins[Math.floor(((Math.atan2((y - cy) / b, (x - cx) / a) + Math.PI) / (2 * Math.PI)) * 16) % 16] = true;
  }
  if (worst > Math.max(0.015, 1.2 / Math.min(a, b)) || bins.some(v => !v)) return null;
  const round = Math.abs(a - b) / Math.max(a, b) < 0.02;
  return { cx, cy, a: round ? (a + b) / 2 : a, b: round ? (a + b) / 2 : b, clockwise: signedArea(pts) > 0 };
}

function ellipsePath({ cx, cy, a, b, clockwise }) {
  const k = 0.5522847498, f = v => +v.toFixed(2);
  const P = [[cx + a, cy], [cx, cy + b], [cx - a, cy], [cx, cy - b]];   // y down: this order is clockwise on screen
  const order = clockwise ? [0, 1, 2, 3, 0] : [0, 3, 2, 1, 0];
  const tan = i => [[0, b * k], [-a * k, 0], [0, -b * k], [a * k, 0]][i];   // tangent (clockwise) at each point
  let d = `M${f(P[0][0])} ${f(P[0][1])}`;
  for (let i = 0; i < 4; i++) {
    const from = order[i], to = order[i + 1], s = clockwise ? 1 : -1;
    const t0 = tan(from), t1 = tan(to);
    d += `C${f(P[from][0] + s * t0[0])} ${f(P[from][1] + s * t0[1])} ${f(P[to][0] - s * t1[0])} ${f(P[to][1] - s * t1[1])} ${f(P[to][0])} ${f(P[to][1])}`;
  }
  return d + 'Z';
}

function straighten(sub) {
  for (const s of sub.segs) {
    if (s.t !== 'C') continue;
    const len = Math.hypot(s.p1[0] - s.p0[0], s.p1[1] - s.p0[1]);
    if (len < 3) continue;
    if (distToLine(s.c1, s.p0, s.p1) < TOL && distToLine(s.c2, s.p0, s.p1) < TOL && distToLine(bez(s, 0.5), s.p0, s.p1) < TOL * 0.6) { s.t = 'L'; delete s.c1; delete s.c2; }
  }
  // merge runs of lines heading the same way
  const out = [];
  for (const s of sub.segs) {
    const prev = out[out.length - 1];
    if (prev && prev.t === 'L' && s.t === 'L') {
      const a1 = Math.atan2(prev.p1[1] - prev.p0[1], prev.p1[0] - prev.p0[0]), a2 = Math.atan2(s.p1[1] - s.p0[1], s.p1[0] - s.p0[0]);
      let da = Math.abs(a1 - a2); if (da > Math.PI) da = 2 * Math.PI - da;
      if (da < 3 * Math.PI / 180 && distToLine(prev.p1, prev.p0, s.p1) < TOL * 0.6) { prev.p1 = s.p1; continue; }
    }
    out.push(s);
  }
  // re-link the shared points after merging
  for (let i = 1; i < out.length; i++) out[i].p0 = out[i - 1].p1;
  sub.segs = out;
}

function snap(sub) {
  // collect the moves first, then apply, so a corner can be snapped both ways
  const moves = new Map();   // point -> [dx, dy]
  const move = (p, dx, dy) => { const m = moves.get(p) || [0, 0]; if (dx) m[0] = dx; if (dy) m[1] = dy; moves.set(p, m); };
  for (const s of sub.segs) {
    if (s.t !== 'L') continue;
    const dx = s.p1[0] - s.p0[0], dy = s.p1[1] - s.p0[1], len = Math.hypot(dx, dy);
    if (len < 12) continue;
    const ang = Math.atan2(dy, dx), target = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
    if (Math.abs(ang - target) > SNAP || Math.abs(ang - target) < 1e-6) continue;
    const kind = Math.round(Math.abs(Math.cos(target)) * 2);   // 2: horizontal, 0: vertical, 1: diagonal
    if (kind === 2) { const y = (s.p0[1] + s.p1[1]) / 2; move(s.p0, 0, y - s.p0[1]); move(s.p1, 0, y - s.p1[1]); }
    else if (kind === 0) { const x = (s.p0[0] + s.p1[0]) / 2; move(s.p0, x - s.p0[0], 0); move(s.p1, x - s.p1[0], 0); }
    else {
      // exact 45°: keep the middle, project both ends onto the snapped direction
      const mx = (s.p0[0] + s.p1[0]) / 2, my = (s.p0[1] + s.p1[1]) / 2, ux = Math.cos(target), uy = Math.sin(target);
      for (const p of [s.p0, s.p1]) { const t = (p[0] - mx) * ux + (p[1] - my) * uy; move(p, mx + ux * t - p[0], my + uy * t - p[1]); }
    }
  }
  for (const [p, [dx, dy]] of moves) {
    // carry the handles next to a moved point along with it
    for (const s of sub.segs) {
      if (s.t !== 'C') continue;
      if (s.p0 === p) { s.c1[0] += dx; s.c1[1] += dy; }
      if (s.p1 === p) { s.c2[0] += dx; s.c2[1] += dy; }
    }
    p[0] += dx; p[1] += dy;
  }
}

function writeSub(sub) {
  const f = v => +v.toFixed(2);
  let d = `M${f(sub.segs[0].p0[0])} ${f(sub.segs[0].p0[1])}`;
  for (const s of sub.segs) d += s.t === 'L' ? `L${f(s.p1[0])} ${f(s.p1[1])}` : `C${f(s.c1[0])} ${f(s.c1[1])} ${f(s.c2[0])} ${f(s.c2[1])} ${f(s.p1[0])} ${f(s.p1[1])}`;
  return d + (sub.closed ? 'Z' : '');
}

// Returns { svg, stats } with stats.before / stats.after anchor counts and
// how many outlines became exact circles/ellipses.
export function cleanGeometry(svg) {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const stats = { before: 0, after: 0, ellipses: 0, snapped: 0 };
  for (const el of doc.querySelectorAll('path')) {
    let cmds;
    try { cmds = util.makePathSimpler(util.parsePath(el.getAttribute('d') || '')); } catch { continue; }
    const subs = toSubpaths(cmds);
    if (!subs) continue;
    let d = '';
    for (const sub of subs) {
      stats.before += sub.segs.length;
      const e = asEllipse(sub);
      if (e) { d += ellipsePath(e); stats.after += 4; stats.ellipses++; continue; }
      straighten(sub); snap(sub);
      stats.after += sub.segs.length;
      d += writeSub(sub);
    }
    el.setAttribute('d', d);
  }
  return { svg: new XMLSerializer().serializeToString(doc.documentElement), stats };
}
