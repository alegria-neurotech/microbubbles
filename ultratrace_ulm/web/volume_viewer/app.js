import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const viewport = document.getElementById("viewport");
const modeEl = document.getElementById("mode");
const statusEl = document.getElementById("status");
const filterBtn = document.getElementById("filter");
const detectBtn = document.getElementById("detect");
const trackBtn = document.getElementById("track");
const playBtn = document.getElementById("play");
const prevBtn = document.getElementById("prev");
const nextBtn = document.getElementById("next");
const frameSlider = document.getElementById("frame");
const frameText = document.getElementById("frameText");
const fpsInput = document.getElementById("fps");
const tailInput = document.getElementById("tail");
const tailValue = document.getElementById("tailValue");
const pointSizeInput = document.getElementById("pointSize");
const pointSizeValue = document.getElementById("pointSizeValue");
const showTracksInput = document.getElementById("showTracks");
const autoRotateInput = document.getElementById("autoRotate");

let meta;
let pointBuffer;
let backgroundBuffer = null;
let backgroundPositionsBuffer = null;
let backgroundIntensitiesBuffer = null;
let backgroundPlaneBuffers = {};
let tracks = [];
let offsets = [];
let backgroundOffsets = [];
let frame = 0;
let stage = "raw";
let playing = false;
let timer = null;

let scene;
let camera;
let renderer;
let controls;
let pointCloud;
let pointMaterial;
let backgroundCloud;
let backgroundMaterial;
let backgroundPlanes = [];
let backgroundPlaneMaterials = [];
let trackGroup;
let trackStaticGroup;
let trackDynamicGroup;
let trackStaticBuilt = false;
let trackFullMaterial;
let trackMaterial;
let trackHeadGeometry;
let trackHeadMaterial;
let detectionGroup;
let detectionHeadGeometry;
let detectionHeadMaterial;

const stages = {
  raw: {
    label: "raw/background",
    backgroundAlpha: 1.0,
    foregroundAlpha: 0.0,
    pointScale: 1.0,
    pointTone: 0.0,
    tracks: false,
    detections: false,
  },
  filtered: {
    label: "moving objects",
    backgroundAlpha: 0.18,
    foregroundAlpha: 0.82,
    pointScale: 1.0,
    pointTone: 0.0,
    tracks: false,
    detections: false,
  },
  detect: {
    label: "detections",
    backgroundAlpha: 0.08,
    foregroundAlpha: 1.35,
    pointScale: 0.62,
    pointTone: 1.0,
    tracks: false,
    detections: true,
  },
  track: {
    label: "final tracks",
    backgroundAlpha: 0.0,
    foregroundAlpha: 0.0,
    pointScale: 1.0,
    pointTone: 0.0,
    tracks: true,
    detections: false,
  },
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

async function loadBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.arrayBuffer();
}

function worldFromIndex(ix, iy, iz) {
  const xb = meta.bounds_mm.x;
  const yb = meta.bounds_mm.y;
  const zb = meta.bounds_mm.z;
  const shape = meta.shape;
  const x = xb[0] + (ix / Math.max(1, shape.x - 1)) * (xb[1] - xb[0]);
  const elev = yb[0] + (iy / Math.max(1, shape.elev - 1)) * (yb[1] - yb[0]);
  const depth = zb[0] + (iz / Math.max(1, shape.z - 1)) * (zb[1] - zb[0]);
  return [x, -depth, elev];
}

function worldFromTrack(x, elev, depth) {
  return [x, -depth, elev];
}

function ticks(min, max, steps) {
  const values = [];
  for (let i = 0; i <= steps; i++) {
    values.push(min + ((max - min) * i) / steps);
  }
  return values;
}

function addLineSegments(coords, material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(coords), 3));
  scene.add(new THREE.LineSegments(geometry, material));
}

function addVolumeContext(xb, yb, zb) {
  const box = new THREE.Box3(
    new THREE.Vector3(xb[0], -zb[1], yb[0]),
    new THREE.Vector3(xb[1], -zb[0], yb[1]),
  );
  scene.add(new THREE.Box3Helper(box, 0x3d5269));

  const gridMaterial = new THREE.LineBasicMaterial({
    color: 0x243244,
    transparent: true,
    opacity: 0.46,
    depthWrite: false,
  });
  const guideMaterial = new THREE.LineBasicMaterial({
    color: 0x516986,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });

  const bottom = -zb[1];
  const top = -zb[0];
  const grid = [];
  for (const x of ticks(xb[0], xb[1], 6)) {
    grid.push(x, bottom, yb[0], x, bottom, yb[1]);
  }
  for (const elev of ticks(yb[0], yb[1], 4)) {
    grid.push(xb[0], bottom, elev, xb[1], bottom, elev);
  }
  addLineSegments(grid, gridMaterial);

  const guides = [];
  for (const x of [xb[0], xb[1]]) {
    for (const elev of [yb[0], yb[1]]) {
      guides.push(x, bottom, elev, x, top, elev);
    }
  }
  addLineSegments(guides, guideMaterial);
}

function makeBackgroundMaterial(pixelRatio) {
  return new THREE.ShaderMaterial({
    uniforms: {
      pointSize: { value: 1.35 },
      pixelRatio: { value: pixelRatio },
      alphaScale: { value: 0.0 },
    },
    vertexShader: `
      uniform float pointSize;
      uniform float pixelRatio;
      attribute float intensity;
      varying float vIntensity;

      void main() {
        vIntensity = intensity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float attenuation = 220.0 / max(120.0, -mvPosition.z);
        gl_PointSize = clamp(pointSize * pixelRatio * (0.55 + intensity * 0.85) * attenuation, 0.8, 5.5);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float alphaScale;
      varying float vIntensity;

      vec3 ramp(float t) {
        vec3 low = vec3(0.05, 0.07, 0.09);
        vec3 mid = vec3(0.30, 0.40, 0.48);
        vec3 high = vec3(0.72, 0.84, 0.88);
        vec3 color = mix(low, mid, smoothstep(0.05, 0.68, t));
        color = mix(color, high, smoothstep(0.68, 1.00, t));
        return color;
      }

      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float radius = length(uv);
        float dotShape = smoothstep(0.50, 0.16, radius);
        float tissue = smoothstep(0.02, 0.86, vIntensity);
        float alpha = dotShape * (0.05 + 0.28 * tissue) * alphaScale;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(ramp(vIntensity), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
}

function makeBackgroundPlaneMaterial(texture, baseAlpha) {
  return new THREE.ShaderMaterial({
    uniforms: {
      map: { value: texture },
      alphaScale: { value: 0.0 },
      baseAlpha: { value: baseAlpha },
    },
    vertexShader: `
      varying vec2 vUv;

      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D map;
      uniform float alphaScale;
      uniform float baseAlpha;
      varying vec2 vUv;

      void main() {
        float value = texture2D(map, vUv).r;
        float tissue = smoothstep(0.11, 0.98, value);
        tissue = pow(tissue, 1.25);
        vec3 low = vec3(0.010, 0.015, 0.022);
        vec3 mid = vec3(0.13, 0.23, 0.30);
        vec3 high = vec3(0.58, 0.76, 0.80);
        vec3 color = mix(low, mid, smoothstep(0.04, 0.72, tissue));
        color = mix(color, high, smoothstep(0.72, 1.0, tissue));
        float alpha = (0.01 + 0.58 * tissue) * baseAlpha * alphaScale;
        if (alpha < 0.008) discard;
        gl_FragColor = vec4(color, alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });
}

function addBackgroundPlanes(xb, yb, zb) {
  const planes = meta.background_planes?.planes;
  if (!planes || !Object.keys(backgroundPlaneBuffers).length) return;

  const xCenter = (xb[0] + xb[1]) / 2;
  const elevCenter = (yb[0] + yb[1]) / 2;
  const depthCenter = -(zb[0] + zb[1]) / 2;
  const xWidth = xb[1] - xb[0];
  const depthHeight = zb[1] - zb[0];

  const configs = [
    {
      name: "xz",
      position: [xCenter, depthCenter, elevCenter],
      size: [xWidth, depthHeight],
      rotation: [0, 0, 0],
      alpha: 0.82,
    },
  ];

  for (const config of configs) {
    const plane = planes[config.name];
    const buffer = backgroundPlaneBuffers[config.name];
    if (!plane || !buffer) continue;
    const size = plane.width * plane.height;
    const texture = new THREE.DataTexture(new Uint8Array(size), plane.width, plane.height, THREE.RedFormat);
    texture.needsUpdate = true;
    texture.flipY = true;
    const material = makeBackgroundPlaneMaterial(texture, config.alpha);
    const geometry = new THREE.PlaneGeometry(config.size[0], config.size[1]);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(config.position[0], config.position[1], config.position[2]);
    mesh.rotation.set(config.rotation[0], config.rotation[1], config.rotation[2]);
    mesh.renderOrder = -1;
    scene.add(mesh);
    backgroundPlanes.push({ mesh, material, texture, buffer, ...plane });
    backgroundPlaneMaterials.push(material);
  }
}

function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06070a);
  scene.fog = new THREE.FogExp2(0x06070a, 0.012);

  renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;
  viewport.appendChild(renderer.domElement);

  camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 2000);
  const xb = meta.bounds_mm.x;
  const yb = meta.bounds_mm.y;
  const zb = meta.bounds_mm.z;
  const center = new THREE.Vector3(
    (xb[0] + xb[1]) / 2,
    -(zb[0] + zb[1]) / 2,
    (yb[0] + yb[1]) / 2,
  );
  camera.position.set(center.x + 45, center.y + 24, center.z + 70);
  camera.lookAt(center);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.copy(center);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.72;
  controls.zoomSpeed = 0.75;

  addVolumeContext(xb, yb, zb);

  addBackgroundPlanes(xb, yb, zb);

  backgroundMaterial = makeBackgroundMaterial(renderer.getPixelRatio());
  backgroundCloud = new THREE.Points(new THREE.BufferGeometry(), backgroundMaterial);
  scene.add(backgroundCloud);

  pointMaterial = new THREE.ShaderMaterial({
    uniforms: {
      pointSize: { value: Number(pointSizeInput.value) },
      pixelRatio: { value: renderer.getPixelRatio() },
      alphaScale: { value: 0.0 },
      pointScale: { value: 1.0 },
      pointTone: { value: 0.0 },
    },
    vertexShader: `
      uniform float pointSize;
      uniform float pixelRatio;
      uniform float pointScale;
      attribute float intensity;
      varying float vIntensity;

      void main() {
        vIntensity = intensity;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        float attenuation = 220.0 / max(120.0, -mvPosition.z);
        gl_PointSize = clamp(pointSize * pointScale * pixelRatio * (0.70 + intensity * 0.95) * attenuation, 0.8, 10.0);
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    fragmentShader: `
      uniform float alphaScale;
      uniform float pointTone;
      varying float vIntensity;

      vec3 svdRamp(float t) {
        vec3 deep = vec3(0.02, 0.18, 0.50);
        vec3 cyan = vec3(0.04, 0.86, 1.00);
        vec3 ice = vec3(0.52, 0.96, 1.00);
        vec3 white = vec3(0.96, 1.00, 1.00);
        vec3 color = mix(deep, cyan, smoothstep(0.04, 0.56, t));
        color = mix(color, ice, smoothstep(0.50, 0.84, t));
        color = mix(color, white, smoothstep(0.84, 1.00, t));
        return color;
      }

      vec3 detectRamp(float t) {
        vec3 amber = vec3(0.96, 0.44, 0.03);
        vec3 gold = vec3(1.00, 0.82, 0.16);
        vec3 cream = vec3(1.00, 0.96, 0.72);
        vec3 white = vec3(1.00, 1.00, 0.98);
        vec3 color = mix(amber, gold, smoothstep(0.08, 0.56, t));
        color = mix(color, cream, smoothstep(0.50, 0.84, t));
        color = mix(color, white, smoothstep(0.84, 1.00, t));
        return color;
      }

      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float radius = length(uv);
        float core = smoothstep(0.46, 0.12, radius);
        float halo = smoothstep(0.50, 0.01, radius) * mix(0.24, 0.12, pointTone);
        float alpha = max(core, halo) * (0.34 + 0.66 * vIntensity) * alphaScale;
        if (alpha < 0.015) discard;
        gl_FragColor = vec4(mix(svdRamp(vIntensity), detectRamp(vIntensity), pointTone), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  pointCloud = new THREE.Points(new THREE.BufferGeometry(), pointMaterial);
  scene.add(pointCloud);

  trackGroup = new THREE.Group();
  trackStaticGroup = new THREE.Group();
  trackDynamicGroup = new THREE.Group();
  trackGroup.add(trackStaticGroup, trackDynamicGroup);
  trackFullMaterial = new THREE.LineBasicMaterial({
    color: 0xff9224,
    transparent: true,
    opacity: 0.26,
    depthWrite: false,
  });
  trackMaterial = new THREE.LineBasicMaterial({
    color: 0xffd45a,
    transparent: true,
    opacity: 0.88,
    depthWrite: false,
  });
  trackHeadGeometry = new THREE.SphereGeometry(0.17, 8, 8);
  trackHeadMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff2b3,
    transparent: true,
    opacity: 0.94,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  scene.add(trackGroup);

  detectionGroup = new THREE.Group();
  detectionHeadGeometry = new THREE.SphereGeometry(0.22, 12, 12);
  detectionHeadMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff1a8,
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  scene.add(detectionGroup);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    pointMaterial.uniforms.pixelRatio.value = renderer.getPixelRatio();
    backgroundMaterial.uniforms.pixelRatio.value = renderer.getPixelRatio();
  });
}

function frameOffset(index) {
  return offsets[index] || 0;
}

function backgroundFrameOffset(index) {
  return backgroundOffsets[index] || 0;
}

function buildOffsets(counts) {
  const result = [];
  let offset = 0;
  for (const count of counts || []) {
    result.push(offset);
    offset += count;
  }
  return result;
}

function hasBackground() {
  return Boolean(
    backgroundPlanes.length ||
      Object.keys(backgroundPlaneBuffers).length ||
      backgroundBuffer ||
      (backgroundPositionsBuffer && backgroundIntensitiesBuffer),
  );
}

function updateControlLabels() {
  tailValue.textContent = tailInput.value;
  pointSizeValue.textContent = Number(pointSizeInput.value).toFixed(1);
}

function updatePointCloud(cloud, buffer, counts, offset) {
  const count = counts[frame] || 0;
  const start = offset(frame);
  const view = new DataView(buffer, start * meta.record_bytes, count * meta.record_bytes);
  const positions = new Float32Array(count * 3);
  const intensities = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const base = i * meta.record_bytes;
    const ix = view.getUint16(base, true);
    const iy = view.getUint16(base + 2, true);
    const iz = view.getUint16(base + 4, true);
    const intensity = view.getUint8(base + 6) / 255;
    const p = worldFromIndex(ix, iy, iz);
    positions.set(p, i * 3);
    intensities[i] = intensity;
  }
  cloud.geometry.dispose();
  cloud.geometry = new THREE.BufferGeometry();
  cloud.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  cloud.geometry.setAttribute("intensity", new THREE.BufferAttribute(intensities, 1));
}

function updateBackgroundPoints() {
  if (!backgroundCloud) return;
  if (backgroundPlanes.length) return;
  if (backgroundPositionsBuffer && backgroundIntensitiesBuffer) {
    updateStaticBackgroundPoints();
    return;
  }
  if (backgroundBuffer) updatePointCloud(backgroundCloud, backgroundBuffer, meta.background_counts || [], backgroundFrameOffset);
}

function updatePoints() {
  updatePointCloud(pointCloud, pointBuffer, meta.counts || [], frameOffset);
}

function updateBackgroundPlanes() {
  for (const plane of backgroundPlanes) {
    const size = plane.width * plane.height;
    const start = frame * size;
    plane.texture.image.data = new Uint8Array(plane.buffer, start, size);
    plane.texture.needsUpdate = true;
  }
}

function updateStaticBackgroundPoints() {
  const count = meta.background_display?.sample_count || meta.background_counts?.[frame] || 0;
  const positionRecordBytes = meta.background_position_record_bytes || 6;
  const positionAttr = backgroundCloud.geometry.getAttribute("position");
  if (!positionAttr || positionAttr.count !== count) {
    const view = new DataView(backgroundPositionsBuffer, 0, count * positionRecordBytes);
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const base = i * positionRecordBytes;
      const ix = view.getUint16(base, true);
      const iy = view.getUint16(base + 2, true);
      const iz = view.getUint16(base + 4, true);
      positions.set(worldFromIndex(ix, iy, iz), i * 3);
    }
    backgroundCloud.geometry.dispose();
    backgroundCloud.geometry = new THREE.BufferGeometry();
    backgroundCloud.geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  }

  const start = frame * count;
  const raw = new Uint8Array(backgroundIntensitiesBuffer, start, count);
  const intensities = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    intensities[i] = raw[i] / 255;
  }
  backgroundCloud.geometry.setAttribute("intensity", new THREE.BufferAttribute(intensities, 1));
}

function stageState() {
  return stages[stage] || stages.raw;
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

function clearDisposableGroup(group) {
  for (const child of group.children) {
    if (child.userData.disposableGeometry) child.geometry.dispose();
  }
  group.clear();
}

function pushTrackSegment(coords, track, a, b) {
  coords.push(...worldFromTrack(track.x[a], track.y[a], track.z[a]));
  coords.push(...worldFromTrack(track.x[b], track.y[b], track.z[b]));
}

function addInstancedHeads(group, positions, geometry, material) {
  if (!positions.length) return;
  const mesh = new THREE.InstancedMesh(geometry, material, positions.length);
  const matrix = new THREE.Matrix4();
  for (let i = 0; i < positions.length; i++) {
    matrix.makeTranslation(positions[i][0], positions[i][1], positions[i][2]);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  group.add(mesh);
}

function buildStaticTracks() {
  if (trackStaticBuilt) return;
  clearDisposableGroup(trackStaticGroup);
  const coords = [];
  for (const track of tracks) {
    if (track.frames.length < 2) continue;
    for (let i = 1; i < track.frames.length; i++) {
      pushTrackSegment(coords, track, i - 1, i);
    }
  }
  if (coords.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(coords), 3));
    const line = new THREE.LineSegments(geometry, trackFullMaterial);
    line.userData.disposableGeometry = true;
    trackStaticGroup.add(line);
  }
  trackStaticBuilt = true;
}

function updateTracks() {
  if (!trackGroup) return;
  clearDisposableGroup(trackDynamicGroup);
  if (stage !== "track" || !showTracksInput.checked) return;
  buildStaticTracks();
  const tail = Math.max(0, Number(tailInput.value));
  const tailCoords = [];
  const headPositions = [];
  for (const track of tracks) {
    const last = indexAtOrBefore(track.frames, frame);
    if (last < 0) continue;
    headPositions.push(worldFromTrack(track.x[last], track.y[last], track.z[last]));
    const first = tail > 0 ? Math.max(0, last - tail) : last;
    for (let i = first + 1; i <= last; i++) {
      pushTrackSegment(tailCoords, track, i - 1, i);
    }
  }
  if (tailCoords.length) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(tailCoords), 3));
    const line = new THREE.LineSegments(geometry, trackMaterial);
    line.userData.disposableGeometry = true;
    trackDynamicGroup.add(line);
  }
  addInstancedHeads(trackDynamicGroup, headPositions, trackHeadGeometry, trackHeadMaterial);
}

function updateDetections() {
  if (!detectionGroup) return;
  detectionGroup.clear();
  if (stage !== "detect") return;
  const positions = [];
  for (const track of tracks) {
    const last = indexAtOrBefore(track.frames, frame);
    if (last < 0 || Math.abs(track.frames[last] - frame) >= 1.5) continue;
    positions.push(worldFromTrack(track.x[last], track.y[last], track.z[last]));
  }
  addInstancedHeads(detectionGroup, positions, detectionHeadGeometry, detectionHeadMaterial);
}

function updateStageButtons() {
  const current = stageState();
  modeEl.textContent = current.label;
  filterBtn.classList.toggle("active", stage === "filtered");
  detectBtn.classList.toggle("active", stage === "detect");
  trackBtn.classList.toggle("active", stage === "track");
}

function updatePresentation() {
  const current = stageState();
  const backgroundAlpha = hasBackground() ? current.backgroundAlpha : 0.0;
  for (const material of backgroundPlaneMaterials) {
    material.uniforms.alphaScale.value = backgroundAlpha;
  }
  if (backgroundMaterial) backgroundMaterial.uniforms.alphaScale.value = backgroundAlpha;
  if (pointMaterial) {
    pointMaterial.uniforms.alphaScale.value = current.foregroundAlpha;
    pointMaterial.uniforms.pointScale.value = current.pointScale;
    pointMaterial.uniforms.pointTone.value = current.pointTone;
  }
  if (detectionGroup) detectionGroup.visible = current.detections;
  if (trackGroup) trackGroup.visible = current.tracks && showTracksInput.checked;
  if (trackFullMaterial) trackFullMaterial.opacity = current.tracks ? 0.26 : 0.0;
  if (trackMaterial) trackMaterial.opacity = current.tracks ? 0.88 : 0.0;
  if (trackHeadMaterial) trackHeadMaterial.opacity = current.tracks ? 0.94 : 0.0;
  if (detectionHeadMaterial) detectionHeadMaterial.opacity = current.detections ? 0.98 : 0.0;
  updateStageButtons();
}

function setFrame(value) {
  frame = (value + meta.frames) % meta.frames;
  updateBackgroundPlanes();
  updateBackgroundPoints();
  updatePoints();
  updateTracks();
  updateDetections();
  updatePresentation();
  frameSlider.value = String(frame);
  frameText.textContent = `${frame + 1} / ${meta.frames}`;
}

function setStage(next) {
  if (!stages[next]) return;
  stage = next;
  if (stage === "filtered") detectBtn.disabled = false;
  if (stage === "detect") trackBtn.disabled = false;
  if (stage === "track") {
    detectBtn.disabled = false;
    trackBtn.disabled = false;
  }
  setFrame(frame);
}

function step(delta) {
  setFrame(frame + delta);
}

function setPlaying(value) {
  playing = value;
  playBtn.textContent = playing ? "Pause" : "Play";
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (playing) {
    timer = setInterval(() => step(1), Math.max(8, 1000 / Number(fpsInput.value || meta.fps || 30)));
  }
}

function animate() {
  requestAnimationFrame(animate);
  controls.autoRotate = autoRotateInput.checked;
  controls.update();
  renderer.render(scene, camera);
}

async function main() {
  const metaUrl = query("volume", "volume.json");
  meta = await loadJson(metaUrl);
  const base = metaUrl.includes("/") ? metaUrl.slice(0, metaUrl.lastIndexOf("/") + 1) : "";
  const planeEntries = Object.entries(meta.background_planes?.planes || {});
  const hasPlaneBackground = planeEntries.length > 0;
  const tracksPromise = loadJson(query("tracks", base + (meta.tracks || "tracks.json")));
  const pointsPromise = loadBuffer(query("points", base + (meta.points || "points.bin")));
  const planePromises = planeEntries.map(([name, plane]) =>
    loadBuffer(query(`background${name.toUpperCase()}`, base + plane.file)).then((buffer) => [name, buffer]),
  );
  const backgroundPositionsPromise =
    !hasPlaneBackground && meta.background_positions && meta.background_intensities
      ? loadBuffer(query("backgroundPositions", base + meta.background_positions))
      : Promise.resolve(null);
  const backgroundIntensitiesPromise =
    !hasPlaneBackground && meta.background_positions && meta.background_intensities
      ? loadBuffer(query("backgroundIntensities", base + meta.background_intensities))
      : Promise.resolve(null);
  const legacyBackgroundPromise =
    !hasPlaneBackground && meta.background_points && meta.background_counts
      ? loadBuffer(query("background", base + meta.background_points))
      : Promise.resolve(null);
  const [
    tracksPayload,
    pointsPayload,
    planePayloads,
    backgroundPositionsPayload,
    backgroundIntensitiesPayload,
    legacyBackground,
  ] = await Promise.all([
    tracksPromise,
    pointsPromise,
    Promise.all(planePromises),
    backgroundPositionsPromise,
    backgroundIntensitiesPromise,
    legacyBackgroundPromise,
  ]);
  tracks = tracksPayload.tracks || [];
  pointBuffer = pointsPayload;
  offsets = buildOffsets(meta.counts);
  backgroundPlaneBuffers = Object.fromEntries(planePayloads);
  if (backgroundPositionsPayload && backgroundIntensitiesPayload) {
    backgroundPositionsBuffer = backgroundPositionsPayload;
    backgroundIntensitiesBuffer = backgroundIntensitiesPayload;
  } else if (legacyBackground) {
    backgroundBuffer = legacyBackground;
    backgroundOffsets = buildOffsets(meta.background_counts);
  }
  frameSlider.max = String(meta.frames - 1);
  fpsInput.value = String(meta.fps || 30);
  tailInput.value = String(meta.tail_frames || 18);
  updateControlLabels();
  const backgroundStatus = meta.background_planes
    ? " | raw bg planes"
    : meta.background_display
      ? ` | ${meta.background_display.max_points_per_frame} bg samples`
      : "";
  statusEl.textContent = `${meta.frames} frames | ${tracks.length} tracks | ${meta.display.max_points_per_frame} SVD voxels${backgroundStatus}`;
  initScene();
  setFrame(0);
  animate();
}

filterBtn.addEventListener("click", () => setStage("filtered"));
detectBtn.addEventListener("click", () => setStage("detect"));
trackBtn.addEventListener("click", () => setStage("track"));
playBtn.addEventListener("click", () => setPlaying(!playing));
prevBtn.addEventListener("click", () => step(-1));
nextBtn.addEventListener("click", () => step(1));
frameSlider.addEventListener("input", () => setFrame(Number(frameSlider.value)));
fpsInput.addEventListener("change", () => {
  if (playing) setPlaying(true);
});
tailInput.addEventListener("input", () => {
  updateControlLabels();
  if (trackGroup) {
    updateTracks();
    updatePresentation();
  }
});
pointSizeInput.addEventListener("input", () => {
  updateControlLabels();
  if (pointMaterial) pointMaterial.uniforms.pointSize.value = Number(pointSizeInput.value);
});
showTracksInput.addEventListener("change", () => {
  if (trackGroup) {
    updateTracks();
    updatePresentation();
  }
});

window.addEventListener("keydown", (event) => {
  if (!meta) return;
  if (event.target instanceof HTMLInputElement) return;
  if (event.code === "Space") {
    event.preventDefault();
    setPlaying(!playing);
  } else if (event.key === "ArrowLeft") {
    step(-1);
  } else if (event.key === "ArrowRight") {
    step(1);
  }
});

main().catch((err) => {
  console.error(err);
  statusEl.textContent = err.message;
});
