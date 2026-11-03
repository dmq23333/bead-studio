export { default as palette } from "./mard221.mjs?v=palette-20261028";
export function rgb(h) {
  return [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
}
export function lab(c) {
  let [r, g, b] = c.map((v) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
  let a = [
    (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047,
    r * 0.2126 + g * 0.7152 + b * 0.0722,
    (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883,
  ].map((v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116));
  return [116 * a[1] - 16, 500 * (a[0] - a[1]), 200 * (a[1] - a[2])];
}
// CIEDE2000 color difference (Sharma et al. 2005)
export function deltaE(x, y) {
  const rad = Math.PI / 180,
    [L1, a1, b1] = x,
    [L2, a2, b2] = y;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2,
    G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G),
    a2p = a2 * (1 + G),
    C1 = Math.hypot(a1p, b1),
    C2 = Math.hypot(a2p, b2);
  const hue = (a, b) => (a || b ? (Math.atan2(b, a) / rad + 360) % 360 : 0);
  const h1 = hue(a1p, b1),
    h2 = hue(a2p, b2),
    chroma = C1 * C2 !== 0;
  let dh = chroma ? h2 - h1 : 0;
  if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dL = L2 - L1,
    dC = C2 - C1,
    dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2,
    Cp = (C1 + C2) / 2;
  let hb = h1 + h2;
  if (chroma)
    hb = Math.abs(h1 - h2) > 180 ? (hb + (hb < 360 ? 360 : -360)) / 2 : hb / 2;
  const T =
    1 -
    0.17 * Math.cos((hb - 30) * rad) +
    0.24 * Math.cos(2 * hb * rad) +
    0.32 * Math.cos((3 * hb + 6) * rad) -
    0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2),
    SC = 1 + 0.045 * Cp,
    SH = 1 + 0.015 * Cp * T,
    RT =
      -Math.sin(2 * 30 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad) *
      2 *
      Math.sqrt(Cp ** 7 / (Cp ** 7 + 25 ** 7));
  return Math.sqrt(
    (dL / SL) ** 2 +
      (dC / SC) ** 2 +
      (dH / SH) ** 2 +
      RT * (dC / SC) * (dH / SH),
  );
}
// Nearest color among `indices`, cached per 6-bit-per-channel RGB bucket.
// ponytail: bucket step is 4/255, two palette colors that close would share a bucket
function matcher(labs, indices) {
  const lut = new Int16Array(1 << 18).fill(-1);
  return (r, g, b) => {
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    if (lut[key] < 0) {
      const c = lab([(r & 252) + 2, (g & 252) + 2, (b & 252) + 2]);
      // cheap Lab distance shortlists 8 candidates, CIEDE2000 picks among them
      const top = [],
        topD = [];
      for (const j of indices) {
        const l = labs[j],
          d = (c[0] - l[0]) ** 2 + (c[1] - l[1]) ** 2 + (c[2] - l[2]) ** 2;
        if (top.length === 8 && d >= topD[7]) continue;
        let p = Math.min(top.length, 7);
        while (p > 0 && topD[p - 1] > d) {
          top[p] = top[p - 1];
          topD[p] = topD[p - 1];
          p--;
        }
        top[p] = j;
        topD[p] = d;
      }
      const shortlist = top;
      let best = shortlist[0],
        bestD = Infinity;
      for (const j of shortlist) {
        const d = deltaE(c, labs[j]);
        if (d < bestD) (bestD = d), (best = j);
      }
      lut[key] = best;
    }
    return lut[key];
  };
}
// CIEDE2000 thresholds, starting values: tune against real photos and illustrations.
const DISTINCT_DELTA = 8, // top colors closer than this yield their slot to more distinct ones
  CLEAN_DELTA = 45, // lone cells this different from their neighbors are detail, not noise (shades of skin ≈ 28, black on skin ≈ 69)
  MIN_SHARE = 0.001, // colors below this share of pixels are noise, not candidates for a slot
  MERGE_DELTA = 15, // rare colors merge only into a main color this close
  RARE_SHARE = 0.01;
// Pick n colors, scoring coverage × distance from those already picked so a gradient
// can't crowd out small dark eyes; near-duplicates only fill slots left over.
export function topColors(data, colors, n) {
  const labs = colors.map((p) => lab(rgb(p.hex)));
  const all = matcher(
    labs,
    colors.map((_, i) => i),
  );
  const counts = Array(colors.length).fill(0);
  for (let i = 0; i < data.length; i += 4)
    if (data[i + 3] >= 128) counts[all(data[i], data[i + 1], data[i + 2])]++;
  const ranked = counts
    .map((n, i) => ({ n, i }))
    .filter((x) => x.n)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.i);
  const total = ranked.reduce((sum, i) => sum + counts[i], 0),
    picked = ranked.slice(0, Math.min(1, n)),
    gap = new Map();
  while (picked.length < n) {
    const last = picked[picked.length - 1];
    let best = null,
      bestScore = 0;
    for (const i of ranked) {
      if (picked.includes(i) || counts[i] < total * MIN_SHARE) continue;
      const d = Math.min(gap.get(i) ?? Infinity, deltaE(labs[i], labs[last]));
      gap.set(i, d);
      const score = Math.sqrt(counts[i]) * d;
      if (d >= DISTINCT_DELTA && score > bestScore)
        (bestScore = score), (best = i);
    }
    if (best === null) break;
    picked.push(best);
  }
  for (const i of ranked)
    if (picked.length < n && !picked.includes(i)) picked.push(i);
  return picked;
}
// Merge colors under RARE_SHARE into a close main color; rare but contrasting ones
// (eyes, highlights) stay.
function mergeRare(cells, labs) {
  const counts = new Map();
  let total = 0;
  for (const c of cells)
    if (c !== null) counts.set(c, (counts.get(c) || 0) + 1), total++;
  const main = [...counts.keys()].filter(
    (c) => counts.get(c) >= total * RARE_SHARE,
  );
  const into = new Map();
  for (const c of counts.keys()) {
    if (main.includes(c)) continue;
    let best = null,
      bestD = MERGE_DELTA;
    for (const m of main) {
      const d = deltaE(labs[c], labs[m]);
      if (d < bestD) (bestD = d), (best = m);
    }
    if (best !== null) into.set(c, best);
  }
  return cells.map((c) => (into.has(c) ? into.get(c) : c));
}
// Per-channel median over a (2r+1)² window (Huang's sliding histogram), in place; alpha untouched.
export function medianFilter(data, w, h, r) {
  const src = data.slice();
  for (let ch = 0; ch < 3; ch++)
    for (let y = 0; y < h; y++) {
      const hist = new Int32Array(256),
        y0 = Math.max(0, y - r),
        y1 = Math.min(h - 1, y + r);
      let med = 0,
        below = 0,
        total = 0;
      const column = (x, sign) => {
        for (let yy = y0; yy <= y1; yy++) {
          const v = src[(yy * w + x) * 4 + ch];
          hist[v] += sign;
          total += sign;
          if (v < med) below += sign;
        }
      };
      for (let x = 0; x <= Math.min(w - 1, r); x++) column(x, 1);
      for (let x = 0; x < w; x++) {
        if (x > r) column(x - r - 1, -1);
        if (x > 0 && x + r < w) column(x + r, 1);
        const half = total >> 1;
        while (below > half) below -= hist[--med];
        while (below + hist[med] <= half) below += hist[med++];
        data[(y * w + x) * 4 + ch] = med;
      }
    }
  return data;
}
// data is (w*scale)×(h*scale) RGBA; each scale×scale block votes for its cell's color.
export function convert(
  data,
  w,
  h,
  colors,
  maxColors = 12,
  clean = true,
  scale = 1,
) {
  const labs = colors.map((p) => lab(rgb(p.hex)));
  const near = matcher(labs, topColors(data, colors, maxColors)),
    sw = w * scale;
  let cells = Array(w * h).fill(null);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const votes = new Map();
      let empty = 0;
      for (let dy = 0; dy < scale; dy++)
        for (let dx = 0; dx < scale; dx++) {
          const k = ((y * scale + dy) * sw + x * scale + dx) * 4;
          if (data[k + 3] < 128) empty++;
          else {
            const c = near(data[k], data[k + 1], data[k + 2]);
            votes.set(c, (votes.get(c) || 0) + 1);
          }
        }
      if (empty * 2 > scale * scale) continue;
      let best = null,
        most = 0;
      for (const [c, v] of votes) if (v > most) (most = v), (best = c);
      cells[y * w + x] = best;
    }
  // clean: number of cleanup passes (true = 1)
  for (let pass = 0; pass < Number(clean); pass++) {
    const src = [...cells];
    for (let y = 1; y < h - 1; y++)
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (src[i] === null) continue;
        const ns = [src[i - 1], src[i + 1], src[i - w], src[i + w]];
        if (ns.includes(src[i])) continue; // has a same-colored neighbor: lines stay whole
        // neighbors tied 2–2 are common at gradient bands: take the closer color
        let best = null,
          bestN = 1,
          bestD = CLEAN_DELTA;
        for (const n of new Set(ns)) {
          if (n === null) continue;
          const count = ns.filter((v) => v === n).length,
            d = deltaE(labs[src[i]], labs[n]);
          if (d >= CLEAN_DELTA || count < bestN) continue;
          if (count > bestN || d < bestD) (best = n), (bestN = count), (bestD = d);
        }
        if (best !== null && bestN >= 2) cells[i] = best;
      }
  }
  return clean ? mergeRare(cells, labs) : cells;
}
// Recolor the 4-connected region of same-valued cells around start; empty (null) regions fill too.
// Returns the same array when nothing would change.
export function floodFill(cells, w, h, start, value) {
  const target = cells[start];
  if (target === value) return cells;
  const out = [...cells],
    stack = [start];
  out[start] = value;
  const push = (i) => {
    if (out[i] === target) (out[i] = value), stack.push(i);
  };
  while (stack.length) {
    const i = stack.pop(),
      x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  return out;
}
// Whether grid line n (0..size) is a heavy divider. A 52-cell pegboard has a 1-cell edge
// on each side around 10 × 10 blocks of 5; 104 repeats that per board.
export function isMajorLine(n, size) {
  if (size % 52) return n % 5 === 0;
  const r = n % 52;
  return r === 0 || (r - 1) % 5 === 0;
}
// Clear near-white pixels connected to the image border; white inside the subject stays.
export function removeBackground(data, w, h, threshold = 235) {
  const isBg = (i) =>
    data[i * 4 + 3] < 128 ||
    (data[i * 4] > threshold &&
      data[i * 4 + 1] > threshold &&
      data[i * 4 + 2] > threshold);
  const seen = new Uint8Array(w * h),
    stack = [];
  const push = (i) => {
    if (!seen[i] && isBg(i)) (seen[i] = 1), stack.push(i);
  };
  for (let x = 0; x < w; x++) push(x), push((h - 1) * w + x);
  for (let y = 0; y < h; y++) push(y * w), push(y * w + w - 1);
  while (stack.length) {
    const i = stack.pop(),
      x = i % w;
    data[i * 4 + 3] = 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  return data;
}
export function validatePalette(p) {
  if (
    !Array.isArray(p) ||
    p.length < 1 ||
    p.length > 256 ||
    !p.every(
      (c) =>
        c &&
        typeof c.code === "string" &&
        c.code.length > 0 &&
        c.code.length <= 30 &&
        /^#[0-9a-f]{6}$/i.test(c.hex),
    ) ||
    new Set(p.map((c) => c.code)).size !== p.length
  )
    throw Error("色卡数据无效或色号重复");
  return p;
}
export function validateProject(p) {
  if (
    !p ||
    ![1, 2].includes(p.version) ||
    !Number.isInteger(p.width) ||
    !Number.isInteger(p.height) ||
    p.width < 8 ||
    p.height < 8 ||
    p.width > 128 ||
    p.height > 128
  )
    throw Error("图纸尺寸或版本无效");
  validatePalette(p.palette);
  if (p.version === 2) {
    const codes = new Set(p.palette.map((c) => c.code));
    if (
      !Array.isArray(p.cells) ||
      p.cells.length !== p.height ||
      !p.cells.every(
        (row) =>
          Array.isArray(row) &&
          row.length === p.width &&
          row.every((c) => c === null || codes.has(c)),
      )
    )
      throw Error("二维网格尺寸或色号无效");
  } else if (
    !Array.isArray(p.cells) ||
    p.cells.length !== p.width * p.height ||
    !p.cells.every(
      (v) =>
        v === null || (Number.isInteger(v) && v >= 0 && v < p.palette.length),
    )
  )
    throw Error("图纸网格无效");
  return p;
}
export function serializeProject(width, height, palette, cells) {
  return validateProject({
    version: 2,
    width,
    height,
    paletteName: "MARD 221 / 自定义",
    palette,
    cells: Array.from({ length: height }, (_, y) =>
      cells
        .slice(y * width, (y + 1) * width)
        .map((i) => (i === null ? null : palette[i].code)),
    ),
  });
}
export function projectCells(p) {
  validateProject(p);
  if (p.version === 1) return [...p.cells];
  const index = new Map(p.palette.map((c, i) => [c.code, i]));
  return p.cells.flat().map((c) => (c === null ? null : index.get(c)));
}
// Unify the subject's edge: every bead touching an empty cell gets the darkest used color.
export function outline(cells, w, h, colors) {
  const used = [...new Set(cells.filter((c) => c !== null))];
  if (!used.length) return cells;
  const dark = used.reduce((a, b) =>
    lab(rgb(colors[b].hex))[0] < lab(rgb(colors[a].hex))[0] ? b : a,
  );
  const empty = (x, y) =>
    x >= 0 && y >= 0 && x < w && y < h && cells[y * w + x] === null;
  return cells.map((c, i) => {
    const x = i % w,
      y = Math.floor(i / w);
    return c !== null &&
      (empty(x - 1, y) || empty(x + 1, y) || empty(x, y - 1) || empty(x, y + 1))
      ? dark
      : c;
  });
}
