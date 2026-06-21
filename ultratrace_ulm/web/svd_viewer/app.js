const movieCanvas = document.getElementById("movie");
const overlayCanvas = document.getElementById("overlay");
const movieCtx = movieCanvas.getContext("2d");
const overlayCtx = overlayCanvas.getContext("2d");
const slabGrid = document.getElementById("slabGrid");

const statusEl = document.getElementById("status");
const playBtn = document.getElementById("play");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");
const frameSlider = document.getElementById("frame");
const frameText = document.getElementById("frameText");
const fpsInput = document.getElementById("fps");
const tailInput = document.getElementById("tail");
const tracksVisible = document.getElementById("tracksVisible");
const pointsVisible = document.getElementById("pointsVisible");

let meta = null;
let pixels = null;
let tracks = [];
let frame = 0;
let playing = false;
let timer = null;
let slabTiles = [];

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

function resizeCanvases() {
  if (!meta) return;
  if (isSlabbed()) {
    movieCanvas.hidden = true;
    overlayCanvas.hidden = true;
    slabGrid.hidden = false;
    buildSlabGrid();
    return;
  }
  slabGrid.hidden = true;
  movieCanvas.hidden = false;
  overlayCanvas.hidden = false;
  movieCanvas.width = meta.width;
  movieCanvas.height = meta.height;
  overlayCanvas.width = meta.width;
  overlayCanvas.height = meta.height;
}

function isSlabbed() {
  return Boolean(meta?.projection_meta?.elev_slabs?.length);
}

function xToPx(x) {
  const [lo, hi] = meta.bounds_mm.x;
  return ((x - lo) / (hi - lo)) * (meta.width - 1);
}

function xToPxInSlab(x, slab) {
  const [lo, hi] = meta.bounds_mm.x;
  const width = slab.width || meta.width;
  return ((x - lo) / (hi - lo)) * (width - 1);
}

function zToPx(z) {
  const [lo, hi] = meta.bounds_mm.z;
  return ((z - lo) / (hi - lo)) * (meta.height - 1);
}

function zToPxInSlab(z, slab) {
  const [lo, hi] = meta.bounds_mm.z;
  return ((z - lo) / (hi - lo)) * (slab.height - 1);
}

function drawFrame() {
  if (!meta || !pixels) return;
  if (isSlabbed()) {
    drawSlabFrame();
    frameSlider.value = String(frame);
    frameText.textContent = `${frame + 1} / ${meta.frames}`;
    return;
  }
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
  drawOverlay();
  frameSlider.value = String(frame);
  frameText.textContent = `${frame + 1} / ${meta.frames}`;
}

function buildSlabGrid() {
  slabGrid.replaceChildren();
  slabTiles = [];
  const slabs = meta.projection_meta.elev_slabs;
  for (const slab of slabs) {
    const tile = document.createElement("section");
    tile.className = "slab-tile";
    const slabWidth = slab.width || meta.width;
    tile.style.setProperty("--tile-aspect", `${slabWidth} / ${slab.height}`);

    const movie = document.createElement("canvas");
    movie.width = slabWidth;
    movie.height = slab.height;
    const overlay = document.createElement("canvas");
    overlay.width = slabWidth;
    overlay.height = slab.height;

    const label = document.createElement("div");
    label.className = "slab-label";
    label.textContent = slabLabel(slab);

    tile.append(movie, overlay, label);
    slabGrid.append(tile);
    slabTiles.push({
      slab,
      movie,
      overlay,
      movieCtx: movie.getContext("2d"),
      overlayCtx: overlay.getContext("2d"),
    });
  }
}

function slabLabel(slab) {
  const lo = Math.min(slab.y_min_mm, slab.y_max_mm).toFixed(1);
  const hi = Math.max(slab.y_min_mm, slab.y_max_mm).toFixed(1);
  return `y ${lo} to ${hi} mm`;
}

function drawSlabFrame() {
  for (const tile of slabTiles) {
    const slabWidth = tile.slab.width || meta.width;
    const colStart = tile.slab.col_start || 0;
    const image = tile.movieCtx.createImageData(slabWidth, tile.slab.height);
    for (let row = 0; row < tile.slab.height; row++) {
      const src = frame * meta.width * meta.height + (tile.slab.row_start + row) * meta.width + colStart;
      const dst = row * slabWidth;
      for (let x = 0; x < slabWidth; x++) {
        const v = pixels[src + x];
        const j = (dst + x) * 4;
        image.data[j] = v;
        image.data[j + 1] = v;
        image.data[j + 2] = v;
        image.data[j + 3] = 255;
      }
    }
    tile.movieCtx.putImageData(image, 0, 0);
    drawSlabOverlay(tile);
  }
}

function drawOverlay() {
  if (isSlabbed()) {
    for (const tile of slabTiles) drawSlabOverlay(tile);
    return;
  }
  overlayCtx.clearRect(0, 0, meta.width, meta.height);
  const tail = Number(tailInput.value);
  if (!tracksVisible.checked && !pointsVisible.checked) return;

  overlayCtx.lineWidth = Math.max(1, meta.width / 700);
  for (const track of tracks) {
    const frames = track.frames;
    let last = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i] <= frame) last = i;
      else break;
    }
    if (last < 0) continue;
    const start = Math.max(0, last - tail);
    if (tracksVisible.checked && last > start) {
      overlayCtx.beginPath();
      for (let i = start; i <= last; i++) {
        const x = xToPx(track.x[i]);
        const z = zToPx(track.z[i]);
        if (i === start) overlayCtx.moveTo(x, z);
        else overlayCtx.lineTo(x, z);
      }
      overlayCtx.strokeStyle = "rgba(0, 220, 255, 0.82)";
      overlayCtx.stroke();
    }
    if (pointsVisible.checked && Math.abs(frames[last] - frame) < 1.5) {
      overlayCtx.beginPath();
      overlayCtx.arc(xToPx(track.x[last]), zToPx(track.z[last]), 2.2, 0, Math.PI * 2);
      overlayCtx.fillStyle = "rgba(255, 230, 70, 0.95)";
      overlayCtx.fill();
    }
  }
}

function drawSlabOverlay(tile) {
  const ctx = tile.overlayCtx;
  const slab = tile.slab;
  const slabWidth = slab.width || meta.width;
  ctx.clearRect(0, 0, slabWidth, slab.height);
  const tail = Number(tailInput.value);
  if (!tracksVisible.checked && !pointsVisible.checked) return;

  ctx.lineWidth = Math.max(1, slabWidth / 700);
  for (const track of tracks) {
    const frames = track.frames;
    let last = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i] <= frame) last = i;
      else break;
    }
    if (last < 0) continue;
    const start = Math.max(0, last - tail);
    if (tracksVisible.checked && last > start) {
      let activePath = false;
      const flush = () => {
        if (activePath) ctx.stroke();
        activePath = false;
      };
      ctx.strokeStyle = "rgba(0, 220, 255, 0.82)";
      for (let i = start; i <= last; i++) {
        if (!isYInSlab(track.y[i], slab)) {
          flush();
          continue;
        }
        const x = xToPxInSlab(track.x[i], slab);
        const z = zToPxInSlab(track.z[i], slab);
        if (!activePath) {
          ctx.beginPath();
          ctx.moveTo(x, z);
          activePath = true;
        } else {
          ctx.lineTo(x, z);
        }
      }
      flush();
    }
    if (pointsVisible.checked && Math.abs(frames[last] - frame) < 1.5 && isYInSlab(track.y[last], slab)) {
      ctx.beginPath();
      ctx.arc(xToPxInSlab(track.x[last], slab), zToPxInSlab(track.z[last], slab), 2.2, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 230, 70, 0.95)";
      ctx.fill();
    }
  }
}

function isYInSlab(y, slab) {
  return y >= slab.y_min_mm && y <= slab.y_max_mm;
}

function step(delta) {
  frame = (frame + delta + meta.frames) % meta.frames;
  drawFrame();
}

function setPlaying(value) {
  playing = value;
  playBtn.textContent = playing ? "Pause" : "Play";
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (playing) {
    const interval = Math.max(8, 1000 / Number(fpsInput.value || meta.fps || 30));
    timer = setInterval(() => step(1), interval);
  }
}

async function main() {
  const metaUrl = query("movie", "movie.json");
  meta = await loadJson(metaUrl);
  const base = metaUrl.includes("/") ? metaUrl.slice(0, metaUrl.lastIndexOf("/") + 1) : "";
  pixels = await loadRaw(query("raw", base + (meta.movie_raw || "movie.raw")));
  const trackPayload = await loadJson(query("tracks", base + (meta.tracks || "tracks.json")));
  tracks = trackPayload.tracks || [];

  resizeCanvases();
  frameSlider.max = String(meta.frames - 1);
  fpsInput.value = String(meta.fps || 30);
  tailInput.value = String(meta.tail_frames || 18);
  statusEl.textContent = `${meta.frames} frames | ${meta.projection} | ${tracks.length} tracks`;
  drawFrame();
}

playBtn.addEventListener("click", () => setPlaying(!playing));
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
frameSlider.addEventListener("input", () => {
  frame = Number(frameSlider.value);
  drawFrame();
});
fpsInput.addEventListener("change", () => {
  if (playing) setPlaying(true);
});
tailInput.addEventListener("input", drawOverlay);
tracksVisible.addEventListener("change", drawOverlay);
pointsVisible.addEventListener("change", drawOverlay);

main().catch((err) => {
  console.error(err);
  statusEl.textContent = err.message;
});
