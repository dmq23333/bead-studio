import { test } from "node:test";
import assert from "node:assert/strict";
import {
  convert,
  topColors,
  isMajorLine,
  medianFilter,
  floodFill,
  palette as mard,
  validateProject,
  validatePalette,
  lab,
  serializeProject,
  projectCells,
  outline,
  deltaE,
  removeBackground,
} from "../dist/core.mjs";
const palette = [
  { code: "X", hex: "#292b35" },
  { code: "Y", hex: "#faf3df" },
  { code: "Z", hex: "#ff0000" },
];
test("transparent pixels stay empty and exact palette colors match", () => {
  assert.deepEqual(
    convert(
      new Uint8ClampedArray([41, 43, 53, 255, 250, 243, 223, 255, 0, 0, 0, 0]),
      3,
      1,
      palette,
      3,
      false,
    ),
    [0, 1, null],
  );
});
test("topColors ranks by coverage and skips absent colors", () => {
  const red = [255, 0, 0, 255],
    dark = [41, 43, 53, 255];
  const data = new Uint8ClampedArray([...red, ...red, ...dark, 0, 0, 0, 0]);
  assert.deepEqual(topColors(data, palette, 3), [2, 0]);
});
test("clean accepts a pass count and leaves connected thin lines whole", () => {
  const X = [41, 43, 53, 255],
    Y = [250, 243, 223, 255];
  const on = new Set([7, 11, 12, 13, 17]);
  const data = new Uint8ClampedArray(
    Array.from({ length: 25 }, (_, i) => (on.has(i) ? Y : X)).flat(),
  );
  const count = (clean) =>
    convert(data, 5, 5, palette, 3, clean).filter((c) => c === 1).length;
  assert.equal(count(0), 5);
  assert.equal(count(true), count(1));
  assert.equal(count(2), 5);
});
test("a speck on a gradient band (neighbors tied 2–2) takes the closer color", () => {
  const A = [240, 200, 160],
    B = [200, 150, 110];
  const pal = [
    { code: "A", hex: "#f0c8a0" },
    { code: "B", hex: "#c8966e" },
    { code: "S", hex: "#d2a078" },
  ];
  const rows = [
    [A, A, A],
    [A, [210, 160, 120], B],
    [B, B, B],
  ];
  assert.equal(pal[convert(solid(rows), 3, 3, pal, 3, 1)[4]].code, "B");
});
test("floodFill stays in the connected region and fills empty cells", () => {
  const n = null;
  // the 1s are split by a wall of 2s
  const cells = [1, 2, 1, 1, 2, n, 2, n, n];
  assert.deepEqual(floodFill(cells, 3, 3, 0, 7), [7, 2, 1, 7, 2, n, 2, n, n]);
  assert.deepEqual(floodFill(cells, 3, 3, 8, 7), [1, 2, 1, 1, 2, 7, 2, 7, 7]);
  // no row wrap or diagonals: cells 1 and 2 touch only in memory / at a corner
  assert.deepEqual(floodFill([1, 2, 2, 1], 2, 2, 1, 7), [1, 7, 2, 1]);
  assert.equal(floodFill(cells, 3, 3, 0, 1), cells);
});
const solid = (rows) =>
  new Uint8ClampedArray(rows.flat().flatMap((c) => [...c, 255]));
const near = [
  { code: "L1", hex: "#f0c8a0" },
  { code: "L2", hex: "#eec6a0" },
  { code: "L3", hex: "#ecc4a0" },
  { code: "K", hex: "#101010" },
];
test("a small distinct color beats a large near-duplicate for the last slot", () => {
  const data = solid([
    [...Array(6).fill([240, 200, 160]), ...Array(3).fill([238, 198, 160])],
    [[16, 16, 16]],
  ]);
  assert.deepEqual(topColors(data, near, 2), [0, 3]);
  // spare slots still take the near-duplicate
  assert.equal(topColors(data, near, 3).length, 3);
});
test("cleanup removes a low-contrast speck but keeps a high-contrast one", () => {
  const skin = [240, 200, 160];
  const grid = (center) =>
    solid(
      [0, 1, 2, 3, 4].map((y) =>
        [0, 1, 2, 3, 4].map((x) => (x === 2 && y === 2 ? center : skin)),
      ),
    );
  const at = (center) => near[convert(grid(center), 5, 5, near, 4, 1)[12]].code;
  assert.equal(at([16, 16, 16]), "K");
  assert.equal(at([236, 196, 160]), "L1");
});
test("rare colors merge into a close main color but keep contrast", () => {
  const W = 20,
    skin = [240, 200, 160];
  const rows = Array.from({ length: W }, () => Array(W).fill(skin));
  rows[0][0] = [236, 196, 160]; // corner: out of cleanup's reach, rare and close
  rows[0][W - 1] = [16, 16, 16]; // rare but contrasting
  const cells = convert(solid(rows), W, W, near, 4, 1);
  assert.equal(near[cells[0]].code, "L1");
  assert.equal(near[cells[W - 1]].code, "K");
});
test("medianFilter removes salt noise, keeps an edge and alpha", () => {
  const w = 9,
    data = new Uint8ClampedArray(w * w * 4);
  for (let i = 0; i < w * w; i++) {
    const v = i % w < 5 ? 40 : 200;
    data.set([v, v, v, i === 0 ? 7 : 255], i * 4);
  }
  data.set([255, 255, 255, 255], (4 * w + 2) * 4); // salt inside the dark half
  const out = medianFilter(data.slice(), w, w, 1);
  assert.equal(out[(4 * w + 2) * 4], 40);
  assert.equal(out[(4 * w + 3) * 4], 40);
  assert.equal(out[(4 * w + 6) * 4], 200);
  assert.equal(out[3], 7);
  // large window at the image edge stays in bounds and matches a uniform image
  const flat = new Uint8ClampedArray(16 * 4).fill(90);
  assert.deepEqual(medianFilter(flat.slice(), 4, 4, 3), flat);
});
test("52-cell boards have a 1-cell edge around 5×5 blocks", () => {
  const lines = (size) =>
    Array.from({ length: size + 1 }, (_, n) => n).filter((n) =>
      isMajorLine(n, size),
    );
  const board = [0, 1, 6, 11, 16, 21, 26, 31, 36, 41, 46, 51, 52];
  assert.deepEqual(lines(52), board);
  assert.deepEqual(lines(104), [
    ...board,
    ...board.slice(1).map((n) => n + 52),
  ]);
  assert.deepEqual(lines(16), [0, 5, 10, 15]);
});
test("color limit is respected", () => {
  const data = new Uint8ClampedArray(
    palette.flatMap((p) => [
      ...p.hex.match(/\w\w/g).map((v) => parseInt(v, 16)),
      255,
    ]),
  );
  assert.ok(new Set(convert(data, 3, 1, palette, 2, false)).size <= 2);
});
test("neutral white has expected Lab luminance", () => {
  assert.ok(Math.abs(lab([255, 255, 255])[0] - 100) < 0.1);
});
test("legacy import rejects invalid cells, colors, duplicate codes and indices", () => {
  const p = {
    version: 1,
    width: 8,
    height: 8,
    palette,
    cells: Array(64).fill(null),
  };
  assert.equal(validateProject(p), p);
  assert.throws(() => validateProject({ ...p, cells: [0] }));
  assert.throws(() => validateProject({ ...p, cells: Array(64).fill(99) }));
  assert.throws(() =>
    validateProject({ ...p, palette: [{ code: "X", hex: "bad" }] }),
  );
  assert.throws(() => validatePalette([palette[0], palette[0]]));
  assert.throws(() => validatePalette([null]));
});
test("cleanup keeps a high-contrast cell and never fills transparent space", () => {
  const data = new Uint8ClampedArray(
    Array.from({ length: 9 }, (_, i) =>
      i === 4 ? [250, 243, 223, 255] : [41, 43, 53, 255],
    ).flat(),
  );
  assert.equal(convert(data, 3, 3, palette, 3, true)[4], 1);
  data[19] = 0;
  assert.equal(convert(data, 3, 3, palette, 3, true)[4], null);
});
test("MARD contains 221 unique reference colors and correct groups", () => {
  assert.equal(mard.length, 221);
  assert.equal(new Set(mard.map((c) => c.code)).size, 221);
  validatePalette(mard);
  assert.deepEqual(
    Object.fromEntries(
      ["A", "B", "C", "D", "E", "F", "G", "H", "M"].map((g) => [
        g,
        mard.filter((c) => c.code.startsWith(g)).length,
      ]),
    ),
    { A: 26, B: 32, C: 29, D: 26, E: 24, F: 25, G: 21, H: 23, M: 15 },
  );
});
test("v2 serializes code/null rows and round trips empty and white beads distinctly", () => {
  const cells = Array(64).fill(null);
  cells[1] = 0;
  cells[63] = 1;
  const p = serializeProject(8, 8, palette, cells);
  assert.equal(p.version, 2);
  assert.equal(p.cells[0][0], null);
  assert.equal(p.cells[0][1], "X");
  assert.equal(p.cells[7][7], "Y");
  assert.deepEqual(projectCells(p), cells);
  assert.throws(() => validateProject({ ...p, cells: p.cells.slice(1) }));
  const bad = structuredClone(p);
  bad.cells[0][0] = "FAKE";
  assert.throws(() => validateProject(bad));
});
test("browser and backend use identical user-provided code/HEX/RGB data", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createHash } = await import("node:crypto");
  const raw = await readFile(new URL("../dist/mard221.json", import.meta.url));
  const json = JSON.parse(raw);
  const meta = JSON.parse(
    await readFile(
      new URL("../dist/palette-source.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(mard, json);
  assert.equal(createHash("sha256").update(raw).digest("hex"), meta.sha256);
  for (const c of mard)
    assert.deepEqual(
      c.rgb,
      [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16)),
    );
  assert.equal(mard.find((c) => c.code === "A5").hex, "#F0D83A");
  assert.equal(mard.find((c) => c.code === "A25").hex, "#FDF785");
});
test("outline paints edge beads with the darkest used color", () => {
  // light Y block with a hole and an empty right column; red Z is the darker used color
  const cells = [1, 1, 1, null, 1, null, 1, null, 1, 1, 1, null, 2, 2, 2, 2];
  assert.deepEqual(outline(cells, 4, 4, palette), [
    1,
    2,
    2,
    null,
    2,
    null,
    2,
    null,
    1,
    2,
    2,
    null,
    2,
    2,
    2,
    2,
  ]);
});
test("CIEDE2000 matches Sharma reference pair", () => {
  assert.ok(
    Math.abs(deltaE([50, 2.6772, -79.7751], [50, 0, -82.7485]) - 2.0425) < 1e-4,
  );
  assert.ok(Math.abs(deltaE([50, 2.5, 0], [73, 25, -18]) - 27.1492) < 1e-4);
});
test("supersampled cell takes the majority color, not a blend", () => {
  // 2×1 cells at scale 2: left block 3 dark + 1 light, right block mostly transparent
  const X = [41, 43, 53, 255],
    Y = [250, 243, 223, 255],
    T = [0, 0, 0, 0];
  const data = new Uint8ClampedArray([X, X, Y, T, X, Y, T, T].flat());
  assert.deepEqual(convert(data, 2, 1, palette, 3, false, 2), [0, null]);
});
test("background removal keeps white enclosed by the subject", () => {
  // 5×5 white with a dark ring around a white center
  const W = [255, 255, 255, 255],
    D = [41, 43, 53, 255];
  const px = Array.from({ length: 25 }, (_, i) => {
    const x = i % 5,
      y = Math.floor(i / 5);
    return x >= 1 && x <= 3 && y >= 1 && y <= 3 && !(x === 2 && y === 2)
      ? D
      : W;
  });
  const data = removeBackground(new Uint8ClampedArray(px.flat()), 5, 5);
  assert.equal(data[0 * 4 + 3], 0);
  assert.equal(data[12 * 4 + 3], 255);
});
