// Logo colour clean-up: find the handful of flat colours a logo is made of,
// then snap every pixel to one of them. Tracing a snapped image gives clean
// shapes with exact brand colours instead of JPEG haze and fringes.

const dist2 = (r1, g1, b1, r2, g2, b2) => {
  // weighted RGB distance, close to perceived difference and cheap
  const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
};

// Is colour m a mix of a and b? Projects m onto the a-b segment and checks it
// lands well inside the segment and close to it.
function isBlend(m, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], am = [m[0] - a[0], m[1] - a[1], m[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (len2 < 60 * 60) return false;
  const t = (am[0] * ab[0] + am[1] * ab[1] + am[2] * ab[2]) / len2;
  if (t < 0.08 || t > 0.92) return false;
  const p = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
  const off = Math.hypot(m[0] - p[0], m[1] - p[1], m[2] - p[2]);
  return off < Math.max(18, Math.sqrt(len2) * 0.12);
}

function segmentDistance(m, a, b) {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const len2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2] || 1;
  const t = Math.max(0, Math.min(1, ((m[0] - a[0]) * ab[0] + (m[1] - a[1]) * ab[1] + (m[2] - a[2]) * ab[2]) / len2));
  return Math.hypot(m[0] - a[0] - ab[0] * t, m[1] - a[1] - ab[1] * t, m[2] - a[2] - ab[2] * t);
}

function rng(seed) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// Returns [[r,g,b], ...] sorted by how much of the image each colour covers.
// `count` = 0 picks the number of colours automatically.
export function findPalette(imageData, { count = 0, mergeDistance = 42, minShare = 0.002 } = {}) {
  const d = imageData.data, n = imageData.width * imageData.height;
  const stride = Math.max(1, Math.floor(n / 40000));
  const pts = [];
  for (let i = 0; i < n; i += stride) if (d[i * 4 + 3] > 127) pts.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]);
  if (!pts.length) return [];
  const K = Math.min(count || 16, pts.length), rand = rng(7);

  // k-means++ seeding
  const cents = [pts[Math.floor(rand() * pts.length)].slice()];
  const best = new Float64Array(pts.length).fill(Infinity);
  while (cents.length < K) {
    const c = cents[cents.length - 1]; let sum = 0;
    for (let i = 0; i < pts.length; i++) { const p = pts[i]; best[i] = Math.min(best[i], dist2(p[0], p[1], p[2], c[0], c[1], c[2])); sum += best[i]; }
    if (!sum) break;
    let r = rand() * sum, j = 0;
    while (j < pts.length - 1 && (r -= best[j]) > 0) j++;
    cents.push(pts[j].slice());
  }
  const assign = new Int32Array(pts.length);
  for (let iter = 0; iter < 12; iter++) {
    const acc = cents.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]; let bi = 0, bd = Infinity;
      for (let k = 0; k < cents.length; k++) { const c = cents[k], dd = dist2(p[0], p[1], p[2], c[0], c[1], c[2]); if (dd < bd) { bd = dd; bi = k; } }
      assign[i] = bi; const a = acc[bi]; a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++;
    }
    acc.forEach((a, k) => { if (a[3]) cents[k] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  let clusters = cents.map((c, k) => ({ c, w: 0, k }));
  for (let i = 0; i < pts.length; i++) clusters[assign[i]].w++;
  clusters = clusters.filter(c => c.w > 0);

  if (!count) {
    // Auto: merge clusters that are really the same ink (JPEG noise, edge blends)
    const md2 = mergeDistance * mergeDistance * 9;
    let merged = true;
    while (merged && clusters.length > 1) {
      merged = false; let bi = -1, bj = -1, bd = Infinity;
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i].c, b = clusters[j].c, dd = dist2(a[0], a[1], a[2], b[0], b[1], b[2]);
        if (dd < bd) { bd = dd; bi = i; bj = j; }
      }
      if (bd < md2) {
        // keep the dominant colour rather than averaging toward the blend
        const [a, b] = clusters[bi].w >= clusters[bj].w ? [clusters[bi], clusters[bj]] : [clusters[bj], clusters[bi]];
        a.w += b.w; clusters.splice(clusters.indexOf(b), 1); merged = true;
      }
    }
    // A colour that sits on the line between two other colours is the
    // anti-aliased edge where they meet, not an ink of its own.
    const total = pts.length;
    clusters.sort((a, b) => b.w - a.w);
    clusters = clusters.filter((m, idx) => {
      if (m.w / total < minShare) return false;
      if (m.w / total > 0.15) return true;
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
        if (i === idx || j === idx) continue;
        const a = clusters[i], b = clusters[j];
        if (a.w < m.w || b.w < m.w) continue;
        if (isBlend(m.c, a.c, b.c)) return false;
      }
      return true;
    });
  }
  return clusters.sort((a, b) => b.w - a.w).map(c => c.c.map(Math.round));
}

// Snap every pixel to its nearest palette colour, then tidy stray pixels with
// a majority filter. Returns a new ImageData plus the label for each pixel.
export function snapToPalette(imageData, palette, { cleanPasses = 1, minArea } = {}) {
  const { width: w, height: h, data: d } = imageData;
  let labels = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    if (d[i * 4 + 3] <= 127) { labels[i] = 255; continue; }
    let bi = 0, bd = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const c = palette[k], dd = dist2(d[i * 4], d[i * 4 + 1], d[i * 4 + 2], c[0], c[1], c[2]);
      if (dd < bd) { bd = dd; bi = k; }
    }
    labels[i] = bi;
  }
  // Edge fix: an anti-aliased pixel between two inks can look like a third
  // ink (dark red + white blends to gold). If a pixel is a blend of two other
  // inks found right next to it, give it to the nearer of those two.
  {
    const fixed = labels.slice(), R = 2;
    for (let y = R; y < h - R; y++) for (let x = R; x < w - R; x++) {
      const i = y * w + x, L = labels[i];
      if (L === 255) continue;
      const seen = new Set();
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) { const l = labels[i + dy * w + dx]; if (l !== L) seen.add(l); }
      if (seen.size < 2) continue;
      const px = [d[i * 4], d[i * 4 + 1], d[i * 4 + 2]], ns = [...seen];
      // A pixel that is a good match for its own ink stays put, even if that
      // ink happens to sit between two others (gold between red and white).
      const own = palette[L], ownDist = Math.hypot(px[0] - own[0], px[1] - own[1], px[2] - own[2]);
      if (ownDist < 24) continue;
      let pick = -1, pd = Infinity;
      for (let a = 0; a < ns.length; a++) for (let b = a + 1; b < ns.length; b++) {
        const ca = ns[a] === 255 ? [255, 255, 255] : palette[ns[a]], cb = ns[b] === 255 ? [255, 255, 255] : palette[ns[b]];
        if (!isBlend(px, ca, cb) || segmentDistance(px, ca, cb) > ownDist * 0.5) continue;
        for (const l of [ns[a], ns[b]]) {
          const c = l === 255 ? [255, 255, 255] : palette[l], dd = dist2(px[0], px[1], px[2], c[0], c[1], c[2]);
          if (dd < pd) { pd = dd; pick = l; }
        }
      }
      if (pick >= 0) fixed[i] = pick;
    }
    labels = fixed;
  }
  const counts = new Uint16Array(256);
  for (let pass = 0; pass < cleanPasses; pass++) {
    const next = labels.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; let top = labels[i], topN = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) counts[labels[i + dy * w + dx]]++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const l = labels[i + dy * w + dx]; if (counts[l] > topN) { topN = counts[l]; top = l; }
      }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) counts[labels[i + dy * w + dx]] = 0;
      if (topN >= 5) next[i] = top;
    }
    labels = next;
  }
  labels = despeckle(labels, w, h, minArea ?? Math.max(16, Math.round(w * h / 15000)));
  const out = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const l = labels[i];
    if (l === 255) continue;
    const c = palette[l]; out.data[i * 4] = c[0]; out.data[i * 4 + 1] = c[1]; out.data[i * 4 + 2] = c[2]; out.data[i * 4 + 3] = 255;
  }
  return { imageData: out, labels };
}

// Merge islands smaller than minArea pixels into the colour that surrounds
// them most: stray specks, JPEG blotches, noise inside thin lines.
export function despeckle(labels, w, h, minArea) {
  const out = labels.slice(), seen = new Uint8Array(w * h), stack = [];
  for (let start = 0; start < w * h; start++) {
    if (seen[start]) continue;
    const L = labels[start], members = [], border = new Map();
    seen[start] = 1; stack.push(start);
    while (stack.length) {
      const i = stack.pop(), x = i % w;
      if (members.length <= minArea) members.push(i);
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < w * (h - 1) ? i + w : -1]) {
        if (j < 0) continue;
        if (labels[j] === L) { if (!seen[j]) { seen[j] = 1; stack.push(j); } }
        else if (members.length <= minArea) border.set(labels[j], (border.get(labels[j]) || 0) + 1);
      }
    }
    if (members.length > minArea || L === 255) continue;
    let best = L, bn = 0;
    for (const [l, n] of border) if (n > bn) { bn = n; best = l; }
    for (const i of members) out[i] = best;
  }
  return out;
}
