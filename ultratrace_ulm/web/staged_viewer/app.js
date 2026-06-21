const movieCanvas = document.getElementById("movie");
const overlayCanvas = document.getElementById("overlay");
const movieCtx = movieCanvas.getContext("2d");
const overlayCtx = overlayCanvas.getContext("2d");
const screenEl = document.querySelector(".screen");
const SVG_NS = "http://www.w3.org/2000/svg";

const modeEl = document.getElementById("mode");
const statusEl = document.getElementById("status");
const frameText = document.getElementById("frameText");
const frameSlider = document.getElementById("frame");
const fpsInput = document.getElementById("fps");
const filterBtn = document.getElementById("filter");
const detectBtn = document.getElementById("detect");
const trackBtn = document.getElementById("track");
const playBtn = document.getElementById("play");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");

let meta = null;
let tracks = [];
let frame = 0;
let stage = "raw";
let playing = false;
let timer = null;
let trackSvg = null;
let trackSvgBuilt = false;
const layerCache = new Map();

const stages = {
  raw: { label: "raw video", layer: "raw" },
  filtered: { label: "moving objects", layer: "filtered" },
  detect: { label: "detections", layer: "detect" },
  track: { label: "final tracks", layer: null },
};

function query(name, fallback) {
  const params = new URLSearchParams(window.location.search);
  return params.get(name) || fallback;
}

async function loadJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

async function loadRaw(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function baseUrl(metaUrl) {
  const idx = metaUrl.lastIndexOf("/");
  return idx >= 0 ? metaUrl.slice(0, idx + 1) : "";
}

async function loadLayer(name) {
  if (layerCache.has(name)) return layerCache.get(name);
  const layer = meta.layers[name];
  const promise = loadRaw(query(name, meta.base + layer.file));
  layerCache.set(name, promise);
  return promise;
}

function resizeCanvases() {
  movieCanvas.width = meta.width;
  movieCanvas.height = meta.height;
  overlayCanvas.width = meta.width;
  overlayCanvas.height = meta.height;
  screenEl.style.setProperty("--aspect", `${meta.width} / ${meta.height}`);
  if (trackSvg) trackSvg.setAttribute("viewBox", `0 0 ${meta.width} ${meta.height}`);
  trackSvgBuilt = false;
}

function slabs() {
  return meta.projection_meta?.elev_slabs || [
    {
      row_start: 0,
      col_start: 0,
      width: meta.width,
      height: meta.height,
      y_min_mm: meta.bounds_mm.y[0],
      y_max_mm: meta.bounds_mm.y[1],
    },
  ];
}

function xToPx(x, slab) {
  const [lo, hi] = meta.bounds_mm.x;
  return (slab.col_start || 0) + ((x - lo) / (hi - lo)) * ((slab.width || meta.width) - 1);
}

function zToPx(z, slab) {
  const [lo, hi] = meta.bounds_mm.z;
  return (slab.row_start || 0) + ((z - lo) / (hi - lo)) * ((slab.height || meta.height) - 1);
}

function isYInSlab(y, slab) {
  const lo = Math.min(slab.y_min_mm, slab.y_max_mm);
  const hi = Math.max(slab.y_min_mm, slab.y_max_mm);
  return y >= lo && y <= hi;
}

function drawLayer(pixels) {
  const n = meta.width * meta.height;
  const offset = frame * n;
  const image = movieCtx.createImageData(meta.width, meta.height);
  for (let i = 0; i < n; i++) {
    const v = pixels[offset + i];
    const j = i * 4;
    image.data[j] = v;
    image.data[j + 1] = v;
    image.data[j + 2] = v;
    image.data[j + 3] = 255;
  }
  movieCtx.putImageData(image, 0, 0);
}

function drawDisk(ctx, x, y, radius, fill) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
}

function indexAtOrBefore(frames, value) {
  let lo = 0;
  let hi = frames.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid] <= value) {
      out = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return out;
}

function drawDetections() {
  overlayCtx.clearRect(0, 0, meta.width, meta.height);
  overlayCtx.shadowBlur = 4;
  overlayCtx.shadowColor = "rgba(255, 221, 75, 0.72)";
  for (const track of tracks) {
    const last = indexAtOrBefore(track.frames, frame);
    if (last < 0 || Math.abs(track.frames[last] - frame) >= 1.5) continue;
    for (const slab of slabs()) {
      if (!isYInSlab(track.y[last], slab)) continue;
      drawDisk(overlayCtx, xToPx(track.x[last], slab), zToPx(track.z[last], slab), 2.35, "rgb(255, 230, 70)");
    }
  }
  overlayCtx.shadowBlur = 0;
}

function strokeTrackSegment(points, ctx) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
}

function svgEl(name, attrs = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) {
    el.setAttribute(key, String(value));
  }
  return el;
}

function pointValue(value) {
  return Number.isFinite(value) ? value.toFixed(2) : "0";
}

function pathData(segment) {
  if (segment.length < 2) return "";
  let d = `M ${pointValue(segment[0][0])} ${pointValue(segment[0][1])}`;
  for (let i = 1; i < segment.length; i++) {
    d += ` L ${pointValue(segment[i][0])} ${pointValue(segment[i][1])}`;
  }
  return d;
}

function ensureTrackSvg() {
  if (trackSvg) return trackSvg;
  trackSvg = svgEl("svg", {
    id: "trackSvg",
    viewBox: `0 0 ${meta.width} ${meta.height}`,
    preserveAspectRatio: "xMidYMid meet",
    "aria-hidden": "true",
  });
  trackSvg.style.display = "none";
  screenEl.append(trackSvg);
  return trackSvg;
}

function trackSegments(track, slab) {
  const segments = [];
  let segment = [];
  for (let i = 0; i < track.frames.length; i++) {
    if (!isYInSlab(track.y[i], slab)) {
      if (segment.length) segments.push(segment);
      segment = [];
      continue;
    }
    segment.push([xToPx(track.x[i], slab), zToPx(track.z[i], slab)]);
  }
  if (segment.length) segments.push(segment);
  return segments;
}

function appendTrackPoints(track, slab, group, radius, fill, opacity) {
  for (let i = 0; i < track.frames.length; i++) {
    if (!isYInSlab(track.y[i], slab)) continue;
    group.append(
      svgEl("circle", {
        cx: pointValue(xToPx(track.x[i], slab)),
        cy: pointValue(zToPx(track.z[i], slab)),
        r: radius,
        fill,
        opacity,
      }),
    );
  }
}

function buildTrackSvg() {
  const svg = ensureTrackSvg();
  if (trackSvgBuilt) return svg;
  svg.replaceChildren();
  svg.append(svgEl("rect", { x: 0, y: 0, width: meta.width, height: meta.height, fill: "#000" }));
  const broad = svgEl("g", {
    fill: "none",
    stroke: "#ff9224",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": 2.4,
    opacity: 0.12,
  });
  const fine = svgEl("g", {
    fill: "none",
    stroke: "#ffd65d",
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
    "stroke-width": 0.58,
    opacity: 0.82,
  });
  const points = svgEl("g");

  for (const track of tracks) {
    const length = track.frames.length;
    if (length < 2) continue;
    for (const slab of slabs()) {
      const segments = trackSegments(track, slab);
      if (!segments.length) continue;
      const opacity = Math.min(0.72, 0.22 + length / 180);
      for (const segment of segments) {
        const d = pathData(segment);
        if (!d) continue;
        broad.append(svgEl("path", { d }));
        fine.append(svgEl("path", { d, opacity }));
      }
      appendTrackPoints(track, slab, points, 0.74, "#ffad2e", 0.16);
      appendTrackPoints(track, slab, points, 0.26, "#fff0a8", 0.74);
    }
  }
  svg.append(broad, fine, points);
  trackSvgBuilt = true;
  return svg;
}

function setRasterVisible(visible) {
  movieCanvas.style.display = visible ? "block" : "none";
  overlayCanvas.style.display = visible ? "block" : "none";
  if (trackSvg) trackSvg.style.display = visible ? "none" : "block";
}

function drawTracksOnly() {
  buildTrackSvg();
  setRasterVisible(false);
  overlayCtx.clearRect(0, 0, meta.width, meta.height);
}

async function drawFrame() {
  if (!meta) return;
  const current = stages[stage];
  overlayCtx.clearRect(0, 0, meta.width, meta.height);
  if (stage === "track") {
    drawTracksOnly();
  } else {
    setRasterVisible(true);
    const pixels = await loadLayer(current.layer);
    drawLayer(pixels);
    if (stage === "detect") drawDetections();
  }
  frameSlider.value = String(frame);
  frameText.textContent = `${frame + 1} / ${meta.frames}`;
}

function updateButtons() {
  filterBtn.classList.toggle("active", stage === "filtered");
  detectBtn.classList.toggle("active", stage === "detect");
  trackBtn.classList.toggle("active", stage === "track");
  modeEl.textContent = stages[stage].label;
}

async function setStage(next) {
  stage = next;
  if (stage === "filtered") detectBtn.disabled = false;
  if (stage === "detect") trackBtn.disabled = false;
  updateButtons();
  await drawFrame();
}

function stop() {
  playing = false;
  playBtn.textContent = "Play";
  if (timer) window.clearInterval(timer);
  timer = null;
}

function step(delta) {
  frame = (frame + delta + meta.frames) % meta.frames;
  drawFrame();
}

function play() {
  if (playing) {
    stop();
    return;
  }
  playing = true;
  playBtn.textContent = "Pause";
  timer = window.setInterval(() => step(1), 1000 / Number(fpsInput.value || 30));
}

async function init() {
  try {
    const metaUrl = query("movie", "staged_movie.json");
    meta = await loadJson(metaUrl);
    meta.base = baseUrl(metaUrl);
    resizeCanvases();
    frameSlider.max = String(Math.max(0, meta.frames - 1));
    fpsInput.value = String(meta.fps || 30);
    const tracksPayload = await loadJson(query("tracks", meta.base + (meta.tracks || "tracks.json")));
    tracks = tracksPayload.tracks || [];
    trackSvgBuilt = false;
    await loadLayer("raw");
    statusEl.textContent = `${meta.frames} frames | ${tracks.length} tracks`;
    updateButtons();
    await drawFrame();
  } catch (err) {
    statusEl.textContent = err instanceof Error ? err.message : String(err);
  }
}

filterBtn.addEventListener("click", () => setStage("filtered"));
detectBtn.addEventListener("click", () => setStage("detect"));
trackBtn.addEventListener("click", () => setStage("track"));
playBtn.addEventListener("click", play);
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
frameSlider.addEventListener("input", () => {
  frame = Number(frameSlider.value);
  drawFrame();
});
fpsInput.addEventListener("change", () => {
  if (playing) {
    stop();
    play();
  }
});

init();
