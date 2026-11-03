import {
  palette as defaults,
  convert,
  topColors,
  isMajorLine,
  medianFilter,
  floodFill,
  outline,
  removeBackground,
  validateProject,
  validatePalette,
  serializeProject,
  projectCells,
} from "./core.mjs?v=mard-label-20261028";
const $ = (id) => document.getElementById(id);
let palette = structuredClone(defaults),
  cells = [],
  underlay = null, // tracing mode: the faded base; cells is the hand-drawn top layer
  w = 48,
  h = 48,
  selected = 0,
  tool = "pen",
  view = "beads",
  history = [],
  future = [],
  source = null,
  drawing = false,
  highlightOn = false,
  changed = false;
const grid = $("grid"),
  ctx = grid.getContext("2d");
let timer;
let editorRevision = 0,
  backendAvailable = false,
  aiBusy = false;
function toast(s) {
  $("toast").textContent = s;
  $("toast").classList.add("visible");
  clearTimeout(timer);
  timer = setTimeout(() => $("toast").classList.remove("visible"), 3500);
}
function checkpoint() {
  history.push([...cells]);
  if (history.length > 40) history.shift();
  future = [];
}
// Replacing the sheet also ends tracing: underlay indices belong to the old sheet.
function resetHistory() {
  history = [];
  underlay = null;
  syncTrace();
}
function syncTrace() {
  $("trace").classList.toggle("active", underlay !== null);
  $("trace-opacity-field").style.display = underlay ? "" : "none";
}
function render() {
  const step = 12;
  grid.width = w * step;
  grid.height = h * step;
  grid.style.width = w * step * Number($("zoom").value) + "px";
  grid.style.height = h * step * Number($("zoom").value) + "px";
  ctx.fillStyle = "#fffdf5";
  ctx.fillRect(0, 0, grid.width, grid.height);
  if (underlay) {
    ctx.globalAlpha = Number($("trace-opacity").value) / 100;
    underlay.forEach((v, i) => {
      if (v === null) return;
      ctx.fillStyle = palette[v].hex;
      ctx.fillRect((i % w) * step, Math.floor(i / w) * step, step, step);
    });
    ctx.globalAlpha = 1;
  }
  cells.forEach((v, i) => {
    if (v === null) return;
    const x = (i % w) * step,
      y = Math.floor(i / w) * step;
    ctx.fillStyle = palette[v].hex;
    ctx.fillRect(x, y, step, step);
    if (view === "chart") {
      const rgb = palette[v].hex.match(/\w\w/g).map((v) => parseInt(v, 16));
      ctx.fillStyle =
        rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 > 150
          ? "#30332a"
          : "white";
      ctx.font = "5px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(palette[v].code.slice(0, 5), x + 6, y + 8);
    }
  });
  // dim every cell except the highlighted color
  if (highlightOn && tool === "pen" && selected !== null) {
    ctx.fillStyle = "#fffdf5cc";
    cells.forEach((v, i) => {
      if (v !== selected)
        ctx.fillRect((i % w) * step, Math.floor(i / w) * step, step, step);
    });
  }
  for (let x = 0; x <= w; x++) {
    ctx.beginPath();
    ctx.lineWidth = isMajorLine(x, w) ? 1.2 : 0.5;
    ctx.strokeStyle = isMajorLine(x, w) ? "#4a503d99" : "#4a503d55";
    const px = Math.min(grid.width - 0.5, Math.max(0.5, x * step));
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h * step);
    ctx.stroke();
  }
  for (let y = 0; y <= h; y++) {
    ctx.beginPath();
    ctx.lineWidth = isMajorLine(y, h) ? 1.2 : 0.5;
    ctx.strokeStyle = isMajorLine(y, h) ? "#4a503d99" : "#4a503d55";
    const py = Math.min(grid.height - 0.5, Math.max(0.5, y * step));
    ctx.moveTo(0, py);
    ctx.lineTo(w * step, py);
    ctx.stroke();
  }
  $("dimensions").textContent = `${w} × ${h} 格`;
  $("selected").textContent =
    selected === null
      ? "当前工具：橡皮擦"
      : `当前颜色 ${palette[selected].code}`;
  $("undo").disabled = !history.length;
  $("redo").disabled = !future.length;
}
function statistics() {
  const counts = Array(palette.length).fill(0);
  cells.forEach((c) => {
    if (c !== null) counts[c]++;
  });
  $("total").textContent = counts.reduce((a, b) => a + b, 0).toLocaleString();
  $("used").textContent = counts.filter(Boolean).length;
  const container = $("palette");
  container.replaceChildren();
  palette.forEach((p, i) => {
    if (
      ($("only-used").checked && !counts[i]) ||
      !p.code
        .toLowerCase()
        .includes($("color-search").value.trim().toLowerCase())
    )
      return;
    const b = document.createElement("button");
    b.className = "swatch" + (i === selected ? " active" : "");
    b.title = `${p.code} · ${p.hex.toUpperCase()}`;
    const dot = document.createElement("i");
    dot.style.background = p.hex;
    const name = document.createElement("span");
    name.textContent = p.code;
    const n = document.createElement("small");
    n.textContent = counts[i];
    b.append(dot, name, n);
    b.title += " · 再点一次取消高亮";
    b.onclick = () => {
      highlightOn = !(highlightOn && selected === i);
      selected = i;
      if (tool !== "fill") setTool("pen");
      statistics();
      render();
    };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      if (selected === null || i === selected) {
        toast("先选择目标颜色，再右键点击要被替换的颜色");
        return;
      }
      checkpoint();
      cells = cells.map((c) => (c === i ? selected : c));
      update();
      toast("已全局替换颜色，可撤销");
    };
    container.append(b);
  });
}
function update() {
  editorRevision++;
  render();
  statistics();
}
function setTool(t) {
  tool = t;
  ["pen", "fill", "eraser", "picker"].forEach((id) =>
    $(id).classList.toggle("active", id === t),
  );
}
function sampleSource(width, height) {
  // supersample without smoothing: every sample is a real source pixel, so each
  // cell's vote never sees a blended transition color. Denser for big images so
  // thin outlines still get samples.
  const vote = $("vote").checked,
    density = Math.ceil(
      Math.max(source.width / width, source.height / height),
    ),
    k = vote ? Math.max(8, Math.min(16, density)) : 1,
    sw = width * k,
    sh = height * k;
  const sample = document.createElement("canvas");
  sample.width = sw;
  sample.height = sh;
  const c = sample.getContext("2d", { willReadFrequently: true });
  c.imageSmoothingEnabled = !vote;
  c.imageSmoothingQuality = "high";
  const sm = Number($("smooth").value);
  if (sm && !vote) c.filter = `blur(${sm * 0.32}px)`;
  // contain: non-square images are centered, leftover cells stay empty
  const scale = Math.min(sw / source.width, sh / source.height),
    dw = source.width * scale,
    dh = source.height * scale;
  c.drawImage(source, (sw - dw) / 2, (sh - dh) / 2, dw, dh);
  const d = c.getImageData(0, 0, sw, sh);
  if (vote && $("denoise").checked) medianFilter(d.data, sw, sh, k >> 2);
  if ($("background").checked) removeBackground(d.data, sw, sh);
  return { data: d.data, k };
}
// Sharp mode can't blur, so the detail slider sets how many cleanup passes run.
function cleanPasses() {
  if (!$("clean").checked) return 0;
  return $("vote").checked ? Math.max(1, Number($("smooth").value)) : 1;
}
function generate() {
  if (!source) return;
  if (underlay && !confirm("重新生成会清空垫图和手绘内容，继续吗？")) return;
  w = h = Number($("size").value);
  const { data, k } = sampleSource(w, h);
  cells = convert(
    data,
    w,
    h,
    palette,
    Number($("colors").value),
    cleanPasses(),
    k,
  );
  if ($("outline").checked) cells = outline(cells, w, h, palette);
  selected = cells.find((c) => c !== null) ?? 0;
  resetHistory();
  highlightOn = false;
  future = [];
  update();
}
function setSource(img, title) {
  source = img;
  $("ai-result").textContent = "";
  const c = $("original").getContext("2d");
  c.clearRect(0, 0, 256, 192);
  const scale = Math.min(256 / img.width, 192 / img.height);
  c.drawImage(
    img,
    (256 - img.width * scale) / 2,
    (192 - img.height * scale) / 2,
    img.width * scale,
    img.height * scale,
  );
  $("project-title").textContent = title;
  generate();
}
async function loadImage(file) {
  if (!file) return;
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 15 * 1024 * 1024
  ) {
    toast("请选择 15 MB 以内的 PNG、JPG 或 WebP");
    return;
  }
  try {
    const img = await createImageBitmap(file);
    if (img.width * img.height > 40000000) {
      img.close();
      throw Error("图片尺寸过大，请先缩小至 4000 万像素以内");
    }
    setSource(img, file.name.replace(/\.[^.]+$/, ""));
    toast("图片已载入，已生成图纸");
  } catch (e) {
    toast(e.message || "图片无法读取");
  }
}
function demo() {
  const c = document.createElement("canvas");
  c.width = 384;
  c.height = 384;
  const a = c.getContext("2d");
  function shape(color, points) {
    a.fillStyle = color;
    a.beginPath();
    points.forEach(([x, y], i) => (i ? a.lineTo(x, y) : a.moveTo(x, y)));
    a.closePath();
    a.fill();
  }
  a.fillStyle = "#a9d2c7";
  a.fillRect(0, 0, 384, 384);
  a.fillStyle = "#497a62";
  a.fillRect(0, 320, 384, 64);
  shape("#292b35", [
    [70, 280],
    [70, 130],
    [85, 65],
    [143, 106],
    [241, 106],
    [299, 65],
    [314, 130],
    [314, 280],
    [265, 320],
    [119, 320],
  ]);
  shape("#e5a83d", [
    [82, 275],
    [82, 134],
    [94, 88],
    [142, 120],
    [244, 120],
    [290, 88],
    [302, 134],
    [302, 275],
    [262, 305],
    [122, 305],
  ]);
  shape("#ed9184", [
    [98, 104],
    [123, 127],
    [94, 151],
  ]);
  shape("#ed9184", [
    [286, 104],
    [261, 127],
    [290, 151],
  ]);
  a.fillStyle = "#faf3df";
  a.beginPath();
  a.ellipse(192, 247, 82, 52, 0, 0, Math.PI * 2);
  a.fill();
  a.fillStyle = "#292b35";
  a.fillRect(127, 177, 19, 27);
  a.fillRect(238, 177, 19, 27);
  a.fillStyle = "#faf3df";
  a.fillRect(130, 179, 6, 7);
  a.fillRect(241, 179, 6, 7);
  shape("#d65e57", [
    [180, 228],
    [204, 228],
    [192, 241],
  ]);
  a.strokeStyle = "#292b35";
  a.lineWidth = 5;
  a.beginPath();
  a.moveTo(192, 241);
  a.lineTo(192, 252);
  a.lineTo(180, 258);
  a.moveTo(192, 252);
  a.lineTo(204, 258);
  a.stroke();
  a.fillStyle = "#9e735a";
  a.fillRect(172, 118, 12, 35);
  a.fillRect(199, 118, 12, 35);
  a.fillRect(88, 220, 26, 10);
  a.fillRect(270, 220, 26, 10);
  setSource(c, "小猫的午后");
}
$("file").onchange = (e) => loadImage(e.target.files[0]);
$("drop").ondragover = (e) => {
  e.preventDefault();
  $("drop").style.borderColor = "#4a6938";
};
$("drop").ondragleave = () => ($("drop").style.borderColor = "");
$("drop").ondrop = (e) => {
  e.preventDefault();
  $("drop").style.borderColor = "";
  loadImage(e.dataTransfer.files[0]);
};
$("demo").onclick = demo;
$("generate").onclick = () => {
  generate();
  toast("图纸已生成");
};
["colors", "smooth"].forEach(
  (id) =>
    ($(id).oninput = () => {
      $(id + "Value").textContent =
        id === "colors"
          ? $(id).value + " 色"
          : ["关闭", "适中", "较强", "最强"][$(id).value];
    }),
);
["pen", "fill", "eraser", "picker"].forEach(
  (id) =>
    ($(id).onclick = () => {
      setTool(id);
      render();
    }),
);
$("zoom").onchange = render;
["beads", "chart"].forEach(
  (id) =>
    ($(id).onclick = () => {
      view = id;
      ["beads", "chart"].forEach((n) =>
        $(n).classList.toggle("active", n === id),
      );
      render();
    }),
);
function cellAt(e) {
  const r = grid.getBoundingClientRect(),
    x = Math.floor(((e.clientX - r.left) / r.width) * w),
    y = Math.floor(((e.clientY - r.top) / r.height) * h);
  return x < 0 || y < 0 || x >= w || y >= h ? null : y * w + x;
}
function fill(e) {
  const i = cellAt(e);
  if (i === null || selected === null) return;
  const next = floodFill(cells, w, h, i, selected);
  if (next === cells) return;
  checkpoint();
  cells = next;
  update();
}
function paint(e) {
  const i = cellAt(e);
  if (i === null) return;
  if (tool === "picker") {
    const picked = cells[i] ?? underlay?.[i] ?? null;
    if (picked !== null) selected = picked;
    setTool("pen");
    update();
    return;
  }
  const v = tool === "eraser" ? null : selected;
  if (cells[i] !== v) {
    cells[i] = v;
    changed = true;
    editorRevision++;
    render();
  }
}
grid.onpointerdown = (e) => {
  if (e.button !== 0) return;
  if (tool === "fill") return fill(e);
  if (tool !== "picker") checkpoint();
  drawing = true;
  changed = false;
  grid.setPointerCapture(e.pointerId);
  paint(e);
};
grid.onpointermove = (e) => {
  if (drawing) paint(e);
};
grid.onpointerup = grid.onpointercancel = () => {
  drawing = false;
  statistics();
};
$("trace").onclick = () => {
  if (!underlay) {
    if (!cells.some((c) => c !== null)) {
      toast("请先生成或导入图纸");
      return;
    }
    const base = cells;
    resetHistory();
    future = [];
    underlay = base;
    cells = Array(w * h).fill(null);
    toast("已开始垫图重画：导出和统计只包含手绘层");
  } else if (cells.some((c) => c !== null)) {
    // keep the drawing; one undo brings the base back
    history.push(underlay);
    future = [];
    underlay = null;
    toast("已保留手绘层，撤销一步可恢复原图");
  } else {
    cells = underlay;
    underlay = null;
  }
  syncTrace();
  update();
};
$("trace-opacity").oninput = render;
$("undo").onclick = () => {
  if (history.length) {
    future.push([...cells]);
    cells = history.pop();
    update();
  }
};
$("redo").onclick = () => {
  if (future.length) {
    history.push([...cells]);
    cells = future.pop();
    update();
  }
};
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$("save").onclick = () =>
  download(
    new Blob(
      [JSON.stringify(serializeProject(w, h, palette, cells), null, 2)],
      { type: "application/json" },
    ),
    "bead-project.json",
  );
$("import").onclick = () => $("project-file").click();
$("project-file").onchange = async (e) => {
  try {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 3e6) throw Error("文件过大");
    const p = validateProject(JSON.parse(await file.text()));
    w = p.width;
    h = p.height;
    palette = p.palette;
    cells = projectCells(p);
    $("palette-name").textContent =
      palette.length === defaults.length &&
      palette.every((c) =>
        defaults.some(
          (d) =>
            d.code === c.code && d.hex.toUpperCase() === c.hex.toUpperCase(),
        ),
      )
        ? "MARD 色卡"
        : p.paletteName || "导入图纸色卡";
    selected = 0;
    resetHistory();
    highlightOn = false;
    future = [];
    $("project-title").textContent = "导入的拼豆图纸";
    update();
    toast("图纸已打开");
  } catch (err) {
    toast(err.message);
  }
  e.target.value = "";
};
$("palette-import").onclick = () => $("palette-file").click();
$("palette-file").onchange = async (e) => {
  try {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 100000) throw Error("色卡文件过大");
    const p = JSON.parse(await f.text());
    validatePalette(p);
    palette = p;
    selected = 0;
    $("colors").min = 1;
    $("colors").max = Math.min(20, p.length);
    $("colors").value = Math.min(Number($("colors").value), p.length);
    $("colors").oninput();
    $("palette-name").textContent = "自定义色卡";
    resetHistory();
    highlightOn = false;
    future = [];
    generate();
    toast("色卡已导入并重新生成图纸");
  } catch (err) {
    toast(err.message);
  }
  e.target.value = "";
};
$("png").onclick = () => {
  grid.toBlob((b) => download(b, "bead-preview.png"));
};
$("export").onclick = () => {
  $("chart").click();
  $("print").click();
};
$("print").onclick = () => {
  const win = window.open("", "_blank");
  if (!win) {
    toast("请允许弹出窗口后重试");
    return;
  }
  const doc = win.document;
  doc.title = "拼豆图纸";
  const style = doc.createElement("style");
  style.textContent =
    "body{font:12px sans-serif;color:#333}section{page-break-after:always}section:last-child{page-break-after:auto}table{border-collapse:collapse;table-layout:fixed}td{width:3.2mm;height:3.2mm;border:1px solid #aaa;text-align:center;font-size:4.5px;padding:0;overflow:hidden}th{font-size:5px;font-weight:400;width:3.2mm;height:3.2mm}p{line-height:1.8}h2{font-size:18px}@page{size:A4 portrait;margin:12mm}";
  doc.head.append(style);
  const board = 52; // one physical pegboard; 104 × 104 prints as 2 × 2 boards
  for (let by = 0; by < h; by += board)
    for (let bx = 0; bx < w; bx += board) {
      const section = doc.createElement("section"),
        title = doc.createElement("h2");
      title.textContent = `豆间 · ${w} × ${h} 格 · 第 ${by / board + 1} 行第 ${bx / board + 1} 块板`;
      section.append(title);
      const table = doc.createElement("table"),
        head = doc.createElement("tr");
      head.append(doc.createElement("th"));
      for (let x = bx; x < Math.min(w, bx + board); x++) {
        const th = doc.createElement("th");
        th.textContent = x + 1;
        head.append(th);
      }
      table.append(head);
      const counts = Array(palette.length).fill(0);
      for (let y = by; y < Math.min(h, by + board); y++) {
        const tr = doc.createElement("tr"),
          th = doc.createElement("th");
        th.textContent = y + 1;
        tr.append(th);
        for (let x = bx; x < Math.min(w, bx + board); x++) {
          const td = doc.createElement("td"),
            v = cells[y * w + x];
          if (v !== null) {
            td.textContent = palette[v].code;
            td.style.backgroundColor = palette[v].hex;
            td.style.printColorAdjust = "exact";
            const hex = palette[v].hex;
            td.style.color =
              parseInt(hex.slice(1, 3), 16) * 0.299 +
                parseInt(hex.slice(3, 5), 16) * 0.587 +
                parseInt(hex.slice(5, 7), 16) * 0.114 >
              150
                ? "#222"
                : "white";
            counts[v]++;
          }
          if (isMajorLine(x + 1, w)) td.style.borderRight = "2px solid #555";
          if (isMajorLine(y + 1, h)) td.style.borderBottom = "2px solid #555";
          tr.append(td);
        }
        table.append(tr);
      }
      section.append(table);
      const legend = doc.createElement("p");
      legend.textContent =
        "本板用量：" +
        counts
          .map((n, i) =>
            n ? `${palette[i].code} (${palette[i].hex}) × ${n}` : "",
          )
          .filter(Boolean)
          .join("　");
      section.append(legend);
      doc.body.append(section);
    }
  win.focus();
  setTimeout(() => win.print(), 300);
};
function sourceImage() {
  const c = document.createElement("canvas"),
    s = Math.min(1, 1024 / Math.max(source.width, source.height));
  c.width = Math.max(1, Math.round(source.width * s));
  c.height = Math.max(1, Math.round(source.height * s));
  c.getContext("2d").drawImage(source, 0, 0, c.width, c.height);
  return c.toDataURL("image/png").split(",")[1];
}
async function detectBackend() {
  try {
    const r = await fetch("/api/status", { signal: AbortSignal.timeout(5000) });
    const data = r.ok ? await r.json() : {};
    backendAvailable = data.aiGrid === true;
  } catch {
    backendAvailable = false;
  }
  $("backend-status").textContent = backendAvailable
    ? "本地后端已连接 · AI 将把照片发送到配置的 Ollama。请确认视觉模型已下载。"
    : "在线版可转换和编辑图纸。AI 请下载源码，用 Docker 或 Python 启动本地版后使用。";
  $("ai-generate").disabled = !backendAvailable;
  $("analyze").disabled = !backendAvailable;
}
async function aiRequest(generateGrid) {
  if (!source || aiBusy) return;
  if (!backendAvailable) {
    toast("请先启动本地 Python 或 Docker 版");
    return;
  }
  aiBusy = true;
  $("ai-generate").disabled = true;
  $("analyze").disabled = true;
  const revision = editorRevision,
    started = Date.now();
  const describe = () => {
    $("ai-result").textContent =
      (generateGrid
        ? "正在识别主体并从原图颜色中选色…"
        : "正在分析图片特征…") +
      ` 已等待 ${Math.floor((Date.now() - started) / 1000)} 秒。首次加载模型可能较慢。`;
  };
  describe();
  const tick = setInterval(describe, 1000);
  try {
    const width = Number($("ai-size").value),
      height = Math.max(
        8,
        Math.min(32, Math.round((width * source.height) / source.width)),
      );
    const sampled = sampleSource(width, height);
    const payload = {
      image: sourceImage(),
      model: $("model").value.trim(),
      maxColors: Math.max(2, Math.min(16, Number($("colors").value))),
      instructions: $("instructions").value.trim(),
      candidates: topColors(sampled.data, defaults, 24).map(
        (i) => defaults[i].code,
      ),
    };
    const r = await fetch(
      generateGrid ? "/api/plan-colors" : "/api/analyze",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(510000),
      },
    );
    const result = await r
      .json()
      .catch(() => ({ error: "后端响应无效，请确认本地服务已启动" }));
    if (!r.ok) throw Error(result.error || "AI 请求失败");
    if (generateGrid) {
      const { plan } = result;
      const index = new Map(defaults.map((c, i) => [c.code, i]));
      const picked = plan?.colors?.map((c) => index.get(c));
      if (!picked?.length || picked.includes(undefined))
        throw Error("AI 返回了无效的 MARD 色号");
      if (revision !== editorRevision)
        throw Error(
          "生成期间画布发生变化，已保留当前图纸。请保持画布不变后重新生成。",
        );
      w = width;
      h = height;
      palette = structuredClone(defaults);
      cells = convert(
        sampled.data,
        w,
        h,
        picked.map((i) => palette[i]),
        picked.length,
        cleanPasses(),
        sampled.k,
      ).map((c) => (c === null ? null : picked[c]));
      if ($("outline").checked) cells = outline(cells, w, h, palette);
      selected = cells.find((c) => c !== null) ?? 0;
      resetHistory();
      highlightOn = false;
      future = [];
      $("palette-name").textContent = "MARD 色卡";
      $("only-used").checked = true;
      $("color-search").value = "";
      $("project-title").textContent =
        "AI 简化 · " + (plan.subject || "像素图纸").slice(0, 35);
      update();
      $("ai-result").textContent =
        `已生成 ${w} × ${h} 简化网格。\n主体：${plan.subject || "已生成"}\n保留特征：${plan.features?.join("、") || "参考原图"}\n使用色号：${[...new Set(cells.filter((c) => c !== null))].map((i) => palette[i].code).join("、")}\n可继续使用画笔修整，然后保存二维图纸。`;
      toast("AI 网格已应用");
    } else $("ai-result").textContent = result.analysis;
  } catch (e) {
    $("ai-result").textContent =
      e.name === "TimeoutError"
        ? "请求超时，当前图纸已保留。请缩小 AI 网格或使用更快的视觉模型。"
        : e.message;
  } finally {
    clearInterval(tick);
    aiBusy = false;
    $("ai-generate").disabled = !backendAvailable;
    $("analyze").disabled = !backendAvailable;
  }
}
$("ai-generate").onclick = () => aiRequest(true);
$("analyze").onclick = () => aiRequest(false);
$("only-used").onchange = statistics;
$("color-search").oninput = statistics;
$("reset-palette").onclick = () => {
  const old = palette;
  const byCode = new Map(defaults.map((c, i) => [c.code, i]));
  const sameCodes =
    old.length === defaults.length && old.every((c) => byCode.has(c.code));
  const remapped = [];
  for (let i = 0; i < cells.length; i++) {
    if (cells[i] === null) {
      remapped.push(null);
      continue;
    }
    if (sameCodes) {
      remapped.push(byCode.get(old[cells[i]].code));
      continue;
    }
    const color = old[cells[i]].hex;
    const d = new Uint8ClampedArray([
      ...color.match(/\w\w/g).map((v) => parseInt(v, 16)),
      255,
    ]);
    remapped.push(convert(d, 1, 1, defaults, 221, false)[0]);
  }
  palette = structuredClone(defaults);
  cells = remapped;
  selected = 0;
  resetHistory();
  highlightOn = false;
  future = [];
  $("palette-name").textContent = "MARD 色卡";
  $("colors").min = 2;
  $("colors").max = 20;
  update();
  toast("已更新指定色卡；MARD 图纸保留原色号");
};
demo();
detectBackend();
