import * as THREE from 'three';

export type LandmarkId =
  | 'tea'
  | 'meadow'
  | 'bridge'
  | 'rose'
  | 'mystery'
  | 'astro'
  | 'ball'
  | 'derrick'
  | 'monolith'
  | 'thumper'
  | 'fargo'
  | 'comfy'
  | 'sixhand'
  | 'lascaux'
  | 'david'
  | 'painter'
  | 'tinkerer'
  | 'keeper'
  | 'helping'
  | 'hobbit'
  | 'thinker'
  | 'irongiant';

export interface PlanetEngineAPI {
  rotateToLandmark: (lmId: LandmarkId) => void;
  setTimeOfDay: (hours: number) => void;
  setPlanetScale: (scale: number) => void;
  setClayMode: (enabled: boolean) => void;
  setPixelFilter: (enabled: boolean) => void;
  setPaused: (paused: boolean) => void;
  setReducedMotion: (reduced: boolean) => void;
  setTurnaroundVisible: (visible: boolean) => void;
  setTurnaroundYaw: (yaw: number) => void;
  dispose: () => void;
}

type ResourceCounts = Record<'geometry' | 'material' | 'texture' | 'renderTarget' | 'skeleton', number>;

export function initPlanetEngine(
  canvas: HTMLCanvasElement,
  callbacks: {
    onReady: () => void;
    onToast?: (msg: string) => void;
    onTimeChange?: (hours: number) => void;
  },
  options: { fixedPose?: boolean; onResourceAudit?: (audit: { created: ResourceCounts; disposed: ResourceCounts; peak: ResourceCounts; live: ResourceCounts }) => void } = {}
): PlanetEngineAPI | null {
  const ownedResources = new Set<{ dispose: () => void }>();
  const emptyCounts = (): ResourceCounts => ({ geometry: 0, material: 0, texture: 0, renderTarget: 0, skeleton: 0 });
  const created = emptyCounts();
  const disposedCounts = emptyCounts();
  const live = emptyCounts();
  const peak = emptyCounts();
  const own = <T extends { dispose: () => void }>(resource: T): T => {
    const category: keyof ResourceCounts = resource instanceof THREE.BufferGeometry ? 'geometry'
      : resource instanceof THREE.Material ? 'material'
        : resource instanceof THREE.Texture ? 'texture'
          : resource instanceof THREE.WebGLRenderTarget ? 'renderTarget' : 'skeleton';
    const release = resource.dispose.bind(resource);
    ownedResources.add(resource);
    created[category]++;
    live[category]++;
    peak[category] = Math.max(peak[category], live[category]);
    resource.dispose = () => {
      if (ownedResources.delete(resource)) {
        disposedCounts[category]++;
        live[category]--;
        release();
      }
    };
    return resource;
  };

interface LandmarkConfig {
  id: LandmarkId;
  label: string;
  dir: THREE.Vector3;
  flatRadius: number;
}

const WORLD_CONFIG: {
  planetRadius: number;
  waterRadius: number;
  autoRotateSecondsPerTurn: number;
  idleResumeDelay: number;
  landmarks: Record<LandmarkId, LandmarkConfig>;
} = {
  planetRadius: 3.2,
  waterRadius: 3.155,
  autoRotateSecondsPerTurn: 150,
  idleResumeDelay: 3.6,
  landmarks: {
    tea: { id: 'tea', label: 'Tea Clearing', dir: new THREE.Vector3(0.52, -0.76, 0.39).normalize(), flatRadius: 0.44 },
    meadow: { id: 'meadow', label: 'Playful Meadow', dir: new THREE.Vector3(-0.38, 0.68, 0.63).normalize(), flatRadius: 0.56 },
    bridge: { id: 'bridge', label: 'Stream Bridge', dir: new THREE.Vector3(0.02, 0.3, 0.953).normalize(), flatRadius: 0.25 },
    rose: { id: 'rose', label: 'Desert Rose', dir: new THREE.Vector3(0.32, -0.52, -0.79).normalize(), flatRadius: 0.38 },
    mystery: { id: 'mystery', label: 'Mystery Box', dir: new THREE.Vector3(-0.72, 0.48, -0.5).normalize(), flatRadius: 0.35 },
    astro: { id: 'astro', label: 'Astronomer Rise', dir: new THREE.Vector3(-0.88, 0.04, -0.47).normalize(), flatRadius: 0.36 },
    ball: { id: 'ball', label: 'Ball Clearing', dir: new THREE.Vector3(-0.06, -0.79, 0.61).normalize(), flatRadius: 0.56 },
    derrick: { id: 'derrick', label: 'Oil Derrick', dir: new THREE.Vector3(0.92, -0.1, -0.38).normalize(), flatRadius: 0.38 },
    monolith: { id: 'monolith', label: '2001 Monolith', dir: new THREE.Vector3(0.18, 0.88, -0.44).normalize(), flatRadius: 0.72 },
    thumper: { id: 'thumper', label: 'Dune Thumper', dir: new THREE.Vector3(-0.78, 0.54, 0.31).normalize(), flatRadius: 0.32 },
    fargo: { id: 'fargo', label: 'Fargo Ridge', dir: new THREE.Vector3(-0.36, 0.72, -0.59).normalize(), flatRadius: 0.24 },
    comfy: { id: 'comfy', label: 'Comfy Fennec', dir: new THREE.Vector3(-0.68, -0.44, 0.59).normalize(), flatRadius: 0.36 },
    sixhand: { id: 'sixhand', label: 'Six-Fingered Hand', dir: new THREE.Vector3(0.76, -0.18, 0.62).normalize(), flatRadius: 0.34 },
    lascaux: { id: 'lascaux', label: 'Lascaux Boulder', dir: new THREE.Vector3(-0.46, -0.78, -0.42).normalize(), flatRadius: 0.34 },
    david: { id: 'david', label: 'Statue of David', dir: new THREE.Vector3(-0.26, -0.16, -0.95).normalize(), flatRadius: 0.38 },
    painter: { id: 'painter', label: 'The Painter Studio', dir: new THREE.Vector3(-0.24, -0.14, 0.96).normalize(), flatRadius: 0.36 },
    tinkerer: { id: 'tinkerer', label: 'The Tinkerer Bench', dir: new THREE.Vector3(0.32, -0.36, 0.87).normalize(), flatRadius: 0.34 },
    keeper: { id: 'keeper', label: 'Garden Library', dir: new THREE.Vector3(-0.56, 0.12, 0.82).normalize(), flatRadius: 0.34 },
    helping: { id: 'helping', label: 'The Helping Hand', dir: new THREE.Vector3(0.72, 0.64, -0.26).normalize(), flatRadius: 0.34 },
    hobbit: { id: 'hobbit', label: 'Hobbit Hole', dir: new THREE.Vector3(0.56, 0.78, 0.28).normalize(), flatRadius: 0.36 },
    thinker: { id: 'thinker', label: 'The Thinker', dir: new THREE.Vector3(-0.48, -0.78, 0.40).normalize(), flatRadius: 0.24 },
    irongiant: { id: 'irongiant', label: 'The Iron Giant', dir: new THREE.Vector3(0.275, 0.312, -0.909).normalize(), flatRadius: 0.34 },
  },
};

const BRIDGE_BASE_R = WORLD_CONFIG.waterRadius + 0.13;

const { bridgeRight: BRIDGE_RIGHT, bridgeFwd: BRIDGE_FWD, bridgeQuat: BRIDGE_QUAT } = (() => {
  const up = WORLD_CONFIG.landmarks.bridge.dir.clone().normalize();
  const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(up, ref).normalize();
  const fwd = new THREE.Vector3().crossVectors(right, up).normalize();
  const q = new THREE.Quaternion()
    .setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, fwd))
    .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -0.15));
  return {
    bridgeRight: new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize(),
    bridgeFwd: new THREE.Vector3(0, 0, 1).applyQuaternion(q).normalize(),
    bridgeQuat: q,
  };
})();

function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function fbmSphere(nx: number, ny: number, nz: number): number {
  let v = 0;
  v += 0.5 * Math.sin(nx * 3.1 + 0.4) * Math.cos(ny * 2.8 - 0.3) * Math.sin(nz * 3.3 + 0.9);
  v += 0.3 * Math.sin(nx * 6.3 - nz * 4.7 + 1.2) * Math.cos(ny * 5.9 + nx * 2.1);
  v += 0.2 * Math.cos(nz * 10.2 + ny * 8.4 - nx * 6.5);
  return v;
}

function getDesertMask(dir: THREE.Vector3): number {
  const dRose = dir.angleTo(WORLD_CONFIG.landmarks.rose.dir);
  const dDerrick = dir.angleTo(WORLD_CONFIG.landmarks.derrick.dir);
  const dThumper = dir.angleTo(WORLD_CONFIG.landmarks.thumper.dir);
  const edgeNoise = fbmSphere(dir.x * 3.8, dir.y * 3.8, dir.z * 3.8) * 0.065;
  const mRose = 1 - smoothstep(0.36, 0.76, dRose);
  const mDerrick = 1 - smoothstep(0.32, 0.68, dDerrick);
  const mThumper = 1 - smoothstep(0.24, 0.48 + edgeNoise, dThumper);
  return Math.max(mRose, mDerrick, mThumper);
}

const ALPINE_PEAK_A = new THREE.Vector3(-0.24, 0.78, -0.57).normalize();
const ALPINE_PEAK_B = new THREE.Vector3(-0.08, 0.82, -0.56).normalize();
const ALPINE_PEAK_C = new THREE.Vector3(-0.42, 0.68, -0.6).normalize();

function getAlpineMask(dir: THREE.Vector3): number {
  const mA = 1 - smoothstep(0.06, 0.34, dir.angleTo(ALPINE_PEAK_A));
  const mB = 1 - smoothstep(0.05, 0.28, dir.angleTo(ALPINE_PEAK_B));
  const mC = 1 - smoothstep(0.05, 0.28, dir.angleTo(ALPINE_PEAK_C));
  return Math.max(mA, mB * 0.9, mC * 0.85);
}

function getRiverFactor(dir: THREE.Vector3): number {
  const meander = 0.14 * Math.sin(dir.x * 4.2 + dir.y * 2.5);
  const planeDist = Math.abs(dir.y * 0.88 - dir.z * 0.36 - 0.04 + meander);
  // Keep stream cleanly in the front valley under the bridge and into a compact pond (no back-hemisphere flooding)
  const frontSpan = smoothstep(0.05, 0.42, dir.z) * smoothstep(-0.62, -0.26, dir.x) * (1 - smoothstep(0.68, 0.92, dir.x));
  const stream = (1 - smoothstep(0.058, 0.125, planeDist)) * frontSpan;
  const bridgeChannel = 1 - smoothstep(0.048, 0.095, Math.abs(dir.y - 0.30 - (dir.x - 0.02) * 0.15));
  const nearBridge = 1 - smoothstep(0.08, 0.18, dir.angleTo(WORLD_CONFIG.landmarks.bridge.dir));

  const pondCenter = new THREE.Vector3(0.64, 0.08, 0.76).normalize();
  const pondDist = dir.angleTo(pondCenter);
  const pond = 1 - smoothstep(0.11, 0.21, pondDist);

  // Keep water completely out of the desert (Rose + Oil Derrick) and the Ball Clearing
  const desertClear = 1 - getDesertMask(dir);
  const ballClear = smoothstep(0.28, 0.48, dir.angleTo(WORLD_CONFIG.landmarks.ball.dir));

  return Math.min(1, Math.max(stream, bridgeChannel * nearBridge, pond)) * desertClear * ballClear;
}

function getPathFactor(dir: THREE.Vector3): number {
  const dTea = dir.angleTo(WORLD_CONFIG.landmarks.tea.dir);
  const dAstro = dir.angleTo(WORLD_CONFIG.landmarks.astro.dir);

  const segDist = (a: THREE.Vector3, b: THREE.Vector3) => {
    const ab = b.clone().sub(a);
    const ap = dir.clone().sub(a);
    const t = Math.max(0, Math.min(1, ap.dot(ab) / Math.max(1e-5, ab.lengthSq())));
    const closest = a.clone().addScaledVector(ab, t).normalize();
    return dir.angleTo(closest);
  };

  const p1 = 1 - smoothstep(0.032, 0.068, segDist(WORLD_CONFIG.landmarks.meadow.dir, WORLD_CONFIG.landmarks.bridge.dir));
  const p2 = 1 - smoothstep(0.032, 0.068, segDist(WORLD_CONFIG.landmarks.bridge.dir, WORLD_CONFIG.landmarks.tea.dir));
  const p3 = 1 - smoothstep(0.032, 0.068, segDist(WORLD_CONFIG.landmarks.meadow.dir, WORLD_CONFIG.landmarks.mystery.dir));
  const p4 = 1 - smoothstep(0.032, 0.068, segDist(WORLD_CONFIG.landmarks.mystery.dir, WORLD_CONFIG.landmarks.astro.dir));

  const clearings =
    (1 - smoothstep(0.07, 0.14, dTea)) * 0.7 +
    (1 - smoothstep(0.09, 0.16, dAstro)) * 0.65;

  return Math.min(1, Math.max(p1, p2, p3, p4, clearings));
}

function getTerrainHeight(dir: THREE.Vector3): number {
  const R = WORLD_CONFIG.planetRadius;
  const noise = fbmSphere(dir.x, dir.y, dir.z);
  const valleyRidge = Math.sin(dir.x * 2.5 + dir.z * 2.1) * Math.cos(dir.y * 2.6 - dir.x * 1.6) * 0.078;
  // Softly floor non-river valleys above waterRadius so rolling hills & valleys never flood landmarks or minks
  const rawRelief = noise * 0.132 + valleyRidge + 0.044;
  const minDry = -0.02;
  const smoothRelief =
    minDry + 0.5 * ((rawRelief - minDry) + Math.sqrt((rawRelief - minDry) * (rawRelief - minDry) + 0.0014));
  let h = R + smoothRelief;

  const dMeadow = dir.angleTo(WORLD_CONFIG.landmarks.meadow.dir);
  const dAstro = dir.angleTo(WORLD_CONFIG.landmarks.astro.dir);
  h += (1 - smoothstep(0.15, 0.52, dMeadow)) * 0.06;
  h += (1 - smoothstep(0.1, 0.42, dAstro)) * 0.095;

  const desertMask = getDesertMask(dir);
  const duneWave =
    Math.sin(dir.x * 11.0 + dir.z * 8.5) * 0.036 +
    Math.cos(dir.y * 13.5 - dir.x * 7.5) * 0.022;
  h = THREE.MathUtils.lerp(h, R + 0.02 + duneWave, desertMask * 0.74);

  // Gentle alpine highland rise (crisp peaks sit cleanly on top as sculpted rock/snow massifs)
  const alpineMask = getAlpineMask(dir);
  if (alpineMask > 0.001) {
    h += alpineMask * 0.085;
  }

  for (const lm of Object.values(WORLD_CONFIG.landmarks)) {
    if (lm.id === 'bridge' || lm.id === 'fargo') continue;
    const ang = dir.angleTo(lm.dir);
    const flat = 1 - smoothstep(0.05, lm.flatRadius / R, ang);
    const localValley =
      Math.sin(lm.dir.x * 2.5 + lm.dir.z * 2.1) * Math.cos(lm.dir.y * 2.6 - lm.dir.x * 1.6) * 0.045;
    const targetH =
      lm.id === 'astro'
        ? R + 0.115
        : lm.id === 'meadow'
          ? R + 0.068
          : R + 0.028 + THREE.MathUtils.clamp(localValley, -0.012, 0.055);
    h = THREE.MathUtils.lerp(h, targetH, flat * 0.85);
  }

  const river = getRiverFactor(dir);
  h -= river * 0.21;

  return h;
}

function getTerrainNormal(dir: THREE.Vector3): THREE.Vector3 {
  const eps = 0.008;
  const upRef = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const t1 = new THREE.Vector3().crossVectors(upRef, dir).normalize();
  const t2 = new THREE.Vector3().crossVectors(dir, t1).normalize();

  const p0 = dir.clone().multiplyScalar(getTerrainHeight(dir));
  const d1 = dir.clone().addScaledVector(t1, eps).normalize();
  const d2 = dir.clone().addScaledVector(t2, eps).normalize();
  const p1 = d1.clone().multiplyScalar(getTerrainHeight(d1));
  const p2 = d2.clone().multiplyScalar(getTerrainHeight(d2));

  const normal = new THREE.Vector3().crossVectors(p1.sub(p0), p2.sub(p0)).normalize();
  if (normal.dot(dir) < 0) normal.negate();
  return normal;
}

interface RenderedTri {
  a: THREE.Vector3;
  b: THREE.Vector3;
  c: THREE.Vector3;
  n: THREE.Vector3;
  cDir: THREE.Vector3;
}

let renderedPlanetTris: RenderedTri[] = [];
const _triEdge1 = new THREE.Vector3();
const _triEdge2 = new THREE.Vector3();
const _triToHit = new THREE.Vector3();
const _triCross = new THREE.Vector3();

function getRenderedTerrainHeight(dir: THREE.Vector3): number {
  for (let i = 0; i < renderedPlanetTris.length; i++) {
    const t = renderedPlanetTris[i];
    if (t.cDir.dot(dir) < 0.88) continue;
    const denom = dir.dot(t.n);
    if (denom <= 1e-5) continue;
    const dist = t.a.dot(t.n) / denom;
    if (dist <= 0) continue;
    const hx = dir.x * dist;
    const hy = dir.y * dist;
    const hz = dir.z * dist;
    _triEdge1.subVectors(t.b, t.a);
    _triToHit.set(hx - t.a.x, hy - t.a.y, hz - t.a.z);
    if (_triCross.crossVectors(_triEdge1, _triToHit).dot(t.n) < -1e-4) continue;
    _triEdge2.subVectors(t.c, t.b);
    _triToHit.set(hx - t.b.x, hy - t.b.y, hz - t.b.z);
    if (_triCross.crossVectors(_triEdge2, _triToHit).dot(t.n) < -1e-4) continue;
    _triEdge1.subVectors(t.a, t.c);
    _triToHit.set(hx - t.c.x, hy - t.c.y, hz - t.c.z);
    if (_triCross.crossVectors(_triEdge1, _triToHit).dot(t.n) < -1e-4) continue;
    return dist;
  }
  return getTerrainHeight(dir);
}

function isOnBridgeCorridor(dir: THREE.Vector3): boolean {
  return (
    dir.dot(WORLD_CONFIG.landmarks.bridge.dir) > 0.9 &&
    Math.abs(dir.dot(BRIDGE_RIGHT)) < 0.036 &&
    Math.abs(dir.dot(BRIDGE_FWD)) < 0.128
  );
}

function isBridgeRestrictedSpot(dir: THREE.Vector3): boolean {
  return (
    dir.dot(WORLD_CONFIG.landmarks.bridge.dir) > 0.9 &&
    Math.abs(dir.dot(BRIDGE_RIGHT)) < 0.058 &&
    Math.abs(dir.dot(BRIDGE_FWD)) < 0.145
  );
}

function getWalkableSurface(dir: THREE.Vector3) {
  const bridgeDir = WORLD_CONFIG.landmarks.bridge.dir;
  let h = getRenderedTerrainHeight(dir);
  let onBridge = false;

  // Match the exact arched plank top surface (0.24 wide x 0.80 long) so minks never sink into planks or float beside handrails
  const acrossBridge = Math.abs(dir.dot(BRIDGE_RIGHT));
  const alongBridge = Math.abs(dir.dot(BRIDGE_FWD));
  if (dir.dot(bridgeDir) > 0.9 && acrossBridge < 0.036 && alongBridge < 0.126) {
    const zLocal = alongBridge * BRIDGE_BASE_R;
    const tAlong = Math.min(1, zLocal / 0.4);
    const sphereComp = (zLocal * zLocal) / (2 * WORLD_CONFIG.planetRadius);
    const yTopLocal = Math.cos(tAlong * Math.PI * 0.5) * 0.062 + sphereComp + 0.013;
    const bridgeDeckH = Math.hypot(BRIDGE_BASE_R + yTopLocal, zLocal);
    if (bridgeDeckH > h) {
      h = bridgeDeckH;
      onBridge = true;
    }
  }
  const pos = dir.clone().multiplyScalar(h);
  const normal = onBridge ? dir.clone() : getTerrainNormal(dir);
  return { position: pos, normal, height: h, onBridge };
}

function createMinkPixelTexture(): THREE.CanvasTexture {
  const LW = 64, LH = 64, SCALE = 4;
  const canvas = document.createElement('canvas');
  canvas.width = LW * SCALE;
  canvas.height = LH * SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const px = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x * SCALE, y * SCALE, w * SCALE, h * SCALE);
  };

  const ORANGE_MAIN = '#f47119';
  const ORANGE_WARM = '#e6600c';
  const ORANGE_DEEP = '#c74c06';
  const CREAM = '#fcf0d9';
  const CREAM_EDGE = '#f7c58a';
  const TAIL_DARK = '#7c2805';
  const TAIL_DEEP = '#5d1c02';
  const EYE_DARK = '#16110e';
  const PAW_TIP = '#bd4708';

  px(0, 0, 64, 64, ORANGE_MAIN);
  px(18, 12, 12, 38, ORANGE_WARM);
  px(20, 16, 8, 30, ORANGE_DEEP);

  px(0, 54, 48, 10, TAIL_DARK);
  px(0, 58, 48, 6, TAIL_DEEP);
  for (let x = 0; x < 48; x += 2) {
    if ((x / 2) % 2 === 0) px(x, 53, 2, 1, TAIL_DARK);
    else px(x, 54, 2, 1, ORANGE_MAIN);
  }

  const bellyHalfWidth = (y: number) => {
    if (y < 5 || y > 42) return 0;
    if (y <= 10) return 5;
    if (y <= 16) return 7;
    if (y <= 26) return 9;
    if (y <= 36) return 8;
    if (y <= 39) return 5;
    return 2;
  };

  for (let y = 5; y <= 42; y++) {
    const hw = bellyHalfWidth(y);
    if (hw > 0) {
      px(0, y, hw, 1, CREAM);
      px(48 - hw, y, hw, 1, CREAM);
      px(hw, y, 1, 1, CREAM_EDGE);
      px(47 - hw, y, 1, 1, CREAM_EDGE);
    }
  }

  px(14, 7, 2, 2, EYE_DARK);
  px(32, 7, 2, 2, EYE_DARK);
  px(21, 0, 6, 3, EYE_DARK);

  px(48, 0, 16, 64, ORANGE_MAIN);
  px(48, 46, 16, 18, PAW_TIP);
  px(48, 44, 16, 2, ORANGE_WARM);
  px(56, 2, 6, 10, ORANGE_DEEP);
  px(58, 5, 3, 5, TAIL_DARK);
  // Crisp deep obsidian-black swatch for protruding 3D eyes & nose tip
  px(54, 22, 9, 12, '#0f0b09');

  const tex = own(new THREE.CanvasTexture(canvas));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 4;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}

function createPixelArtTexture(
  width: number,
  height: number,
  draw: (px: (x: number, y: number, w: number, h: number, color: string) => void) => void
): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const px = (x: number, y: number, w: number, h: number, color: string) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  draw(px);
  const tex = own(new THREE.CanvasTexture(c));
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

function createSleepZTexture(): THREE.CanvasTexture {
  return createPixelArtTexture(9, 10, (px) => {
    // Tiny pixel 'z' with dark outline so sleepy breaths read cleanly over grass, wood, or night sky
    px(1, 0, 7, 1, '#261e18');
    px(1, 1, 1, 2, '#261e18');
    px(7, 1, 1, 2, '#261e18');
    px(4, 3, 3, 2, '#261e18');
    px(2, 5, 3, 2, '#261e18');
    px(1, 7, 7, 3, '#261e18');
    // Warm sleepy cream-gold letter fill
    px(2, 1, 5, 1, '#ffe496');
    px(5, 2, 1, 1, '#ffe496');
    px(4, 3, 2, 1, '#ffe496');
    px(3, 4, 2, 1, '#ffe496');
    px(2, 5, 2, 1, '#ffe496');
    px(2, 6, 1, 1, '#ffe496');
    px(2, 7, 5, 1, '#ffe496');
  });
}

function createMinkGeometry(): THREE.BufferGeometry {
  const stations: [number, number, number, number, number, number, number, number][] = [
    [-0.37, 0.112, 0.004, 0.004, 0.0, 9, 9, 1.0],
    [-0.354, 0.11, 0.018, 0.017, 0.04, 9, 8, 0.85],
    [-0.318, 0.102, 0.026, 0.024, 0.1, 8, 9, 0.65],
    [-0.272, 0.094, 0.032, 0.029, 0.16, 8, 7, 0.7],
    [-0.215, 0.09, 0.038, 0.034, 0.24, 7, 6, 0.75],
    [-0.155, 0.098, 0.048, 0.044, 0.31, 6, 1, 0.7],
    [-0.105, 0.108, 0.059, 0.054, 0.38, 1, 6, 0.8],
    [-0.042, 0.111, 0.062, 0.056, 0.47, 1, 2, 0.45],
    [0.028, 0.115, 0.059, 0.054, 0.56, 2, 3, 0.6],
    [0.092, 0.12, 0.056, 0.054, 0.65, 3, 2, 0.85],
    [0.138, 0.139, 0.047, 0.047, 0.72, 3, 4, 0.45],
    [0.168, 0.167, 0.041, 0.041, 0.77, 4, 5, 0.75],
    [0.192, 0.195, 0.048, 0.046, 0.82, 5, 4, 0.65],
    [0.216, 0.205, 0.051, 0.048, 0.87, 5, 5, 1.0],
    [0.244, 0.2, 0.041, 0.038, 0.91, 5, 5, 1.0],
    [0.269, 0.192, 0.028, 0.025, 0.95, 5, 5, 1.0],
    [0.289, 0.188, 0.016, 0.015, 0.985, 5, 5, 1.0],
    [0.298, 0.187, 0.004, 0.004, 1.0, 5, 5, 1.0],
  ];

  const radialSegs = 18;
  const positions: number[] = [];
  const uvs: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i < stations.length; i++) {
    const [z, y, rx, ry, v, bA, bB, wA] = stations[i];
    const wB = 1.0 - wA;
    for (let j = 0; j <= radialSegs; j++) {
      const frac = j / radialSegs;
      const theta = -Math.PI + frac * Math.PI * 2;
      const sinT = Math.sin(theta);
      const cosT = Math.cos(theta);
      const yOff = cosT < 0 ? cosT * ry * 0.86 : cosT * ry;
      const xOff = sinT * rx;

      positions.push(xOff, y + yOff, z);
      uvs.push(frac * 0.74, v);
      skinIndices.push(bA, bB, 0, 0);
      skinWeights.push(wA, wB, 0, 0);
    }
  }

  const ringStride = radialSegs + 1;
  for (let i = 0; i < stations.length - 1; i++) {
    for (let j = 0; j < radialSegs; j++) {
      const a = i * ringStride + j;
      const b = (i + 1) * ringStride + j;
      const c = (i + 1) * ringStride + (j + 1);
      const d = i * ringStride + (j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const addCapsulePart = (
    cx: number,
    cy: number,
    cz: number,
    topR: number,
    botR: number,
    height: number,
    zBiasBot: number,
    boneIdx: number,
    parentBoneIdx: number,
    uMin: number,
    uMax: number,
    vTop: number,
    vBot: number
  ) => {
    const baseIdx = positions.length / 3;
    const stacks = 6;
    const segs = 10;
    for (let st = 0; st <= stacks; st++) {
      const t = st / stacks;
      const r = THREE.MathUtils.lerp(topR, botR, t);
      const yPos = cy - t * height;
      const zPos = cz + t * zBiasBot;
      const v = THREE.MathUtils.lerp(vTop, vBot, t);
      // Smoothly blend the upper shoulder/hip rings into the torso bone so limbs never detach
      const parentWeight = st === 0 ? 0.85 : st === 1 ? 0.45 : 0.0;
      const limbWeight = 1.0 - parentWeight;
      for (let j = 0; j <= segs; j++) {
        const frac = j / segs;
        const ang = frac * Math.PI * 2;
        const flare = st === stacks ? 1.15 : 1.0;
        positions.push(cx + Math.cos(ang) * r * flare, yPos, zPos + Math.sin(ang) * r * flare * 1.15);
        uvs.push(THREE.MathUtils.lerp(uMin, uMax, frac), v);
        skinIndices.push(boneIdx, parentBoneIdx, 0, 0);
        skinWeights.push(limbWeight, parentWeight, 0, 0);
      }
    }
    const stride = segs + 1;
    for (let st = 0; st < stacks; st++) {
      for (let j = 0; j < segs; j++) {
        const a = baseIdx + st * stride + j;
        const b = baseIdx + (st + 1) * stride + j;
        const c = baseIdx + (st + 1) * stride + (j + 1);
        const d = baseIdx + st * stride + (j + 1);
        indices.push(a, b, d);
        indices.push(b, c, d);
      }
    }
    const capCenterIdx = positions.length / 3;
    positions.push(cx, cy - height - 0.002, cz + zBiasBot);
    uvs.push((uMin + uMax) * 0.5, vBot);
    skinIndices.push(boneIdx, 0, 0, 0);
    skinWeights.push(1.0, 0, 0, 0);
    const lastRingStart = baseIdx + stacks * stride;
    for (let j = 0; j < segs; j++) {
      indices.push(lastRingStart + j, capCenterIdx, lastRingStart + j + 1);
    }
  };

  // Embed shoulders & hips inside the torso so raised paws stay smoothly attached
  addCapsulePart(0.032, 0.118, 0.102, 0.025, 0.017, 0.118, 0.014, 10, 3, 0.76, 0.86, 0.9, 0.12);
  addCapsulePart(-0.032, 0.118, 0.102, 0.025, 0.017, 0.118, 0.014, 11, 3, 0.76, 0.86, 0.9, 0.12);
  addCapsulePart(0.035, 0.108, -0.095, 0.027, 0.018, 0.108, 0.01, 12, 1, 0.76, 0.86, 0.9, 0.12);
  addCapsulePart(-0.035, 0.108, -0.095, 0.027, 0.018, 0.108, 0.01, 13, 1, 0.76, 0.86, 0.9, 0.12);

  const addEar = (ex: number, ey: number, ez: number, tiltX: number) => {
    const baseIdx = positions.length / 3;
    const earGeo = own(new THREE.SphereGeometry(0.018, 8, 6));
    earGeo.scale(0.85, 1.05, 0.55);
    earGeo.rotateZ(tiltX);
    earGeo.translate(ex, ey, ez);
    const posAttr = earGeo.attributes.position;
    const uvAttr = earGeo.attributes.uv;
    for (let k = 0; k < posAttr.count; k++) {
      positions.push(posAttr.getX(k), posAttr.getY(k), posAttr.getZ(k));
      uvs.push(0.89 + uvAttr.getX(k) * 0.09, 0.78 + uvAttr.getY(k) * 0.18);
      skinIndices.push(5, 0, 0, 0);
      skinWeights.push(1.0, 0, 0, 0);
    }
    const idx = earGeo.index!;
    for (let k = 0; k < idx.count; k++) {
      indices.push(baseIdx + idx.getX(k));
    }
    earGeo.dispose();
  };
  addEar(0.033, 0.236, 0.2, -0.35);
  addEar(-0.033, 0.236, 0.2, 0.35);

  const addBlackFeature = (fx: number, fy: number, fz: number, rad: number) => {
    const baseIdx = positions.length / 3;
    const fGeo = own(new THREE.SphereGeometry(rad, 8, 6));
    fGeo.translate(fx, fy, fz);
    const posAttr = fGeo.attributes.position;
    for (let k = 0; k < posAttr.count; k++) {
      positions.push(posAttr.getX(k), posAttr.getY(k), posAttr.getZ(k));
      uvs.push(0.915, 0.56);
      skinIndices.push(5, 0, 0, 0);
      skinWeights.push(1.0, 0, 0, 0);
    }
    const idx = fGeo.index!;
    for (let k = 0; k < idx.count; k++) {
      indices.push(baseIdx + idx.getX(k));
    }
    fGeo.dispose();
  };
  // Distinct little black eyes on both sides of the snout + dark nose button (brand-aligned)
  addBlackFeature(0.031, 0.208, 0.252, 0.0092);
  addBlackFeature(-0.031, 0.208, 0.252, 0.0092);
  addBlackFeature(0.0, 0.187, 0.299, 0.0075);

  const geom = own(new THREE.BufferGeometry());
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geom.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geom.setIndex(indices);
  geom.computeVertexNormals();
  return geom;
}

interface MinkRig {
  group: THREE.Group;
  mesh: THREE.SkinnedMesh;
  bones: THREE.Bone[];
  skeleton: THREE.Skeleton;
  propAnchor: THREE.Group;
}

function createMinkRig(sharedGeo: THREE.BufferGeometry, sharedMat: THREE.Material): MinkRig {
  const root = new THREE.Bone();
  root.position.set(0, 0.105, 0.0);
  const hips = new THREE.Bone();
  hips.position.set(0, 0.0, -0.09);
  root.add(hips);
  const spine = new THREE.Bone();
  spine.position.set(0, 0.005, 0.09);
  hips.add(spine);
  const chest = new THREE.Bone();
  chest.position.set(0, 0.008, 0.095);
  spine.add(chest);
  const neck = new THREE.Bone();
  neck.position.set(0, 0.037, 0.065);
  chest.add(neck);
  const head = new THREE.Bone();
  head.position.set(0, 0.045, 0.045);
  neck.add(head);

  const tail1 = new THREE.Bone();
  tail1.position.set(0, -0.01, -0.055);
  hips.add(tail1);
  const tail2 = new THREE.Bone();
  tail2.position.set(0, -0.007, -0.065);
  tail1.add(tail2);
  const tail3 = new THREE.Bone();
  tail3.position.set(0, 0.004, -0.065);
  tail2.add(tail3);
  const tail4 = new THREE.Bone();
  tail4.position.set(0, 0.013, -0.06);
  tail3.add(tail4);

  const legFL = new THREE.Bone();
  legFL.position.set(0.032, -0.008, 0.008);
  chest.add(legFL);
  const legFR = new THREE.Bone();
  legFR.position.set(-0.032, -0.008, 0.008);
  chest.add(legFR);
  const legBL = new THREE.Bone();
  legBL.position.set(0.035, -0.005, -0.005);
  hips.add(legBL);
  const legBR = new THREE.Bone();
  legBR.position.set(-0.035, -0.005, -0.005);
  hips.add(legBR);

  const bones = [root, hips, spine, chest, neck, head, tail1, tail2, tail3, tail4, legFL, legFR, legBL, legBR];
  const skeleton = own(new THREE.Skeleton(bones));

  const mesh = new THREE.SkinnedMesh(sharedGeo, sharedMat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.add(root);
  mesh.bind(skeleton);

  const propAnchor = new THREE.Group();
  propAnchor.position.set(0, -0.018, 0.085);
  chest.add(propAnchor);

  const group = new THREE.Group();
  group.add(mesh);

  return { group, mesh, bones, skeleton, propAnchor };
}

function createContactShadowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
  g.addColorStop(0, 'rgba(30, 22, 12, 0.34)');
  g.addColorStop(0.55, 'rgba(30, 22, 12, 0.14)');
  g.addColorStop(1, 'rgba(30, 22, 12, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  return own(new THREE.CanvasTexture(c));
}

interface PoseParams {
  state: string;
  time: number;
  seed?: number;
  glanceYaw?: number;
  glancePitch?: number;
  turnYaw?: number;
  chaseDir?: number;
  headRoll?: number;
}

function applyMinkPose(rig: MinkRig, pose: PoseParams, dt: number) {
  const b = rig.bones;
  const lerpFactor = 1 - Math.exp(-10.5 * dt);
  const setRot = (idx: number, rx: number, ry: number, rz: number) => {
    b[idx].rotation.x = THREE.MathUtils.lerp(b[idx].rotation.x, rx, lerpFactor);
    b[idx].rotation.y = THREE.MathUtils.lerp(b[idx].rotation.y, ry, lerpFactor);
    b[idx].rotation.z = THREE.MathUtils.lerp(b[idx].rotation.z, rz, lerpFactor);
  };

  const t = pose.time || 0;
  const breath = Math.sin(t * 2.4 + (pose.seed || 0)) * 0.025;
  const glanceYaw = pose.glanceYaw || 0;
  const glancePitch = pose.glancePitch || 0;
  const turnYaw = pose.turnYaw || 0;

  let rootY = 0.105;
  let hipsRx = 0, hipsRy = 0, hipsRz = 0;
  let spineRx = 0, spineRy = turnYaw * 0.3;
  let chestRx = breath, chestRy = turnYaw * 0.4;
  let neckRx = 0, neckRy = glanceYaw * 0.45 + turnYaw * 0.35;
  let headRx = glancePitch, headRy = glanceYaw * 0.55;
  let flRx = 0, frRx = 0, blRx = 0, brRx = 0;
  let flRz = 0, frRz = 0;
  let tailYaw = Math.sin(t * 1.9 + (pose.seed || 0)) * 0.14 - turnYaw * 0.45;
  let tailPitch = Math.cos(t * 1.5) * 0.06;

  switch (pose.state) {
    case 'walk':
    case 'run': {
      const isRun = pose.state === 'run';
      const freq = isRun ? 11.5 : 7.5;
      const amp = isRun ? 0.58 : 0.36;
      const ph = t * freq + (pose.seed || 0);
      rootY = 0.105 + Math.abs(Math.sin(ph)) * (isRun ? 0.018 : 0.008);
      hipsRx = Math.sin(ph) * (isRun ? 0.14 : 0.04);
      spineRx = -hipsRx * 1.1;
      neckRx = isRun ? 0.16 : 0.06;
      headRx += isRun ? -0.14 : -0.04;
      if (isRun) {
        flRx = Math.sin(ph) * amp;
        frRx = Math.sin(ph + 0.45) * amp;
        blRx = Math.sin(ph + Math.PI) * amp;
        brRx = Math.sin(ph + Math.PI + 0.45) * amp;
      } else {
        flRx = Math.sin(ph) * amp;
        brRx = Math.sin(ph) * amp;
        frRx = Math.sin(ph + Math.PI) * amp;
        blRx = Math.sin(ph + Math.PI) * amp;
      }
      tailPitch = Math.sin(ph) * 0.1 + (isRun ? 0.14 : 0.05);
      break;
    }
    case 'sleep': {
      const seed = pose.seed || 0;
      const sleepStyle = Math.floor(Math.abs(seed * 10)) % 2;
      const side = seed % 2 > 1 ? 1 : -1;
      const sleepBreath = Math.sin(t * 1.4 + seed) * 0.045;
      // Occasional tiny dream paw-twitch
      const dreamTwitch = Math.pow(Math.max(0, Math.sin(t * 0.75 + seed * 3.1)), 14) * 0.22;

      if (sleepStyle === 0) {
        // Style 0: Tightly curled side-donut resting flush on the ground/planks (head curled horizontally, never pointed skyward)
        rootY = 0.058 + sleepBreath * 0.03;
        hipsRx = 0;
        hipsRy = 0;
        hipsRz = 1.54 * side;
        spineRx = 0.44;
        spineRy = 0;
        chestRx = 0.48 + sleepBreath * 0.25;
        chestRy = 0;
        neckRx = 0.56;
        neckRy = 0;
        headRx = 0.48;
        headRy = 0;
        flRx = -0.68;
        frRx = -0.42;
        blRx = -0.82;
        brRx = -0.58;
        tailPitch = -1.55;
        tailYaw = 0;
      } else {
        // Style 1: Relaxed crescent side-snooze resting flat on the ground/planks
        rootY = 0.058 + sleepBreath * 0.03;
        hipsRx = 0;
        hipsRy = 0;
        hipsRz = 1.54 * side;
        spineRx = 0.18;
        spineRy = 0;
        chestRx = 0.2 + sleepBreath * 0.2;
        chestRy = 0;
        neckRx = 0.28;
        neckRy = 0;
        headRx = 0.26;
        headRy = 0;
        flRx = -0.62 + dreamTwitch;
        frRx = -0.38 - dreamTwitch * 0.5;
        blRx = -0.55;
        brRx = -0.3 + dreamTwitch * 0.4;
        tailPitch = -0.65;
        tailYaw = 0;
      }
      break;
    }
    case 'worship': {
      // Rhythmic reverent bowing down & rising to gaze up at the monolith (head stays cleanly above grass)
      const bow = Math.pow(Math.sin(t * 1.35) * 0.5 + 0.5, 1.5);
      rootY = THREE.MathUtils.lerp(0.058, 0.046, bow);
      hipsRx = THREE.MathUtils.lerp(-0.26, 0.04, bow);
      spineRx = THREE.MathUtils.lerp(-0.22, 0.22, bow);
      chestRx = THREE.MathUtils.lerp(-0.16, 0.28, bow);
      neckRx = THREE.MathUtils.lerp(0.12, 0.34, bow);
      headRx = THREE.MathUtils.lerp(-0.32, 0.16, bow);
      flRx = THREE.MathUtils.lerp(-0.55, -1.12, bow);
      frRx = THREE.MathUtils.lerp(-0.55, -1.12, bow);
      blRx = -0.9;
      brRx = -0.9;
      tailPitch = THREE.MathUtils.lerp(0.24, -0.06, bow);
      tailYaw = Math.sin(t * 1.1) * 0.08;
      break;
    }
    case 'confused': {
      // Sitting curiously upright, gazing up and tilting head side-to-side in confusion
      const seed = pose.seed || 0;
      const tilt = Math.sin(t * 2.1 + seed) * 0.34;
      rootY = 0.048;
      hipsRx = -0.28;
      spineRx = -0.28;
      chestRx = -0.16 + breath;
      neckRx = 0.24;
      headRx += -0.24 + Math.sin(t * 1.4 + seed) * 0.06;
      headRy = Math.sin(t * 1.05 + seed) * 0.16;
      b[5].rotation.z = THREE.MathUtils.lerp(b[5].rotation.z, tilt, lerpFactor);
      blRx = -0.82;
      brRx = -0.82;
      // Occasional puzzled paw raise toward chin/ear
      const scratch = Math.pow(Math.max(0, Math.sin(t * 0.85 + seed * 2.1)), 6);
      flRx = THREE.MathUtils.lerp(0.28, -0.78 + Math.sin(t * 8) * 0.08, scratch);
      frRx = 0.32;
      tailPitch = 0.26 + Math.sin(t * 1.6) * 0.04;
      tailYaw = Math.sin(t * 1.3 + seed) * 0.12;
      break;
    }
    case 'hang': {
      // Hanging from balloon strings: front paws reaching clearly forward/up to grip strings, back legs dangling
      rootY = 0.105;
      hipsRx = 0.18;
      spineRx = 0.12;
      chestRx = 0.08;
      neckRx = -0.22;
      headRx = -0.16 + Math.sin(t * 1.1) * 0.08;
      headRy = Math.sin(t * 0.65) * 0.32;
      flRx = -1.18;
      frRx = -1.18;
      blRx = 0.32 + Math.sin(t * 2.1) * 0.22;
      brRx = 0.32 + Math.sin(t * 2.1 + Math.PI) * 0.22;
      tailPitch = 0.38 + Math.sin(t * 1.4) * 0.14;
      tailYaw = Math.sin(t * 1.1) * 0.28;
      break;
    }
    case 'sit':
    case 'tea_wait':
    case 'tea_pour':
    case 'tea_sip':
    case 'tea_offer':
    case 'astro_look':
    case 'astro_write':
    case 'astro_ponder':
    case 'rose_water': {
      rootY = 0.048;
      hipsRx = -0.3;
      spineRx = -0.32;
      chestRx = -0.22 + breath;
      neckRx = 0.46;
      headRx += 0.25;
      blRx = -0.82;
      brRx = -0.82;
      flRx = 0.35;
      frRx = 0.35;
      tailPitch = 0.28 + Math.sin(t * 1.5) * 0.03;

      if (pose.state === 'tea_pour') {
        const focus = Math.sin(t * 7.5) * 0.06;
        chestRx = -0.14;
        neckRx = 0.32;
        headRx += -0.06;
        flRx = -1.16 + focus;
        frRx = -1.12 - focus;
        flRz = 0.18;
        frRz = -0.18;
      } else if (pose.state === 'tea_sip') {
        const focus = Math.sin(t * 8.0) * 0.06;
        chestRx = -0.16;
        neckRx = 0.26;
        headRx += -0.16 + Math.sin(t * 4.2) * 0.05;
        flRx = -1.28 + focus;
        frRx = -1.24 - focus;
        flRz = 0.22;
        frRz = -0.22;
      } else if (pose.state === 'tea_offer') {
        const focus = Math.sin(t * 7.0) * 0.05;
        chestRx = -0.14;
        flRx = -1.2 + focus;
        frRx = -1.14 - focus;
        flRz = 0.16;
        frRz = -0.16;
        headRx += -0.12;
      } else if (pose.state === 'astro_look') {
        spineRx = -0.16;
        chestRx = -0.1;
        neckRx = 0.22;
        headRx += -0.1;
        flRx = -0.55;
        frRx = -0.55;
      } else if (pose.state === 'astro_write') {
        spineRx = -0.18;
        chestRx = 0.05;
        neckRx = 0.48;
        headRx += 0.32;
        flRx = -0.68 + Math.sin(t * 7.5) * 0.1;
        frRx = -0.25;
      } else if (pose.state === 'astro_ponder') {
        headRx += -0.16;
        b[5].rotation.z = THREE.MathUtils.lerp(b[5].rotation.z, Math.sin(t * 1.2) * 0.28, lerpFactor);
      } else if (pose.state === 'rose_water') {
        chestRx = -0.05;
        flRx = -0.72;
        neckRx = 0.45;
        headRx += 0.18;
      }
      break;
    }
    case 'sniff': {
      rootY = 0.098;
      chestRx = 0.26;
      neckRx = 0.38 + Math.sin(t * 8.0) * 0.07;
      headRx += 0.22;
      flRx = -0.15;
      frRx = 0.12;
      tailPitch = -0.18;
      break;
    }
    case 'hop': {
      const hopArc = Math.abs(Math.sin(t * 5.2));
      rootY = 0.105 + hopArc * 0.085;
      hipsRx = -0.15 + hopArc * 0.3;
      flRx = -0.45 * hopArc;
      frRx = -0.45 * hopArc;
      blRx = 0.45 * hopArc;
      brRx = 0.45 * hopArc;
      break;
    }
    case 'tail_chase': {
      rootY = 0.095;
      const dir = pose.chaseDir || 1;
      hipsRy = 0.42 * dir;
      spineRy = 0.48 * dir;
      chestRy = 0.48 * dir;
      neckRy = 0.52 * dir;
      headRy = 0.44 * dir;
      tailYaw = 0.44 * dir;
      const p = t * 9.5;
      flRx = Math.sin(p) * 0.4;
      frRx = Math.cos(p) * 0.4;
      blRx = -Math.sin(p) * 0.4;
      brRx = -Math.cos(p) * 0.4;
      break;
    }
    case 'windup': {
      // Rearing up high before bringing the bone/stone tool down
      rootY = 0.11;
      hipsRx = -0.34;
      spineRx = -0.26;
      chestRx = -0.24;
      neckRx = 0.16;
      headRx += -0.14;
      flRx = -1.24;
      frRx = -1.16;
      blRx = -0.78;
      brRx = -0.78;
      tailPitch = 0.25;
      break;
    }
    case 'strike': {
      // Lunging downward to land the bone-club hit cleanly without head-to-head clipping
      rootY = 0.088;
      hipsRx = 0.1;
      spineRx = 0.2;
      chestRx = 0.26;
      neckRx = 0.18;
      headRx += 0.14;
      flRx = 0.65;
      frRx = 0.55;
      blRx = -0.42;
      brRx = -0.42;
      tailPitch = 0.12;
      break;
    }
    case 'bonk': {
      // Rearing up and swinging a prehistoric bone/stone club downward
      const swing = Math.sin(t * 9.2);
      rootY = 0.095 + Math.max(0, swing) * 0.025;
      hipsRx = -0.32;
      spineRx = -0.22 + swing * 0.16;
      chestRx = -0.14 + swing * 0.34;
      neckRx = 0.24 - swing * 0.12;
      headRx += 0.1 + swing * 0.12;
      flRx = -0.95 + swing * 0.72;
      frRx = -0.88 + swing * 0.68;
      blRx = -0.78;
      brRx = -0.78;
      tailPitch = 0.22;
      break;
    }
    case 'play_dead': {
      // Flipped flat onto its back with paws stiffly in the air!
      const twitch = Math.pow(Math.max(0, Math.sin(t * 3.4)), 10) * 0.18;
      rootY = 0.092;
      hipsRx = -0.16;
      hipsRy = 0.08;
      hipsRz = Math.PI;
      spineRx = 0.06;
      chestRx = 0.06;
      neckRx = -0.22;
      headRx = -0.18;
      headRy = 0.32;
      flRx = 0.24 + twitch;
      frRx = -0.22 - twitch;
      blRx = 0.18;
      brRx = -0.2;
      tailPitch = -0.25;
      tailYaw = 0.35;
      break;
    }
    case 'paint': {
      // Standing/sitting proudly by easel, front paw sweeping a brush cleanly across canvas
      const sweep = Math.sin(t * 3.8);
      rootY = 0.052;
      hipsRx = -0.32;
      spineRx = -0.3;
      chestRx = -0.18 + breath;
      neckRx = 0.28;
      headRx += -0.06 + Math.sin(t * 1.9) * 0.05;
      headRy = Math.sin(t * 1.4) * 0.12;
      flRx = -0.95 + sweep * 0.26;
      frRx = 0.28;
      blRx = -0.82;
      brRx = -0.82;
      tailPitch = 0.28;
      tailYaw = Math.sin(t * 2.2) * 0.16;
      break;
    }
    case 'tinker': {
      // Crouched playfully beside workbench alternating paws to rearrange modular blocks
      const work = Math.sin(t * 4.4);
      rootY = 0.072;
      hipsRx = -0.22;
      spineRx = -0.16;
      chestRx = 0.05 + breath;
      neckRx = 0.36;
      headRx += 0.18;
      flRx = -0.78 + work * 0.24;
      frRx = -0.72 - work * 0.24;
      blRx = -0.76;
      brRx = -0.76;
      tailPitch = 0.22;
      tailYaw = Math.sin(t * 2.4) * 0.18;
      break;
    }
    case 'read': {
      // Cozy upright garden reader holding a book softly with gentle page-turn head nods
      rootY = 0.050;
      hipsRx = -0.3;
      spineRx = -0.3;
      chestRx = -0.18 + breath;
      neckRx = 0.42;
      headRx += 0.22 + Math.sin(t * 1.5) * 0.05;
      flRx = -0.66;
      frRx = -0.66;
      blRx = -0.84;
      brRx = -0.84;
      tailPitch = 0.26;
      tailYaw = Math.sin(t * 1.1) * 0.08;
      break;
    }
    case 'help_reach_down': {
      // Upper helper mink braced on ledge leaning forward, reaching front paw downward to pull friend up
      const pull = Math.sin(t * 2.2) * 0.12;
      rootY = 0.088;
      hipsRx = -0.08;
      spineRx = 0.18;
      chestRx = 0.24;
      neckRx = 0.14;
      headRx += 0.28;
      flRx = -0.96 + pull;
      frRx = 0.18;
      blRx = -0.32;
      brRx = -0.32;
      tailPitch = 0.3;
      tailYaw = Math.sin(t * 1.8) * 0.14;
      break;
    }
    case 'help_ledge_down': {
      // Upper helper mink perched stably atop the tall slate cliff, leaning gently to extend a front paw downward
      const pull = Math.sin(t * 2.2) * 0.11;
      rootY = 0.095;
      hipsRx = -0.04;
      spineRx = 0.1;
      chestRx = 0.14;
      neckRx = 0.12;
      headRx += 0.24;
      flRx = -1.25 + pull;
      frRx = 0.16;
      blRx = -0.26;
      brRx = -0.26;
      tailPitch = 0.26;
      tailYaw = Math.sin(t * 1.8) * 0.12;
      break;
    }
    case 'help_reach_up': {
      // Lower climber mink braced on lower stone terrace, tilted gently upward and reaching a front paw toward helper
      const reach = Math.sin(t * 2.2) * 0.1;
      rootY = 0.086;
      hipsRx = -0.1;
      spineRx = -0.1;
      chestRx = -0.12;
      neckRx = -0.08;
      headRx += -0.1;
      flRx = -1.42 - reach;
      frRx = -0.42;
      blRx = -0.4;
      brRx = -0.4;
      tailPitch = 0.22;
      tailYaw = Math.sin(t * 1.8 + 1.0) * 0.12;
      break;
    }
    default: {
      rootY = 0.103;
      neckRx = Math.sin(t * 1.1) * 0.05;
      break;
    }
  }

  if (pose.state !== 'astro_ponder') {
    b[5].rotation.z = THREE.MathUtils.lerp(b[5].rotation.z, pose.headRoll || 0, lerpFactor);
  }

  b[0].position.y = THREE.MathUtils.lerp(b[0].position.y, rootY, lerpFactor);
  setRot(1, hipsRx, hipsRy, hipsRz);
  setRot(2, spineRx, spineRy, 0);
  setRot(3, chestRx, chestRy, 0);
  setRot(4, neckRx, neckRy, 0);
  setRot(5, headRx, headRy, b[5].rotation.z);

  setRot(6, tailPitch * 0.4, tailYaw * 0.4, 0);
  setRot(7, tailPitch * 0.3, tailYaw * 0.5, 0);
  setRot(8, tailPitch * 0.2, tailYaw * 0.6, 0);
  setRot(9, tailPitch * 0.1, tailYaw * 0.6, 0);

  setRot(10, flRx, 0, flRz);
  setRot(11, frRx, 0, frRz);
  setRot(12, blRx, 0, 0);
  setRot(13, brRx, 0, 0);
}

function applyPaintedClayFinish(
  mat: THREE.MeshStandardMaterial,
  stepMix = 0.34,
  bands = 5.0
): THREE.MeshStandardMaterial {
  mat.roughness = Math.max(mat.roughness, 0.94);
  mat.metalness = 0.0;
  mat.customProgramCacheKey = () => `painted-clay-${stepMix.toFixed(2)}-${bands}`;
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      'vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;',
      `float clayDirectLum = dot(reflectedLight.directDiffuse, vec3(0.299, 0.587, 0.114));
      float clayStepped = floor(clayDirectLum * ${bands.toFixed(1)} + 0.5) / ${bands.toFixed(1)};
      float clayRatio = clayDirectLum > 0.0005 ? clamp(clayStepped / clayDirectLum, 0.65, 1.32) : 1.0;
      vec3 clayDirect = mix(reflectedLight.directDiffuse, reflectedLight.directDiffuse * clayRatio, ${stepMix.toFixed(2)});
      vec3 totalDiffuse = clayDirect + reflectedLight.indirectDiffuse;`
    );
  };
  return mat;
}

function buildPlanetMesh() {
  const geo = own(new THREE.IcosahedronGeometry(1, 5));
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);

  // Calm earthy Astrid diorama palette so vivid orange belongs first and foremost to the minks
  const cGrassLush = new THREE.Color('#556f49');
  const cGrassWarm = new THREE.Color('#657e53');
  const cGrassShade = new THREE.Color('#41593c');
  const cPath = new THREE.Color('#bf9462');
  const cSand = new THREE.Color('#c89f68');
  const cSandWarm = new THREE.Color('#a66846');
  const cRiverBed = new THREE.Color('#6c6453');
  const cStoneRise = new THREE.Color('#647280');
  const cAlpinePine = new THREE.Color('#3b514b');
  const cAlpineRock = new THREE.Color('#566170');
  const cAlpineSnow = new THREE.Color('#d7dce6');

  const v = new THREE.Vector3();
  const tmp = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const h = getTerrainHeight(v);
    pos.setXYZ(i, v.x * h, v.y * h, v.z * h);

    const n = fbmSphere(v.x * 1.4, v.y * 1.4, v.z * 1.4);
    const elev = THREE.MathUtils.clamp((h - WORLD_CONFIG.planetRadius) * 4.5, -1, 1);
    const grassBlend = THREE.MathUtils.clamp(n * 0.7 + elev * 0.65, -1, 1);
    tmp.copy(cGrassLush).lerp(grassBlend > 0 ? cGrassWarm : cGrassShade, Math.min(1, Math.abs(grassBlend) * 1.15));

    const pathF = getPathFactor(v);
    tmp.lerp(cPath, pathF * 0.88);

    const dAstro = v.angleTo(WORLD_CONFIG.landmarks.astro.dir);
    tmp.lerp(cStoneRise, (1 - smoothstep(0.08, 0.22, dAstro)) * 0.72);

    // Arid desert climate coloring (warm ochre & terracotta clay dune contours)
    const desertMask = getDesertMask(v);
    const duneShade =
      0.5 +
      0.32 * Math.sin(v.x * 11.0 + v.z * 8.5) +
      0.18 * Math.cos(v.y * 13.5 - v.x * 7.5);
    const sandCol = new THREE.Color().copy(cSand).lerp(cSandWarm, THREE.MathUtils.clamp(duneShade, 0, 1));
    tmp.lerp(sandCol, desertMask);

    // Cold alpine climate coloring: dusty pine foothills -> slate rock -> muted evening snowfield
    const alpineMask = getAlpineMask(v);
    if (alpineMask > 0.02) {
      tmp.lerp(cAlpinePine, smoothstep(0.04, 0.32, alpineMask) * 0.82);
      tmp.lerp(cAlpineRock, smoothstep(0.32, 0.58, alpineMask) * 0.74);
      tmp.lerp(cAlpineSnow, smoothstep(0.45, 0.76, alpineMask) * 0.9);
    }

    const riverF = getRiverFactor(v);
    if (h < WORLD_CONFIG.waterRadius + 0.015) {
      tmp.lerp(cRiverBed, smoothstep(WORLD_CONFIG.waterRadius + 0.015, WORLD_CONFIG.waterRadius - 0.05, h) * 0.95);
    } else if (riverF > 0.05) {
      tmp.lerp(cPath, riverF * 0.35);
    }

    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }

  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  // Cache rendered triangle geometry so every mink & prop rests flush on the faceted terrain faces
  const tris: RenderedTri[] = [];
  for (let i = 0; i < pos.count; i += 3) {
    const a = new THREE.Vector3().fromBufferAttribute(pos, i);
    const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);
    const c = new THREE.Vector3().fromBufferAttribute(pos, i + 2);
    const n = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
    if (n.dot(a) < 0) n.negate();
    const cDir = new THREE.Vector3().add(a).add(b).add(c).normalize();
    tris.push({ a, b, c, n, cDir });
  }
  renderedPlanetTris = tris;

  const mat = applyPaintedClayFinish(
    own(new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0,
    })),
    0.34,
    5.0
  );

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  return { mesh, material: mat };
}

function buildWaterMesh() {
  const geo = own(new THREE.IcosahedronGeometry(1, 6));
  const pos = geo.attributes.position;
  const depths = new Float32Array(pos.count);
  const dirs = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    const terrainH = getTerrainHeight(v);
    const depth = WORLD_CONFIG.waterRadius - terrainH;
    const wr = WORLD_CONFIG.waterRadius;
    pos.setXYZ(i, v.x * wr, v.y * wr, v.z * wr);
    depths[i] = depth;
    dirs[i * 3] = v.x;
    dirs[i * 3 + 1] = v.y;
    dirs[i * 3 + 2] = v.z;
  }

  geo.setAttribute('aDepth', new THREE.BufferAttribute(depths, 1));
  geo.setAttribute('aSphereDir', new THREE.BufferAttribute(dirs, 3));
  geo.computeVertexNormals();

  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.55, 0.72, 0.42).normalize() },
    uRipples: {
      value: [
        new THREE.Vector4(0, 1, 0, 99),
        new THREE.Vector4(0, 1, 0, 99),
        new THREE.Vector4(0, 1, 0, 99),
        new THREE.Vector4(0, 1, 0, 99),
      ],
    },
  };

  const mat = own(new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      attribute float aDepth;
      attribute vec3 aSphereDir;
      varying float vDepth;
      varying vec3 vDir;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;
      void main() {
        vDepth = aDepth;
        vDir = aSphereDir;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vWorldNormal = normalize(normalMatrix * normal);
        vViewDir = normalize(-mvPos.xyz);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform float uTime;
      uniform vec3 uSunDir;
      uniform vec4 uRipples[4];
      varying float vDepth;
      varying vec3 vDir;
      varying vec3 vWorldNormal;
      varying vec3 vViewDir;

      void main() {
        if (vDepth <= -0.002) discard;

        float wave1 = sin(vDir.x * 38.0 + uTime * 1.8) * cos(vDir.z * 34.0 - uTime * 1.4);
        float wave2 = sin(vDir.y * 44.0 - uTime * 1.3 + vDir.x * 14.0);
        float shimmer = (wave1 + wave2) * 0.5;

        float rippleRing = 0.0;
        for (int i = 0; i < 4; i++) {
          float age = uRipples[i].w;
          if (age < 2.2) {
            float ang = acos(clamp(dot(normalize(vDir), normalize(uRipples[i].xyz)), -1.0, 1.0));
            float radius = age * 0.14;
            float ring = exp(-pow((ang - radius) * 55.0, 2.0)) * (1.0 - age / 2.2);
            rippleRing += ring;
          }
        }

        // Matte painted-clay diorama water: dusty teal into slate blue, restrained highlights
        vec3 shallow = vec3(0.27, 0.44, 0.49);
        vec3 deep    = vec3(0.16, 0.28, 0.36);
        float depthMix = clamp(vDepth * 14.0, 0.0, 1.0);
        vec3 waterCol = mix(shallow, deep, depthMix);

        float fresnel = pow(1.0 - clamp(dot(vWorldNormal, vViewDir), 0.0, 1.0), 2.5);
        waterCol = mix(waterCol, vec3(0.46, 0.58, 0.67), fresnel * 0.09);
        waterCol += vec3(0.025, 0.035, 0.035) * smoothstep(0.35, 0.95, shimmer);

        float foam = smoothstep(0.022, 0.002, vDepth + shimmer * 0.004);
        waterCol = mix(waterCol, vec3(0.78, 0.84, 0.88), foam * 0.52 + clamp(rippleRing, 0.0, 1.0) * 0.65);

        float rawDiff = dot(vWorldNormal, normalize(uSunDir)) * 0.45 + 0.55;
        float steppedDiff = floor(rawDiff * 5.0 + 0.5) / 5.0;
        float diff = max(0.38, mix(rawDiff, steppedDiff, 0.35));
        gl_FragColor = vec4(waterCol * diff, clamp(vDepth * 38.0, 0.45, 0.92));
      }
    `,
  }));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return { mesh, uniforms };
}

function attachOnSurface(
  parent: THREE.Object3D,
  dir: THREE.Vector3,
  extraHeight = 0,
  yaw = 0,
  useWalkable = false
): THREE.Group {
  const info = useWalkable
    ? getWalkableSurface(dir)
    : {
        position: dir.clone().multiplyScalar(getTerrainHeight(dir)),
        normal: getTerrainNormal(dir),
      };
  const holder = new THREE.Group();
  holder.position.copy(info.position).addScaledVector(info.normal, extraHeight);

  const up = info.normal.clone();
  const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const right = new THREE.Vector3().crossVectors(up, ref).normalize();
  const fwd = new THREE.Vector3().crossVectors(right, up).normalize();
  const basis = new THREE.Matrix4().makeBasis(right, up, fwd);
  holder.quaternion.setFromRotationMatrix(basis);
  holder.rotateY(yaw);
  parent.add(holder);
  return holder;
}

type WorldMats = Record<string, THREE.MeshStandardMaterial>;

function createRoundedTree(scale = 1, mats: WorldMats): THREE.Group {
  const g = new THREE.Group();
  const trunk = new THREE.Mesh(own(new THREE.CylinderGeometry(0.045, 0.07, 0.28, 8)), mats.wood);
  trunk.position.y = 0.14;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  g.add(trunk);

  const puffs: [number, number, number, number, THREE.MeshStandardMaterial][] = [
    [0, 0.34, 0, 0.19, mats.leafA],
    [0.1, 0.29, 0.06, 0.13, mats.leafB],
    [-0.09, 0.3, -0.05, 0.14, mats.leafB],
    [0.02, 0.44, -0.02, 0.12, mats.leafA],
  ];
  for (const [x, y, z, r, m] of puffs) {
    const c = new THREE.Mesh(own(new THREE.IcosahedronGeometry(r, 2)), m);
    c.position.set(x, y, z);
    c.castShadow = true;
    c.receiveShadow = true;
    g.add(c);
  }
  g.scale.setScalar(scale);
  return g;
}

function createSculptedRock(scale = 1, mat: THREE.Material): THREE.Mesh {
  const geo = own(new THREE.DodecahedronGeometry(0.11 * scale, 1));
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const squash = y < 0 ? 0.65 : 0.92;
    pos.setXYZ(i, x * 1.15, y * squash, z * 0.95);
  }
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

function createWoodenBridge(mats: WorldMats): THREE.Group {
  const g = new THREE.Group();
  const span = 0.8;
  const planks = 13;
  const archH = 0.062;
  for (let i = 0; i < planks; i++) {
    const t = i / (planks - 1) - 0.5;
    const z = t * span;
    // Compensate slightly for planet curvature at the ends so planks rest cleanly on the banks
    const sphereComp = (z * z) / (2 * WORLD_CONFIG.planetRadius);
    const y = Math.cos(t * Math.PI) * archH + sphereComp;
    const plank = new THREE.Mesh(own(new THREE.BoxGeometry(0.24, 0.026, 0.056)), mats.woodLight);
    plank.position.set(0, y, z);
    plank.rotation.x = -Math.sin(t * Math.PI) * 0.22;
    plank.castShadow = true;
    plank.receiveShadow = true;
    g.add(plank);
  }
  // Deep stone abutments at both ends so the bridge seats solidly into both riverbanks with zero gap
  for (const ez of [-span * 0.5, span * 0.5]) {
    const abut = new THREE.Mesh(own(new THREE.BoxGeometry(0.28, 0.12, 0.095)), mats.stone);
    abut.position.set(0, -0.042, ez);
    abut.castShadow = true;
    abut.receiveShadow = true;
    g.add(abut);
  }
  for (const side of [-0.11, 0.11]) {
    const endZ = span * 0.47;
    const endComp = (endZ * endZ) / (2 * WORLD_CONFIG.planetRadius);
    for (const [pz, baseY] of [
      [-endZ, endComp],
      [0, archH],
      [endZ, endComp],
    ]) {
      const post = new THREE.Mesh(own(new THREE.CylinderGeometry(0.014, 0.016, 0.11, 6)), mats.wood);
      post.position.set(side, baseY + 0.055, pz);
      post.castShadow = true;
      g.add(post);
    }
    // Two-segment arched handrail following the bridge deck
    const halfLen = endZ;
    const rise = archH - endComp;
    const segLen = Math.hypot(halfLen, rise);
    const segAngle = Math.atan2(rise, halfLen);
    for (const dirSign of [-1, 1]) {
      const rail = new THREE.Mesh(own(new THREE.BoxGeometry(0.018, 0.018, segLen + 0.02)), mats.wood);
      rail.position.set(side, (archH + endComp) * 0.5 + 0.095, dirSign * halfLen * 0.5);
      rail.rotation.x = dirSign * segAngle;
      rail.castShadow = true;
      g.add(rail);
    }
  }
  return g;
}

function createCeramicCup(mats: WorldMats, withSpout = false): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(own(new THREE.CylinderGeometry(0.024, 0.018, 0.034, 10)), mats.ceramic);
  body.position.y = 0.017;
  body.castShadow = true;
  g.add(body);

  const rim = new THREE.Mesh(own(new THREE.TorusGeometry(0.024, 0.0035, 6, 12)), mats.ceramicTrim);
  rim.rotation.x = Math.PI * 0.5;
  rim.position.y = 0.034;
  g.add(rim);

  if (withSpout) {
    const spout = new THREE.Mesh(own(new THREE.CylinderGeometry(0.004, 0.008, 0.035, 6)), mats.ceramic);
    spout.position.set(0, 0.025, 0.024);
    spout.rotation.x = 0.7;
    g.add(spout);
  }
  return g;
}

function createTeapot(mats: WorldMats): THREE.Group {
  const g = new THREE.Group();
  const body = new THREE.Mesh(own(new THREE.SphereGeometry(0.042, 12, 10)), mats.ceramic);
  body.scale.set(1, 0.82, 1);
  body.position.y = 0.034;
  body.castShadow = true;
  g.add(body);

  const lid = new THREE.Mesh(own(new THREE.SphereGeometry(0.016, 8, 6)), mats.ceramicTrim);
  lid.position.y = 0.068;
  g.add(lid);

  const spout = new THREE.Mesh(own(new THREE.CylinderGeometry(0.006, 0.011, 0.044, 6)), mats.ceramic);
  spout.position.set(0, 0.042, 0.044);
  spout.rotation.x = 0.65;
  g.add(spout);

  const handle = new THREE.Mesh(own(new THREE.TorusGeometry(0.022, 0.005, 6, 10, Math.PI)), mats.ceramicTrim);
  handle.rotation.y = Math.PI * 0.5;
  handle.rotation.z = -Math.PI * 0.5;
  handle.position.set(0, 0.036, -0.038);
  g.add(handle);
  return g;
}

function createDesertRose(mats: WorldMats) {
  const root = new THREE.Group();
  const stem = new THREE.Mesh(own(new THREE.CylinderGeometry(0.009, 0.012, 0.19, 7)), mats.leafB);
  stem.position.y = 0.095;
  stem.castShadow = true;
  root.add(stem);

  for (const [ang, y] of [[0.6, 0.07], [-0.7, 0.11]]) {
    const leaf = new THREE.Mesh(own(new THREE.SphereGeometry(0.028, 7, 5)), mats.leafA);
    leaf.scale.set(1.3, 0.28, 0.65);
    leaf.position.set(Math.sin(ang) * 0.028, y, 0);
    leaf.rotation.z = ang * 0.7;
    root.add(leaf);
  }

  const flowerHead = new THREE.Group();
  flowerHead.position.y = 0.195;
  const core = new THREE.Mesh(own(new THREE.SphereGeometry(0.028, 10, 8)), mats.roseDark);
  flowerHead.add(core);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const petal = new THREE.Mesh(own(new THREE.SphereGeometry(0.026, 8, 6)), mats.rose);
    petal.scale.set(1.0, 1.15, 0.42);
    petal.position.set(Math.cos(a) * 0.024, 0.006, Math.sin(a) * 0.024);
    petal.rotation.y = -a + Math.PI * 0.5;
    petal.rotation.x = 0.35;
    flowerHead.add(petal);
  }
  root.add(flowerHead);

  // Little Prince glass bell-jar / cloche enclosure
  const baseRing = new THREE.Mesh(
    own(new THREE.CylinderGeometry(0.088, 0.096, 0.016, 18)),
    mats.wood
  );
  baseRing.position.y = 0.008;
  baseRing.castShadow = true;
  baseRing.receiveShadow = true;
  root.add(baseRing);

  const glassMat = own(new THREE.MeshPhysicalMaterial({
    color: '#eef9ff',
    transparent: true,
    opacity: 0.28,
    roughness: 0.08,
    metalness: 0.05,
    clearcoat: 1.0,
    clearcoatRoughness: 0.06,
    depthWrite: false,
    side: THREE.DoubleSide,
  }));

  const bellJarGroup = new THREE.Group();
  bellJarGroup.position.set(0, 0.012, 0);

  const glassWalls = new THREE.Mesh(
    own(new THREE.CylinderGeometry(0.082, 0.084, 0.21, 18, 1, true)),
    glassMat
  );
  glassWalls.position.y = 0.108;
  glassWalls.renderOrder = 2;
  bellJarGroup.add(glassWalls);

  const glassDome = new THREE.Mesh(
    own(new THREE.SphereGeometry(0.082, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5)),
    glassMat
  );
  glassDome.position.y = 0.213;
  glassDome.renderOrder = 2;
  bellJarGroup.add(glassDome);

  const glassKnob = new THREE.Mesh(
    own(new THREE.SphereGeometry(0.014, 10, 8)),
    glassMat
  );
  glassKnob.position.y = 0.303;
  glassKnob.renderOrder = 2;
  bellJarGroup.add(glassKnob);

  root.add(bellJarGroup);

  return { root, flowerHead, bellJarGroup };
}

function createMysteryBox(mats: WorldMats): THREE.Group {
  const g = new THREE.Group();
  const box = new THREE.Mesh(own(new THREE.BoxGeometry(0.22, 0.22, 0.22)), mats.boxGold);
  box.castShadow = true;
  box.receiveShadow = true;
  g.add(box);

  const rim = new THREE.Mesh(own(new THREE.BoxGeometry(0.232, 0.028, 0.232)), mats.boxRim);
  rim.position.y = 0.095;
  g.add(rim);
  const rimBot = rim.clone();
  rimBot.position.y = -0.095;
  g.add(rimBot);

  const c = document.createElement('canvas');
  c.width = 32;
  c.height = 32;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#e29a24';
  ctx.fillRect(0, 0, 32, 32);
  ctx.fillStyle = '#fff5db';
  const q = [
    [11, 6, 10, 3],
    [9, 8, 4, 4],
    [19, 8, 4, 6],
    [14, 13, 6, 4],
    [14, 17, 4, 3],
    [14, 23, 4, 4],
  ];
  for (const [x, y, w, h] of q) ctx.fillRect(x, y, w, h);
  const qTex = own(new THREE.CanvasTexture(c));
  qTex.colorSpace = THREE.SRGBColorSpace;
  qTex.magFilter = THREE.NearestFilter;

  const faceMat = own(new THREE.MeshStandardMaterial({ map: qTex, roughness: 0.55 }));
  const plaqueGeo = own(new THREE.PlaneGeometry(0.16, 0.16));
  for (let i = 0; i < 4; i++) {
    const p = new THREE.Mesh(plaqueGeo, faceMat);
    const a = i * Math.PI * 0.5;
    p.position.set(Math.sin(a) * 0.111, 0, Math.cos(a) * 0.111);
    p.rotation.y = a;
    g.add(p);
  }
  return g;
}

function createTelescopeAndDesk(mats: WorldMats) {
  const g = new THREE.Group();

  const tripod = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = new THREE.Mesh(own(new THREE.CylinderGeometry(0.008, 0.007, 0.18, 6)), mats.wood);
    leg.position.set(Math.cos(a) * 0.045, 0.075, Math.sin(a) * 0.045);
    leg.rotation.z = Math.cos(a) * 0.45;
    leg.rotation.x = -Math.sin(a) * 0.45;
    leg.castShadow = true;
    tripod.add(leg);
  }
  const barrelPivot = new THREE.Group();
  barrelPivot.position.set(0, 0.155, 0);
  barrelPivot.rotation.x = -0.52;
  const barrel = new THREE.Mesh(own(new THREE.CylinderGeometry(0.028, 0.018, 0.24, 10)), mats.brass);
  barrel.rotation.x = Math.PI * 0.5;
  barrel.castShadow = true;
  barrelPivot.add(barrel);

  const knob = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.011, 0.018, 8)), mats.wood);
  knob.rotation.z = Math.PI * 0.5;
  knob.position.set(0.025, -0.01, -0.04);
  barrelPivot.add(knob);

  tripod.add(barrelPivot);
  g.add(tripod);

  const desk = new THREE.Group();
  desk.position.set(0.22, 0, 0.05);
  desk.rotation.y = -0.55;
  const slab = new THREE.Mesh(own(new THREE.BoxGeometry(0.16, 0.085, 0.13)), mats.stone);
  slab.position.y = 0.042;
  slab.rotation.x = 0.25;
  slab.castShadow = true;
  slab.receiveShadow = true;
  desk.add(slab);

  const notebookGroup = new THREE.Group();
  notebookGroup.position.set(0, 0.092, 0.006);
  notebookGroup.rotation.x = 0.25;

  const pageL = new THREE.Mesh(own(new THREE.BoxGeometry(0.056, 0.008, 0.078)), mats.ceramic);
  pageL.position.x = -0.029;
  pageL.rotation.z = 0.06;
  const pageR = pageL.clone();
  pageR.position.x = 0.029;
  pageR.rotation.z = -0.06;
  notebookGroup.add(pageL, pageR);

  desk.add(notebookGroup);
  g.add(desk);

  return { group: g, barrelPivot, notebookGroup };
}

function createWindmill(mats: WorldMats) {
  const g = new THREE.Group();

  // Stone foundation plinth
  const base = new THREE.Mesh(own(new THREE.CylinderGeometry(0.19, 0.22, 0.08, 12)), mats.stone);
  base.position.y = 0.04;
  base.castShadow = true;
  base.receiveShadow = true;
  g.add(base);

  // Tall tapered cream-plaster tower
  const tower = new THREE.Mesh(own(new THREE.CylinderGeometry(0.115, 0.175, 0.52, 12)), mats.ceramic);
  tower.position.y = 0.34;
  tower.castShadow = true;
  tower.receiveShadow = true;
  g.add(tower);

  // Decorative wooden timber bands
  for (const [ry, rad] of [[0.22, 0.162], [0.44, 0.132]]) {
    const band = new THREE.Mesh(own(new THREE.TorusGeometry(rad, 0.01, 6, 16)), mats.wood);
    band.rotation.x = Math.PI * 0.5;
    band.position.y = ry;
    g.add(band);
  }

  // Conical wooden-shingled roof cap
  const roof = new THREE.Mesh(own(new THREE.ConeGeometry(0.145, 0.19, 12)), mats.wood);
  roof.position.y = 0.69;
  roof.castShadow = true;
  g.add(roof);

  // Arched wooden doorway at ground level
  const door = new THREE.Mesh(own(new THREE.BoxGeometry(0.068, 0.115, 0.025)), mats.wood);
  door.position.set(0, 0.11, 0.17);
  door.castShadow = true;
  g.add(door);

  // Warm-lit upper window (soft dusk candle glow)
  const winGlow = new THREE.Mesh(
    own(new THREE.CircleGeometry(0.026, 10)),
    own(new THREE.MeshStandardMaterial({ color: '#f4d18c', emissive: '#e69b45', emissiveIntensity: 0.45, roughness: 0.65 }))
  );
  winGlow.position.set(0, 0.36, 0.146);
  g.add(winGlow);

  // Rotating 4-blade windmill sail assembly
  const rotor = new THREE.Group();
  rotor.position.set(0, 0.56, 0.135);

  const hub = new THREE.Mesh(own(new THREE.CylinderGeometry(0.024, 0.024, 0.05, 10)), mats.wood);
  hub.rotation.x = Math.PI * 0.5;
  hub.castShadow = true;
  rotor.add(hub);

  const sailMat = own(new THREE.MeshStandardMaterial({ color: '#fbf3e0', roughness: 0.75, side: THREE.DoubleSide }));
  for (let i = 0; i < 4; i++) {
    const armGroup = new THREE.Group();
    armGroup.rotation.z = (i * Math.PI) / 2;

    const spar = new THREE.Mesh(own(new THREE.BoxGeometry(0.014, 0.42, 0.014)), mats.wood);
    spar.position.y = 0.21;
    spar.castShadow = true;
    armGroup.add(spar);

    const sail = new THREE.Mesh(own(new THREE.BoxGeometry(0.088, 0.31, 0.006)), sailMat);
    sail.position.set(0.048, 0.245, 0.004);
    sail.rotation.y = 0.14;
    sail.castShadow = true;
    armGroup.add(sail);

    rotor.add(armGroup);
  }
  g.add(rotor);

  return { group: g, rotor };
}

function createSignpost(mats: WorldMats): THREE.Group {
  const g = new THREE.Group();
  const post = new THREE.Mesh(own(new THREE.CylinderGeometry(0.012, 0.015, 0.22, 6)), mats.wood);
  post.position.y = 0.11;
  post.castShadow = true;
  g.add(post);

  const signA = new THREE.Mesh(own(new THREE.BoxGeometry(0.11, 0.028, 0.012)), mats.woodLight);
  signA.position.set(0.035, 0.19, 0);
  signA.rotation.y = 0.25;
  signA.castShadow = true;
  g.add(signA);

  const signB = new THREE.Mesh(own(new THREE.BoxGeometry(0.095, 0.026, 0.012)), mats.woodLight);
  signB.position.set(-0.03, 0.148, 0.004);
  signB.rotation.y = -0.45;
  signB.castShadow = true;
  g.add(signB);

  return g;
}

function createCampfire(mats: WorldMats) {
  const g = new THREE.Group();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const stone = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.022, 0)), mats.stone);
    stone.position.set(Math.cos(a) * 0.065, 0.014, Math.sin(a) * 0.065);
    stone.scale.y = 0.7;
    g.add(stone);
  }
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(own(new THREE.CylinderGeometry(0.01, 0.012, 0.09, 6)), mats.wood);
    log.position.y = 0.02;
    log.rotation.z = Math.PI * 0.42;
    log.rotation.y = (i / 3) * Math.PI;
    g.add(log);
  }
  // Glowing ember bed at the base
  const embersBed = new THREE.Mesh(
    own(new THREE.CylinderGeometry(0.042, 0.048, 0.014, 8)),
    own(new THREE.MeshStandardMaterial({ color: '#9c2d12', emissive: '#d64718', emissiveIntensity: 0.72, roughness: 0.85 }))
  );
  embersBed.position.y = 0.012;
  g.add(embersBed);

  // Multi-layered organic fire tongues (storybook warm amber, no harsh neon glare)
  const flame = new THREE.Group();
  flame.position.y = 0.018;
  const outerFlame = new THREE.Mesh(
    own(new THREE.ConeGeometry(0.036, 0.095, 7)),
    own(new THREE.MeshStandardMaterial({ color: '#f26d13', emissive: '#d64508', emissiveIntensity: 0.78, transparent: true, opacity: 0.88, roughness: 0.6 }))
  );
  outerFlame.position.y = 0.046;
  flame.add(outerFlame);

  const midFlame = new THREE.Mesh(
    own(new THREE.ConeGeometry(0.025, 0.078, 6)),
    own(new THREE.MeshStandardMaterial({ color: '#f59e3d', emissive: '#e66c1a', emissiveIntensity: 0.88, transparent: true, opacity: 0.92, roughness: 0.55 }))
  );
  midFlame.position.set(0.005, 0.04, -0.004);
  midFlame.rotation.z = -0.08;
  flame.add(midFlame);

  const coreFlame = new THREE.Mesh(
    own(new THREE.ConeGeometry(0.014, 0.048, 6)),
    own(new THREE.MeshStandardMaterial({ color: '#f7e0a3', emissive: '#e8b04d', emissiveIntensity: 0.95, roughness: 0.45 }))
  );
  coreFlame.position.y = 0.026;
  flame.add(coreFlame);
  g.add(flame);

  // Soft rising smoke puffs above the campfire
  const smokeMat = own(new THREE.MeshStandardMaterial({
    color: '#c2bbb0',
    transparent: true,
    opacity: 0.42,
    roughness: 1.0,
  }));
  const smokePuffs: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    const puff = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.022, 1)), own(smokeMat.clone()));
    puff.position.set(0, 0.12 + i * 0.06, 0);
    g.add(puff);
    smokePuffs.push(puff);
  }

  // Cozy sitting log beside the fire
  const seatLog = new THREE.Mesh(own(new THREE.CylinderGeometry(0.024, 0.026, 0.14, 8)), mats.woodLight);
  seatLog.rotation.z = Math.PI * 0.5;
  seatLog.position.set(0, 0.024, 0.13);
  seatLog.castShadow = true;
  g.add(seatLog);

  const light = new THREE.PointLight('#ff8c38', 0, 1.45, 1.8);
  light.position.set(0, 0.15, 0);
  g.add(light);

  return { group: g, flame, light, smokePuffs };
}

function createOilDerrick(mats: WorldMats) {
  const g = new THREE.Group();
  const darkTimber = own(new THREE.MeshStandardMaterial({ color: '#4a3322', roughness: 0.92 }));
  const oilMat = own(new THREE.MeshStandardMaterial({ color: '#181412', roughness: 0.25, metalness: 0.35 }));

  // Deep wooden wellhead platform & dark oil pit (sinks cleanly into curved desert sand)
  const platform = new THREE.Mesh(own(new THREE.BoxGeometry(0.28, 0.075, 0.28)), darkTimber);
  platform.position.y = -0.012;
  platform.castShadow = true;
  platform.receiveShadow = true;
  g.add(platform);

  const oilPool = new THREE.Mesh(own(new THREE.CircleGeometry(0.068, 12)), oilMat);
  oilPool.rotation.x = -Math.PI * 0.5;
  oilPool.position.y = 0.026;
  g.add(oilPool);

  // 4 tapered wooden derrick tower legs
  const legHeight = 0.56;
  const corners: [number, number][] = [
    [-0.1, -0.1],
    [0.1, -0.1],
    [-0.1, 0.1],
    [0.1, 0.1],
  ];
  for (const [cx, cz] of corners) {
    const leg = new THREE.Mesh(own(new THREE.BoxGeometry(0.018, legHeight, 0.018)), darkTimber);
    leg.position.set(cx * 0.68, legHeight * 0.5, cz * 0.68);
    leg.rotation.z = cx > 0 ? 0.11 : -0.11;
    leg.rotation.x = cz > 0 ? -0.11 : 0.11;
    leg.castShadow = true;
    g.add(leg);
  }

  // Horizontal timber cross-braces up the tower
  for (const [by, bw] of [[0.14, 0.17], [0.29, 0.135], [0.44, 0.1], [0.55, 0.08]]) {
    const b1 = new THREE.Mesh(own(new THREE.BoxGeometry(bw, 0.014, 0.014)), darkTimber);
    b1.position.set(0, by, bw * 0.48);
    b1.castShadow = true;
    const b2 = b1.clone();
    b2.position.z = -bw * 0.48;
    const b3 = new THREE.Mesh(own(new THREE.BoxGeometry(0.014, 0.014, bw)), darkTimber);
    b3.position.set(bw * 0.48, by, 0);
    b3.castShadow = true;
    const b4 = b3.clone();
    b4.position.x = -bw * 0.48;
    g.add(b1, b2, b3, b4);
  }

  // Old-timey walking-beam pump mounted on a Sampson post beside the tower
  const sampsonPost = new THREE.Mesh(own(new THREE.BoxGeometry(0.024, 0.22, 0.024)), darkTimber);
  sampsonPost.position.set(0.16, 0.11, 0);
  sampsonPost.castShadow = true;
  g.add(sampsonPost);

  const beamPivot = new THREE.Group();
  beamPivot.position.set(0.16, 0.22, 0);
  const beam = new THREE.Mesh(own(new THREE.BoxGeometry(0.32, 0.024, 0.028)), mats.wood);
  beam.castShadow = true;
  beamPivot.add(beam);

  const horsehead = new THREE.Mesh(own(new THREE.CylinderGeometry(0.045, 0.045, 0.032, 8, 1, false, 0, Math.PI)), darkTimber);
  horsehead.rotation.x = Math.PI * 0.5;
  horsehead.rotation.z = Math.PI * 0.5;
  horsehead.position.set(-0.155, 0, 0);
  horsehead.castShadow = true;
  beamPivot.add(horsehead);
  g.add(beamPivot);

  // Vertical pump rod pulling oil from the ground
  const pumpRod = new THREE.Mesh(own(new THREE.CylinderGeometry(0.008, 0.008, 0.22, 6)), oilMat);
  pumpRod.position.set(0, 0.11, 0);
  pumpRod.castShadow = true;
  g.add(pumpRod);

  // Dramatic roaring fire group (hidden until tapped!)
  const fireGroup = new THREE.Group();
  fireGroup.visible = false;
  const outerFlameMat = own(new THREE.MeshStandardMaterial({
    color: '#ff6a00',
    emissive: '#ff4800',
    emissiveIntensity: 1.5,
    transparent: true,
    opacity: 0.9,
    roughness: 0.3,
  }));
  const innerFlameMat = own(new THREE.MeshStandardMaterial({
    color: '#ffe066',
    emissive: '#ffaa00',
    emissiveIntensity: 1.8,
    transparent: true,
    opacity: 0.92,
    roughness: 0.2,
  }));
  const smokeMat = own(new THREE.MeshStandardMaterial({
    color: '#221e1c',
    transparent: true,
    opacity: 0.72,
    roughness: 1.0,
  }));

  const flameMain = new THREE.Mesh(own(new THREE.ConeGeometry(0.18, 0.96, 8)), outerFlameMat);
  flameMain.position.y = 0.5;
  flameMain.castShadow = true;
  fireGroup.add(flameMain);

  const flameCore = new THREE.Mesh(own(new THREE.ConeGeometry(0.105, 0.72, 8)), innerFlameMat);
  flameCore.position.y = 0.4;
  flameCore.castShadow = true;
  fireGroup.add(flameCore);

  // Initial gusher explosion fireball
  const blastSphere = new THREE.Mesh(
    own(new THREE.IcosahedronGeometry(0.24, 2)),
    own(new THREE.MeshStandardMaterial({
      color: '#ff9d2e',
      emissive: '#ff5e00',
      emissiveIntensity: 2.2,
      transparent: true,
      opacity: 0.92,
      roughness: 0.2,
    }))
  );
  blastSphere.position.y = 0.32;
  blastSphere.visible = false;
  blastSphere.castShadow = true;
  fireGroup.add(blastSphere);

  // Flying embers bursting outward on ignition
  const embers: THREE.Mesh[] = [];
  for (let i = 0; i < 8; i++) {
    const ember = new THREE.Mesh(own(new THREE.SphereGeometry(0.022, 6, 5)), innerFlameMat);
    ember.castShadow = true;
    fireGroup.add(ember);
    embers.push(ember);
  }

  const smokePuffs: THREE.Mesh[] = [];
  for (let i = 0; i < 5; i++) {
    const puff = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.095 + i * 0.02, 1)), smokeMat);
    puff.position.set((i - 2) * 0.04, 0.85 + i * 0.14, 0);
    puff.castShadow = true;
    fireGroup.add(puff);
    smokePuffs.push(puff);
  }
  g.add(fireGroup);

  return { group: g, beamPivot, pumpRod, fireGroup, flameMain, flameCore, blastSphere, embers, smokePuffs };
}

class MinkAgent {
  id: string;
  name: string;
  role: string;
  homeDir: THREE.Vector3;
  dir: THREE.Vector3;
  forward: THREE.Vector3;
  rig: MinkRig;
  contactShadow: THREE.Mesh;
  sleepZs: { sprite: THREE.Sprite; phase: number; sideX: number }[];

  poseState = 'idle';
  speed = 0;
  targetDir: THREE.Vector3 | null = null;
  stateTimer = 0;
  animTime: number;
  sleepZClock: number;
  seed: number;
  glanceYaw = 0;
  glancePitch = 0;
  glanceTimer = 0;
  turnYaw = 0;
  chaseDir = 1;
  interrupted = false;
  interruptTimer = 0;
  wanderPhase = 'walk';
  wanderTimer: number;
  stuckAnchorDir = new THREE.Vector3();
  stuckTimer = 0;
  baseScale = 1.0;
  targetScale = 1.0;
  currentScale = 1.0;
  surfaceLift = 0.0;
  onTap?: () => void;
  private random: () => number;

  constructor(opts: {
    random: () => number;
    id: string;
    name: string;
    homeDir: THREE.Vector3;
    sharedGeo: THREE.BufferGeometry;
    sharedMat: THREE.Material;
    shadowTex: THREE.CanvasTexture;
    sleepZTex: THREE.CanvasTexture;
    planetGroup: THREE.Group;
    role: string;
    scale?: number;
  }) {
    this.random = opts.random;
    this.animTime = this.random() * 10;
    this.sleepZClock = this.random() * 10;
    this.seed = this.random() * 10;
    this.wanderTimer = 1 + this.random() * 3;
    this.id = opts.id;
    this.name = opts.name;
    this.role = opts.role;
    this.baseScale = opts.scale ?? 1.0;
    this.targetScale = this.baseScale;
    this.currentScale = this.baseScale;
    this.homeDir = opts.homeDir.clone().normalize();
    this.dir = opts.homeDir.clone().normalize();
    this.stuckAnchorDir.copy(this.dir);

    const ref = Math.abs(this.dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    this.forward = new THREE.Vector3().crossVectors(ref, this.dir).normalize();

    this.rig = createMinkRig(opts.sharedGeo, opts.sharedMat);
    this.rig.group.scale.setScalar(this.currentScale);
    this.rig.group.userData.minkAgent = this;
    this.rig.mesh.userData.minkAgent = this;

    const shadowMat = own(new THREE.MeshBasicMaterial({
      map: opts.shadowTex,
      transparent: true,
      depthWrite: false,
      opacity: 0.72,
    }));
    this.contactShadow = new THREE.Mesh(own(new THREE.PlaneGeometry(0.32, 0.48)), shadowMat);
    this.contactShadow.rotation.x = -Math.PI * 0.5;
    this.contactShadow.position.set(0, 0.002, -0.04);
    this.rig.group.add(this.contactShadow);

    this.sleepZs = [0.0, 0.5].map((phase, i) => {
      const sMat = own(new THREE.SpriteMaterial({
        map: opts.sleepZTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }));
      const sp = new THREE.Sprite(sMat);
      sp.visible = false;
      sp.scale.set(0.026, 0.029, 1);
      opts.planetGroup.add(sp);
      return { sprite: sp, phase, sideX: i === 0 ? -0.008 : 0.009 };
    });

    opts.planetGroup.add(this.rig.group);
    this.syncTransform();
  }

  faceTowardDir(targetDir: THREE.Vector3, dt: number, turnRate = 5.5): number {
    const toTarget = targetDir.clone().addScaledVector(this.dir, -targetDir.dot(this.dir));
    if (toTarget.lengthSq() < 1e-6) return 0;
    toTarget.normalize();
    const cross = new THREE.Vector3().crossVectors(this.forward, toTarget);
    const sinA = cross.dot(this.dir);
    const cosA = THREE.MathUtils.clamp(this.forward.dot(toTarget), -1, 1);
    const ang = Math.atan2(sinA, cosA);
    const step = THREE.MathUtils.clamp(ang, -turnRate * dt, turnRate * dt);
    this.forward.applyAxisAngle(this.dir, step).normalize();
    this.forward.addScaledVector(this.dir, -this.forward.dot(this.dir)).normalize();
    return ang;
  }

  enforceSurfacePhysics(prevDir?: THREE.Vector3) {
    // Only apply solid bridge handrail & water containment to ground-moving/wandering agents
    if (this.role !== 'wanderer' && this.role !== 'meadow') return;

    const bridgeDir = WORLD_CONFIG.landmarks.bridge.dir;
    if (this.dir.dot(bridgeDir) > 0.9) {
      const along = this.dir.dot(BRIDGE_FWD);
      const across = this.dir.dot(BRIDGE_RIGHT);
      const prevAcross = prevDir ? prevDir.dot(BRIDGE_RIGHT) : across;
      const inSpan = Math.abs(along) < 0.128;

      if (inSpan) {
        if (Math.abs(prevAcross) < 0.032 || Math.abs(across) < 0.032) {
          // Inside bridge deck: solid wooden handrails keep mink strictly inside the walkway
          const clampedAcross = THREE.MathUtils.clamp(across, -0.021, 0.021);
          if (clampedAcross !== across) {
            this.dir.addScaledVector(BRIDGE_RIGHT, clampedAcross - across).normalize();
            const fCross = this.forward.dot(BRIDGE_RIGHT);
            this.forward.addScaledVector(BRIDGE_RIGHT, -fCross * 0.85);
            if (this.forward.lengthSq() < 1e-5) {
              this.forward.copy(BRIDGE_FWD).multiplyScalar(along >= 0 ? -1 : 1);
            }
            this.forward.addScaledVector(this.dir, -this.forward.dot(this.dir)).normalize();
          }
        } else if (Math.abs(across) < 0.062) {
          // Outside bridge deck: solid side barrier prevents river/bank minks clipping sideways into rails/planks
          const pushSign = across >= 0 ? 1 : -1;
          this.dir.addScaledVector(BRIDGE_RIGHT, pushSign * 0.062 - across).normalize();
          this.forward.addScaledVector(BRIDGE_RIGHT, pushSign * 0.25).normalize();
          this.forward.addScaledVector(this.dir, -this.forward.dot(this.dir)).normalize();
        }
      }
    }

    // Prevent non-bridge minks from walking into water (slide smoothly along shoreline)
    if (!isOnBridgeCorridor(this.dir) && getTerrainHeight(this.dir) < WORLD_CONFIG.waterRadius + 0.012) {
      if (prevDir && !isOnBridgeCorridor(prevDir) && getTerrainHeight(prevDir) >= WORLD_CONFIG.waterRadius + 0.012) {
        const up = prevDir;
        const eps = 0.01;
        const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
        const t1 = new THREE.Vector3().crossVectors(ref, up).normalize();
        const t2 = new THREE.Vector3().crossVectors(up, t1).normalize();
        const gh1 = getTerrainHeight(up.clone().addScaledVector(t1, eps).normalize()) - getTerrainHeight(up.clone().addScaledVector(t1, -eps).normalize());
        const gh2 = getTerrainHeight(up.clone().addScaledVector(t2, eps).normalize()) - getTerrainHeight(up.clone().addScaledVector(t2, -eps).normalize());
        const dryGrad = t1.clone().multiplyScalar(gh1).addScaledVector(t2, gh2);
        if (dryGrad.lengthSq() > 1e-8) {
          dryGrad.normalize();
          // Slide tangentially along bank instead of stepping into water
          const stepVec = this.dir.clone().sub(prevDir);
          const inward = stepVec.dot(dryGrad);
          if (inward < 0) stepVec.addScaledVector(dryGrad, -inward);
          this.dir.copy(prevDir).add(stepVec).normalize();
          if (getTerrainHeight(this.dir) < WORLD_CONFIG.waterRadius + 0.012) {
            this.dir.copy(prevDir);
          }
          const fIn = this.forward.dot(dryGrad);
          if (fIn < 0) {
            this.forward.addScaledVector(dryGrad, -fIn * 1.4 + 0.25).normalize();
          }
          this.forward.addScaledVector(this.dir, -this.forward.dot(this.dir)).normalize();
        } else {
          this.dir.copy(prevDir);
        }
      } else {
        // Emergency dry recovery toward higher ground / homeDir
        const toHome = this.homeDir.clone().addScaledVector(this.dir, -this.homeDir.dot(this.dir));
        if (toHome.lengthSq() > 1e-5) {
          toHome.normalize();
          this.dir.addScaledVector(toHome, 0.018).normalize();
          this.forward.copy(toHome);
        }
      }
      if (this.role === 'wanderer') this.targetDir = null;
    }
  }

  moveAlongSphere(dt: number) {
    if (this.speed <= 0.001) return;
    const prevDir = this.dir.clone();
    const arc = (this.speed * dt) / WORLD_CONFIG.planetRadius;
    this.dir.addScaledVector(this.forward, arc).normalize();
    this.forward.addScaledVector(this.dir, -this.forward.dot(this.dir)).normalize();
    this.enforceSurfacePhysics(prevDir);
  }

  syncTransform() {
    const surf = getWalkableSurface(this.dir);
    // Positive surface margin (or elevated rock-step offset) keeps mink cleanly grounded without clipping
    this.rig.group.position.copy(surf.position).addScaledVector(surf.normal, this.surfaceLift);
    const up = surf.normal;
    const fwd = this.forward.clone().addScaledVector(up, -this.forward.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(up, fwd).normalize();
    const m = new THREE.Matrix4().makeBasis(right, up, fwd);
    this.rig.group.quaternion.setFromRotationMatrix(m);
  }

  poke(lookDir: THREE.Vector3 | null = null) {
    this.interrupted = true;
    this.interruptTimer = 2.4;
    this.glanceTimer = 2.4;
    if (lookDir) {
      this.setGlanceToward(lookDir);
    } else {
      this.glanceYaw = (this.random() > 0.5 ? 1 : -1) * 0.55;
      this.glancePitch = -0.35;
    }
  }

  setGlanceToward(worldTargetDir: THREE.Vector3) {
    const localVec = worldTargetDir.clone().sub(this.dir);
    const right = new THREE.Vector3().crossVectors(this.dir, this.forward).normalize();
    const side = localVec.dot(right);
    const front = localVec.dot(this.forward);
    this.glanceYaw = THREE.MathUtils.clamp(Math.atan2(-side, Math.max(0.15, front)), -0.85, 0.85);
    this.glancePitch = -0.25;
    this.glanceTimer = Math.max(this.glanceTimer, 0.35);
  }

  update(dt: number, renderPose = true, obstacles: { dir: THREE.Vector3; radius: number }[] = []) {
    this.animTime += dt;

    if (this.glanceTimer > 0) {
      this.glanceTimer -= dt;
      if (this.glanceTimer <= 0) {
        this.glanceYaw = 0;
        this.glancePitch = 0;
      }
    }
    if (this.interruptTimer > 0) {
      this.interruptTimer -= dt;
      if (this.interruptTimer <= 0) this.interrupted = false;
    }

    if (this.role === 'wanderer') {
      this.updateWanderer(dt, obstacles);
    }

    this.enforceSurfacePhysics();

    // Never allow any mink to stay curled asleep on the wooden bridge span or over water; walk off onto dry ground first
    if (this.poseState === 'sleep' && (isBridgeRestrictedSpot(this.dir) || getWalkableSurface(this.dir).onBridge)) {
      const along = this.dir.dot(BRIDGE_FWD);
      const exitSign = Math.abs(along) > 0.01 ? Math.sign(along) : (this.forward.dot(BRIDGE_FWD) >= 0 ? 1 : -1);
      const exitTarget = WORLD_CONFIG.landmarks.bridge.dir.clone().addScaledVector(BRIDGE_FWD, exitSign * 0.16).normalize();
      this.faceTowardDir(exitTarget, dt, 7.0);
      this.speed = 0.28;
      this.poseState = 'walk';
      this.moveAlongSphere(dt);
    }

    this.syncTransform();

    if (renderPose) {
      applyMinkPose(
        this.rig,
        {
          state: this.poseState,
          time: this.animTime,
          seed: this.seed,
          glanceYaw: this.glanceYaw,
          glancePitch: this.glancePitch,
          turnYaw: this.turnYaw,
          chaseDir: this.chaseDir,
        },
        dt
      );
    }

    if (renderPose && this.poseState === 'sleep') {
      this.sleepZClock += dt;
      const b = this.rig.bones;
      const headLocal = new THREE.Vector3(0, 0, 0);
      for (let bi = 5; bi >= 0; bi--) {
        b[bi].updateMatrix();
        headLocal.applyMatrix4(b[bi].matrix);
      }
      headLocal
        .multiplyScalar(this.currentScale)
        .applyQuaternion(this.rig.group.quaternion)
        .add(this.rig.group.position);
      const up = this.dir;
      const right = new THREE.Vector3().crossVectors(up, this.forward).normalize();
      for (const zItem of this.sleepZs) {
        const cycle = (this.sleepZClock * 0.34 + zItem.phase) % 1;
        const activeWindow = 0.78;
        if (cycle > activeWindow) {
          zItem.sprite.visible = false;
          continue;
        }
        zItem.sprite.visible = true;
        const tNorm = cycle / activeWindow;
        const alt = 0.065 + tNorm * 0.115;
        const sway = Math.sin(tNorm * Math.PI * 2 + zItem.phase * 6) * 0.011 + zItem.sideX * (0.4 + tNorm * 0.6);
        zItem.sprite.position.copy(headLocal).addScaledVector(up, alt).addScaledVector(right, sway);
        const fade = Math.sin(tNorm * Math.PI);
        (zItem.sprite.material as THREE.SpriteMaterial).opacity = Math.min(0.92, fade * 1.25);
        const popScale = (0.72 + 0.38 * tNorm) * this.currentScale;
        zItem.sprite.scale.set(0.025 * popScale, 0.028 * popScale, 1);
      }
    } else {
      for (const zItem of this.sleepZs) zItem.sprite.visible = false;
    }
  }

  private pickClearWanderTarget(obstacles: { dir: THREE.Vector3; radius: number }[], preferForward = false): THREE.Vector3 {
    let candidate = this.homeDir.clone();
    for (let tries = 0; tries < 18; tries++) {
      let cand: THREE.Vector3;
      if (preferForward && tries < 6) {
        const jitterAngle = (this.random() - 0.5) * 1.1;
        const steer = this.forward.clone().applyAxisAngle(this.dir, jitterAngle).normalize();
        cand = this.dir.clone().addScaledVector(steer, 0.35 + this.random() * 0.45).normalize();
      } else {
        const offset = new THREE.Vector3(this.random() - 0.5, this.random() - 0.5, this.random() - 0.5).multiplyScalar(0.88);
        cand = this.homeDir.clone().add(offset).normalize();
      }
      const dRose = cand.angleTo(WORLD_CONFIG.landmarks.rose.dir);
      const dMeadow = cand.angleTo(WORLD_CONFIG.landmarks.meadow.dir);
      const mid = this.dir.clone().add(cand).normalize();
      const midMeadow = mid.angleTo(WORLD_CONFIG.landmarks.meadow.dir);
      const inWater =
        getTerrainHeight(cand) < WORLD_CONFIG.waterRadius + 0.016 ||
        getRiverFactor(cand) > 0.12 ||
        getRiverFactor(mid) > 0.35;
      const onBridge = isBridgeRestrictedSpot(cand);
      const inMeadow = dMeadow < 0.29 || midMeadow < 0.24;
      const blocked = obstacles.some((o) => cand.angleTo(o.dir) < o.radius + 0.105);
      if (dRose > 0.55 && !inWater && !onBridge && !inMeadow && !blocked) {
        candidate = cand;
        break;
      }
    }
    return candidate;
  }

  updateWanderer(dt: number, obstacles: { dir: THREE.Vector3; radius: number }[] = []) {
    if (this.interrupted) {
      this.speed = 0;
      this.poseState = 'idle';
      this.stuckTimer = 0;
      this.stuckAnchorDir.copy(this.dir);
      return;
    }

    // Never rest or nap while crossing the bridge or standing on the immediate bridge apron
    if (isBridgeRestrictedSpot(this.dir) || getWalkableSurface(this.dir).onBridge) {
      const along = this.dir.dot(BRIDGE_FWD);
      const exitSign = Math.abs(along) > 0.01 ? Math.sign(along) : (this.forward.dot(BRIDGE_FWD) >= 0 ? 1 : -1);
      const exitDir = WORLD_CONFIG.landmarks.bridge.dir.clone().addScaledVector(BRIDGE_FWD, exitSign * 0.16).normalize();
      this.targetDir = exitDir;
      this.wanderPhase = 'walk';
      this.wanderTimer = Math.max(this.wanderTimer, 1.5);
      const ang = this.faceTowardDir(exitDir, dt, 6.5);
      this.turnYaw = THREE.MathUtils.clamp(ang, -0.5, 0.5);
      this.speed = 0.28;
      this.poseState = 'walk';
      this.moveAlongSphere(dt);
      return;
    }

    this.wanderTimer -= dt;

    if (!this.targetDir || this.wanderTimer <= 0) {
      const r = this.random();
      if (r < 0.58) {
        this.targetDir = this.pickClearWanderTarget(obstacles, false);
        this.wanderPhase = 'walk';
        this.wanderTimer = 4 + this.random() * 4;
      } else if (r < 0.8) {
        this.wanderPhase = 'sniff';
        this.speed = 0;
        this.wanderTimer = 2.0 + this.random() * 1.8;
      } else if (r < 0.92) {
        this.wanderPhase = 'sit';
        this.speed = 0;
        this.wanderTimer = 2.8 + this.random() * 2.5;
      } else {
        this.wanderPhase = 'tail_chase';
        this.chaseDir = this.random() > 0.5 ? 1 : -1;
        this.speed = 0;
        this.wanderTimer = 2.1;
      }
      this.stuckTimer = 0;
      this.stuckAnchorDir.copy(this.dir);
    }

    if (this.wanderPhase === 'walk' && this.targetDir) {
      const dist = this.dir.angleTo(this.targetDir);
      if (dist < 0.05) {
        this.wanderPhase = 'sniff';
        this.wanderTimer = 1.8 + this.random() * 1.5;
        this.speed = 0;
        this.poseState = 'sniff';
        this.stuckTimer = 0;
      } else {
        // Unstick recovery: if progress stalls for ~2s, smoothly pick a fresh open target (never violently flip 180° into a loop)
        if (this.dir.angleTo(this.stuckAnchorDir) > 0.032) {
          this.stuckAnchorDir.copy(this.dir);
          this.stuckTimer = 0;
        } else {
          this.stuckTimer += dt;
          if (this.stuckTimer >= 2.1) {
            this.stuckTimer = 0;
            this.stuckAnchorDir.copy(this.dir);
            this.targetDir = this.pickClearWanderTarget(obstacles, false);
            this.wanderTimer = 3.6 + this.random() * 1.8;
          }
        }

        // Smooth tangent avoidance around nearby obstacles & the meadow play ring so wanderers never run into circling minks
        const steer = this.targetDir.clone().addScaledVector(this.dir, -this.targetDir.dot(this.dir));
        let steerTarget = this.targetDir;
        if (steer.lengthSq() > 1e-6) {
          steer.normalize();
          const avoidList = [
            ...obstacles,
            { dir: WORLD_CONFIG.landmarks.meadow.dir, radius: 0.22 },
          ];
          for (const o of avoidList) {
            const dObs = this.dir.angleTo(o.dir);
            const avoidR = o.radius + 0.082;
            if (dObs < avoidR) {
              const away = this.dir.clone().sub(o.dir);
              away.addScaledVector(this.dir, -away.dot(this.dir));
              if (away.lengthSq() > 1e-6) {
                away.normalize();
                const inward = steer.dot(away);
                if (inward < 0) {
                  const w = smoothstep(avoidR, o.radius + 0.042, dObs);
                  steer.addScaledVector(away, -inward * (1.15 * w));
                  if (steer.lengthSq() < 1e-4) {
                    const tangent = new THREE.Vector3().crossVectors(this.dir, away).normalize();
                    if (tangent.dot(this.forward) < 0) tangent.negate();
                    steer.copy(tangent);
                  } else {
                    steer.normalize();
                  }
                }
              }
            }
          }
          steerTarget = this.dir.clone().addScaledVector(steer, 0.25).normalize();
        }

        const ang = this.faceTowardDir(steerTarget, dt, 3.8);
        this.turnYaw = THREE.MathUtils.clamp(ang, -0.7, 0.7);
        this.speed = 0.26;
        this.poseState = 'walk';
        this.moveAlongSphere(dt);
      }
    } else {
      this.turnYaw = 0;
      this.speed = 0;
      this.poseState = this.wanderPhase;
      this.stuckTimer = 0;
      this.stuckAnchorDir.copy(this.dir);
    }
  }
}

interface AgentGroups {
  tea: MinkAgent[];
  meadow: MinkAgent[];
  rose: MinkAgent[];
  mystery: MinkAgent[];
  astro: MinkAgent[];
  ball: MinkAgent[];
  derrick: MinkAgent[];
  monolith: MinkAgent[];
  sixhand: MinkAgent[];
  david: MinkAgent[];
  painter: MinkAgent[];
  tinkerer: MinkAgent[];
  keeper: MinkAgent[];
  helping: MinkAgent[];
  wanderers: MinkAgent[];
}

function createSceneControllers(
  planetGroup: THREE.Group,
  agents: AgentGroups,
  mats: WorldMats,
  camera: THREE.Camera | undefined,
  random: () => number,
  engineNow: () => number,
  scheduleTimeout: (callback: () => void, delay: number) => number
) {
  const controllers: { update: (dt: number, nightFactor: number) => void }[] = [];
  const interactiveProps: { mesh: THREE.Object3D; onTap: () => void }[] = [];

  const placeAtLandmark = (
    agent: MinkAgent,
    lmDir: THREE.Vector3,
    rightOffset: number,
    fwdOffset: number,
    faceCenter = true
  ) => {
    const up = lmDir.clone().normalize();
    const ref = Math.abs(up.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(up, ref).normalize();
    const fwd = new THREE.Vector3().crossVectors(right, up).normalize();
    const d = lmDir.clone().addScaledVector(right, rightOffset).addScaledVector(fwd, fwdOffset).normalize();
    agent.dir.copy(d);
    if (faceCenter) {
      const toC = lmDir.clone().sub(d).addScaledVector(d, -lmDir.clone().sub(d).dot(d)).normalize();
      agent.forward.copy(toC);
    } else {
      agent.forward.copy(fwd);
    }
    agent.syncTransform();
  };

  // SCENE 1: TWO MINK HAVING TEA BESIDE WATER
  {
    const teaDir = WORLD_CONFIG.landmarks.tea.dir;
    const teaHolder = attachOnSurface(planetGroup, teaDir, 0, 0.2);

    // Warm wooden patio deck grounding the tea gathering
    const patio = new THREE.Mesh(own(new THREE.CylinderGeometry(0.42, 0.46, 0.028, 18)), mats.woodLight);
    patio.position.y = 0.006;
    patio.receiveShadow = true;
    teaHolder.add(patio);

    const table = new THREE.Mesh(own(new THREE.CylinderGeometry(0.18, 0.2, 0.075, 14)), mats.stone);
    table.position.y = 0.052;
    table.castShadow = true;
    table.receiveShadow = true;
    teaHolder.add(table);

    const teapot = createTeapot(mats);
    teapot.position.set(0, 0.075, 0);
    teaHolder.add(teapot);

    const cupA = createCeramicCup(mats);
    cupA.position.set(-0.105, 0.075, 0.025);
    teaHolder.add(cupA);

    const cupB = createCeramicCup(mats);
    cupB.position.set(0.105, 0.075, -0.015);
    teaHolder.add(cupB);

    const steam = new THREE.Mesh(
      own(new THREE.SphereGeometry(0.018, 6, 5)),
      own(new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }))
    );
    steam.position.set(0.105, 0.13, -0.015);
    teaHolder.add(steam);

    // Night-time patio lantern beside the tea deck
    const lanternPost = new THREE.Mesh(own(new THREE.CylinderGeometry(0.008, 0.01, 0.22, 6)), mats.wood);
    lanternPost.position.set(-0.31, 0.11, -0.2);
    lanternPost.castShadow = true;
    teaHolder.add(lanternPost);
    const teaLanternMat = own(new THREE.MeshStandardMaterial({
      color: '#ffe4a8',
      emissive: '#ffaa33',
      emissiveIntensity: 0.1,
      roughness: 0.3,
    }));
    const teaLanternGlass = new THREE.Mesh(own(new THREE.BoxGeometry(0.036, 0.048, 0.036)), teaLanternMat);
    teaLanternGlass.position.set(-0.31, 0.23, -0.2);
    teaHolder.add(teaLanternGlass);
    const teaLanternLight = new THREE.PointLight('#ffb54d', 0, 1.25, 1.8);
    teaLanternLight.position.set(-0.31, 0.25, -0.2);
    teaHolder.add(teaLanternLight);

    const [pip, milo] = agents.tea;
    pip.surfaceLift = 0.018;
    milo.surfaceLift = 0.018;
    placeAtLandmark(pip, teaDir, -0.095, 0.018, true);
    placeAtLandmark(milo, teaDir, 0.095, -0.014, true);
    pip.poseState = 'sit';
    milo.poseState = 'sit';

    // Exact snout/mouth local targets computed cleanly inside teaHolder so levitating cups fly straight to the mink's mouth!
    const pipMouthLocal = new THREE.Vector3(-0.21, 0.195, 0.02);
    const miloMouthLocal = new THREE.Vector3(0.21, 0.195, -0.015);
    const pipRestCup = new THREE.Vector3(-0.105, 0.075, 0.02);
    const miloRestCup = new THREE.Vector3(0.105, 0.075, -0.015);

    // Telekinetic ("Mind Control") concentric psychic ripple rings + floating motes linking outstretched paws/head to levitating cup/teapot
    const mindGroup = new THREE.Group();
    mindGroup.visible = false;
    const mindRings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const rMat = own(new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? '#b78cff' : '#7ae6ff',
        transparent: true,
        opacity: 0.65,
        side: THREE.DoubleSide,
        depthWrite: false,
      }));
      const ring = new THREE.Mesh(own(new THREE.TorusGeometry(0.036, 0.0042, 6, 18)), rMat);
      mindGroup.add(ring);
      mindRings.push({ mesh: ring, mat: rMat, phase: i / 3 });
    }
    const mindMotes: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; phase: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const mMat = own(new THREE.MeshBasicMaterial({
        color: i % 2 === 0 ? '#d8b4ff' : '#9ff3ff',
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }));
      const mote = new THREE.Mesh(own(new THREE.OctahedronGeometry(0.009, 0)), mMat);
      mindGroup.add(mote);
      mindMotes.push({ mesh: mote, mat: mMat, phase: (i / 6) * Math.PI * 2 });
    }
    teaHolder.add(mindGroup);

    const _headWorld = new THREE.Vector3();
    const _targetLocal = new THREE.Vector3();
    const _beamDir = new THREE.Vector3();
    const _beamQuat = new THREE.Quaternion();
    const _zAxis = new THREE.Vector3(0, 0, 1);

    const updateMindEffect = (caster: MinkAgent, objectLocalPos: THREE.Vector3, timeSec: number) => {
      mindGroup.visible = true;
      caster.rig.group.updateMatrixWorld(true);
      teaHolder.updateMatrixWorld(true);
      _headWorld.set(0, 0.015, 0.032);
      caster.rig.bones[5].localToWorld(_headWorld);
      teaHolder.worldToLocal(_headWorld);
      _beamDir.subVectors(objectLocalPos, _headWorld);
      const beamLen = Math.max(0.04, _beamDir.length());
      _beamDir.normalize();
      _beamQuat.setFromUnitVectors(_zAxis, _beamDir);

      for (const mr of mindRings) {
        const prog = (timeSec * 0.95 + mr.phase) % 1;
        mr.mesh.position.copy(_headWorld).addScaledVector(_beamDir, prog * beamLen);
        mr.mesh.quaternion.copy(_beamQuat);
        mr.mesh.scale.setScalar(0.55 + Math.sin(prog * Math.PI) * 0.65);
        mr.mat.opacity = Math.sin(prog * Math.PI) * 0.78;
      }
      for (const mm of mindMotes) {
        const ang = timeSec * 3.6 + mm.phase;
        const rad = 0.046 + Math.sin(timeSec * 2.5 + mm.phase) * 0.012;
        mm.mesh.position.set(
          objectLocalPos.x + Math.cos(ang) * rad,
          objectLocalPos.y + 0.015 + Math.sin(ang * 1.4) * 0.022,
          objectLocalPos.z + Math.sin(ang) * rad
        );
        mm.mat.opacity = 0.55 + Math.sin(timeSec * 5.0 + mm.phase) * 0.3;
      }
    };

    const getMouthLocal = (who: MinkAgent, fallback: THREE.Vector3) => {
      who.rig.group.updateMatrixWorld(true);
      teaHolder.updateMatrixWorld(true);
      _targetLocal.set(0, -0.014, 0.072);
      who.rig.bones[5].localToWorld(_targetLocal);
      teaHolder.worldToLocal(_targetLocal);
      if (_targetLocal.lengthSq() > 0.36) _targetLocal.copy(fallback);
      return _targetLocal;
    };

    const teaCtrl = {
      phase: 'pour',
      timer: 2.8,
      cycle: 0,
      onTap(who: MinkAgent) {
        who.poke();
        if (who === pip) pip.poseState = 'tea_offer';
      },
      update(dt: number, nightFactor: number) {
        // Warm tea-patio lantern switches on at dusk/night
        teaLanternMat.emissiveIntensity = 0.1 + nightFactor * 0.85;
        teaLanternLight.intensity = nightFactor * 0.95;

        if (nightFactor > 0.72 && !pip.interrupted && !milo.interrupted) {
          pip.poseState = 'sleep';
          milo.poseState = 'sleep';
          pip.speed = 0;
          milo.speed = 0;
          steam.visible = false;
          mindGroup.visible = false;
          return;
        }
        steam.visible = true;

        if (pip.interrupted || milo.interrupted) {
          if (pip.interrupted) pip.poseState = 'tea_offer';
          if (milo.interrupted) milo.poseState = 'sit';
          mindGroup.visible = false;
          return;
        }

        const timeSec = engineNow() * 0.001;
        this.timer -= dt;
        steam.position.set(cupB.position.x, cupB.position.y + 0.055 + ((timeSec * 0.5) % 1) * 0.055, cupB.position.z);
        (steam.material as THREE.MeshBasicMaterial).opacity =
          this.phase === 'sniff_sip' || this.phase === 'pour' ? 0.36 : 0.12;

        if (this.timer <= 0) {
          this.cycle++;
          if (this.phase === 'pour') {
            this.phase = this.cycle % 4 === 0 ? 'mistake_offer' : 'sniff_sip';
            this.timer = this.phase === 'mistake_offer' ? 2.6 : 3.6;
          } else if (this.phase === 'mistake_offer') {
            this.phase = 'mistake_swap';
            this.timer = 1.6;
          } else if (this.phase === 'mistake_swap' || this.phase === 'sniff_sip') {
            this.phase = 'settle';
            this.timer = 3.6 + random() * 1.8;
          } else {
            this.phase = 'pour';
            this.timer = 2.8;
          }
        }

        if (this.phase === 'pour') {
          pip.poseState = 'tea_pour';
          milo.poseState = 'tea_wait';
          teapot.position.lerp(new THREE.Vector3(0.02, 0.135, 0.0), 0.14);
          teapot.rotation.z = THREE.MathUtils.lerp(teapot.rotation.z, -0.52, 0.14);
          cupA.position.lerp(pipRestCup, 0.12);
          cupA.rotation.z = THREE.MathUtils.lerp(cupA.rotation.z, 0, 0.14);
          cupB.position.lerp(miloRestCup, 0.12);
          cupB.rotation.z = THREE.MathUtils.lerp(cupB.rotation.z, 0, 0.14);
          updateMindEffect(pip, teapot.position, timeSec);
        } else if (this.phase === 'sniff_sip') {
          pip.poseState = 'tea_wait';
          milo.poseState = 'tea_sip';
          teapot.position.lerp(new THREE.Vector3(0, 0.075, 0), 0.12);
          teapot.rotation.z = THREE.MathUtils.lerp(teapot.rotation.z, 0, 0.12);

          // Float cupB directly to Milo's mouth & tilt smoothly for telekinetic sipping!
          const mouthPos = getMouthLocal(milo, miloMouthLocal);
          cupB.position.lerp(mouthPos, 0.14);
          cupB.rotation.z = THREE.MathUtils.lerp(cupB.rotation.z, 0.34, 0.14);
          updateMindEffect(milo, cupB.position, timeSec);
        } else if (this.phase === 'mistake_offer') {
          pip.poseState = 'tea_offer';
          milo.poseState = 'tea_sip';
          // Float cupA directly to Pip's mouth too!
          const mouthPos = getMouthLocal(pip, pipMouthLocal);
          cupA.position.lerp(mouthPos, 0.14);
          cupA.rotation.z = THREE.MathUtils.lerp(cupA.rotation.z, -0.34, 0.14);
          milo.glanceYaw = -0.22;
          updateMindEffect(pip, cupA.position, timeSec);
        } else if (this.phase === 'mistake_swap') {
          pip.poseState = 'sit';
          milo.poseState = 'sit';
          cupA.position.lerp(pipRestCup, 0.15);
          cupA.rotation.z = THREE.MathUtils.lerp(cupA.rotation.z, 0, 0.15);
          cupB.position.lerp(miloRestCup, 0.15);
          cupB.rotation.z = THREE.MathUtils.lerp(cupB.rotation.z, 0, 0.15);
          mindGroup.visible = false;
        } else {
          pip.poseState = 'sit';
          milo.poseState = 'sit';
          teapot.position.lerp(new THREE.Vector3(0, 0.075, 0), 0.12);
          teapot.rotation.z = THREE.MathUtils.lerp(teapot.rotation.z, 0, 0.12);
          cupA.position.lerp(pipRestCup, 0.12);
          cupA.rotation.z = THREE.MathUtils.lerp(cupA.rotation.z, 0, 0.12);
          cupB.position.lerp(miloRestCup, 0.12);
          cupB.rotation.z = THREE.MathUtils.lerp(cupB.rotation.z, 0, 0.12);
          mindGroup.visible = false;
        }
      },
    };
    interactiveProps.push({ mesh: table, onTap: () => teaCtrl.onTap(pip) });
    controllers.push(teaCtrl);
  }

  // SCENE 2: THREE MINK RUNNING IN CIRCLES
  {
    const mDir = WORLD_CONFIG.landmarks.meadow.dir;
    const mHolder = attachOnSurface(planetGroup, mDir, 0.004, 0);

    const puddle = new THREE.Mesh(
      own(new THREE.CircleGeometry(0.14, 18)),
      own(new THREE.MeshStandardMaterial({ color: '#6ec4dc', roughness: 0.15, metalness: 0.2 }))
    );
    puddle.rotation.x = -Math.PI * 0.5;
    puddle.receiveShadow = true;
    mHolder.add(puddle);

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.3;
      const flower = new THREE.Mesh(own(new THREE.SphereGeometry(0.016, 6, 5)), mats.ceramic);
      flower.scale.y = 0.5;
      flower.position.set(Math.cos(a) * 0.21, 0.01, Math.sin(a) * 0.19);
      mHolder.add(flower);
    }

    const up = mDir.clone();
    const ref = new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(up, ref).normalize();
    const fwd = new THREE.Vector3().crossVectors(right, up).normalize();

    const trio = agents.meadow;
    const baseRadius = 0.175;
    let groupAngle = 0;
    const slotOffsets = [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3];
    let direction = 1;
    let phase = 'run';
    let timer = 7.5;
    let cloverVisitingTea = false;
    let cloverVisitStage = 0;

    trio.forEach((m, idx) => {
      const a = groupAngle + slotOffsets[idx];
      const d = mDir.clone().addScaledVector(right, Math.cos(a) * baseRadius).addScaledVector(fwd, Math.sin(a) * baseRadius).normalize();
      m.dir.copy(d);
      const tangent = right
        .clone()
        .multiplyScalar(-Math.sin(a) * direction)
        .addScaledVector(fwd, Math.cos(a) * direction)
        .normalize();
      m.forward.copy(tangent);
      m.syncTransform();
    });

    controllers.push({
      update(dt: number, nightFactor: number) {
        if (nightFactor > 0.72) {
          trio.forEach((m, idx) => {
            // If Clover is mid-visit or crossing the bridge at dusk, finish crossing off the bridge onto dry ground before sleeping
            if (idx === 1 && (cloverVisitingTea || isBridgeRestrictedSpot(m.dir) || getWalkableSurface(m.dir).onBridge)) {
              const bridgeDir = WORLD_CONFIG.landmarks.bridge.dir;
              const meadowBridgeEnd = bridgeDir.clone().addScaledVector(BRIDGE_FWD, 0.145).normalize();
              const teaBridgeEnd = bridgeDir.clone().addScaledVector(BRIDGE_FWD, -0.145).normalize();
              const onBridge = isBridgeRestrictedSpot(m.dir) || getWalkableSurface(m.dir).onBridge;
              if (onBridge) {
                const exitTarget = m.dir.dot(BRIDGE_FWD) >= 0 ? meadowBridgeEnd : teaBridgeEnd;
                m.faceTowardDir(exitTarget, dt, 6.0);
                m.speed = 0.34;
                m.poseState = 'walk';
                m.moveAlongSphere(dt);
                return;
              }
              cloverVisitingTea = false;
            }
            m.speed = 0;
            m.poseState = 'sleep';
          });
          return;
        }
        timer -= dt;
        if (timer <= 0) {
          if (phase === 'run') {
            const r = random();
            if (r < 0.28 && !cloverVisitingTea) {
              cloverVisitingTea = true;
              cloverVisitStage = 0;
              phase = 'run';
              timer = 8.0;
            } else if (r < 0.72) {
              phase = 'puddle_pause';
              timer = 3.2;
            } else {
              phase = 'rest';
              timer = 3.0;
              direction *= -1;
            }
          } else {
            phase = 'run';
            timer = 6.5 + random() * 3.5;
          }
        }

        if (phase === 'run' || phase === 'puddle_pause') {
          groupAngle += direction * 1.85 * dt;
        }

        trio.forEach((m, idx) => {
          if (idx === 1 && cloverVisitingTea) {
            const bridgeDir = WORLD_CONFIG.landmarks.bridge.dir;
            const meadowBridgeEnd = bridgeDir.clone().addScaledVector(BRIDGE_FWD, 0.145).normalize();
            const teaBridgeEnd = bridgeDir.clone().addScaledVector(BRIDGE_FWD, -0.145).normalize();
            const teaStop = WORLD_CONFIG.landmarks.tea.dir.clone().lerp(bridgeDir, 0.26).normalize();

            const walkStepTo = (target: THREE.Vector3, spd: number, thresh = 0.055): boolean => {
              m.faceTowardDir(target, dt, 5.5);
              m.speed = spd;
              m.poseState = spd > 0.44 ? 'run' : 'walk';
              m.moveAlongSphere(dt);
              return m.dir.angleTo(target) < thresh;
            };

            if (cloverVisitStage === 0) {
              if (walkStepTo(meadowBridgeEnd, 0.42, 0.045)) cloverVisitStage = 1;
            } else if (cloverVisitStage === 1) {
              if (walkStepTo(teaBridgeEnd, 0.36, 0.045)) cloverVisitStage = 2;
            } else if (cloverVisitStage === 2) {
              if (walkStepTo(teaStop, 0.42, 0.06)) {
                cloverVisitStage = 3;
                m.stateTimer = 2.6;
                agents.tea[0].setGlanceToward(m.dir);
                agents.tea[1].setGlanceToward(m.dir);
              }
            } else if (cloverVisitStage === 3) {
              m.speed = 0;
              m.poseState = 'sniff';
              m.stateTimer -= dt;
              if (m.stateTimer <= 0) cloverVisitStage = 4;
            } else if (cloverVisitStage === 4) {
              if (walkStepTo(teaBridgeEnd, 0.42, 0.045)) cloverVisitStage = 5;
            } else if (cloverVisitStage === 5) {
              if (walkStepTo(meadowBridgeEnd, 0.36, 0.045)) cloverVisitStage = 6;
            } else {
              const rejoinAngle = groupAngle + slotOffsets[idx];
              const rejoinSpot = mDir
                .clone()
                .addScaledVector(right, Math.cos(rejoinAngle) * baseRadius)
                .addScaledVector(fwd, Math.sin(rejoinAngle) * baseRadius)
                .normalize();
              m.faceTowardDir(rejoinSpot, dt, 4.5);
              m.speed = 0.48;
              m.poseState = 'run';
              m.moveAlongSphere(dt);
              if (m.dir.angleTo(rejoinSpot) < 0.08) {
                cloverVisitingTea = false;
              }
            }
            return;
          }

          if (m.interrupted) {
            m.speed = 0;
            m.poseState = 'idle';
            return;
          }

          if (phase === 'rest') {
            m.speed = 0;
            m.poseState = idx === 2 ? 'tail_chase' : 'sit';
            return;
          }

          const radiusScale = phase === 'puddle_pause' && idx !== 0 ? 0.2 : baseRadius;
          if (phase === 'puddle_pause' && idx === 0) {
            const puddleEdge = mDir.clone().addScaledVector(right, 0.065).normalize();
            if (m.dir.angleTo(puddleEdge) > 0.04) {
              m.faceTowardDir(puddleEdge, dt, 5.0);
              m.speed = 0.34;
              m.poseState = 'walk';
              m.moveAlongSphere(dt);
            } else {
              m.faceTowardDir(mDir, dt, 5.0);
              m.speed = 0;
              m.poseState = 'sniff';
            }
          } else {
            // Aim slightly ahead of this mink's own evenly spaced slot so all 3 stay 120° apart
            const targetAngle = groupAngle + slotOffsets[idx] + direction * 0.28;
            const tgt = mDir
              .clone()
              .addScaledVector(right, Math.cos(targetAngle) * radiusScale)
              .addScaledVector(fwd, Math.sin(targetAngle) * radiusScale)
              .normalize();
            const ang = m.faceTowardDir(tgt, dt, 10.5);
            m.turnYaw = THREE.MathUtils.clamp(ang, -0.65, 0.65);
            m.speed = 0.95;
            m.poseState = 'run';
            m.moveAlongSphere(dt);
          }
        });
      },
    });
  }

  // SCENE 3: SOLITARY MINK AND DESERT ROSE (+ Two Menacing Sheep hiding behind cactus, right-falling bell jar & Mink pickup!)
  {
    const roseDir = WORLD_CONFIG.landmarks.rose.dir;
    const roseHolder = attachOnSurface(planetGroup, roseDir, 0, 0.3);
    roseHolder.updateMatrixWorld(true);

    const { root: roseMesh, flowerHead, bellJarGroup } = createDesertRose(mats);
    roseHolder.add(roseMesh);

    const wateringVessel = createCeramicCup(mats, true);
    wateringVessel.position.set(-0.09, 0, 0.06);
    roseHolder.add(wateringVessel);

    const roseRightVec = new THREE.Vector3(1, 0, 0).applyQuaternion(roseHolder.quaternion).normalize();
    const roseFwdVec = new THREE.Vector3(0, 0, 1).applyQuaternion(roseHolder.quaternion).normalize();
    const getRoseSpot = (rOff: number, fOff: number) =>
      roseDir.clone().addScaledVector(roseRightVec, rOff).addScaledVector(roseFwdVec, fOff).normalize();

    const sable = agents.rose[0];
    const sableRestDir = getRoseSpot(-0.105, 0.035);
    sable.dir.copy(sableRestDir);
    sable.faceTowardDir(roseDir, 1.0, 20.0);
    sable.syncTransform();
    sable.poseState = 'sit';

    // Fall to the RIGHT side (+Z of roseHolder, perpendicular to the cactus-to-rose sheep line so sheep never run through it!)
    const GLASS_FALL_LOCAL = new THREE.Vector3(-0.02, 0.056, 0.17);
    const glassFallWorld = GLASS_FALL_LOCAL.clone().applyQuaternion(roseHolder.quaternion).add(roseHolder.position);
    const glassFallDir = glassFallWorld.clone().normalize();
    const sablePickDir = roseDir.clone().lerp(glassFallDir, 0.72).normalize();

    // Two Menacing Little Prince Sheep hiding side-by-side behind the nearby desert saguaro cactus [0.44, -0.56, -0.70]
    const nearCactusDir = new THREE.Vector3(0.44, -0.56, -0.70).normalize();
    const cactusUp = nearCactusDir.clone();
    const awayFromRoseTan = nearCactusDir
      .clone()
      .sub(roseDir)
      .addScaledVector(cactusUp, -nearCactusDir.clone().sub(roseDir).dot(cactusUp))
      .normalize();
    const cactusSideTan = new THREE.Vector3().crossVectors(cactusUp, awayFromRoseTan).normalize();
    const toCactusFromRose = nearCactusDir
      .clone()
      .sub(roseDir)
      .addScaledVector(roseDir, -nearCactusDir.clone().sub(roseDir).dot(roseDir))
      .normalize();
    const biteSideTan = new THREE.Vector3().crossVectors(roseDir, toCactusFromRose).normalize();

    const woolMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#f3eee2', roughness: 0.96, flatShading: true })), 0.34, 5.0);
    const sheepDarkMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#2b2623', roughness: 0.9, flatShading: true })), 0.34, 5.0);

    const createLittlePrinceSheep = (scale: number) => {
      const holder = new THREE.Group();
      const body = new THREE.Group();
      body.scale.setScalar(scale);

      const puffSpecs: [number, number, number, number][] = [
        [0, 0.062, 0, 0.044],
        [0, 0.066, 0.025, 0.036],
        [0, 0.06, -0.026, 0.038],
        [-0.02, 0.062, 0.004, 0.032],
        [0.02, 0.062, 0.004, 0.032],
        [0, 0.084, 0.004, 0.032],
      ];
      for (const [px, py, pz, pr] of puffSpecs) {
        const p = new THREE.Mesh(own(new THREE.IcosahedronGeometry(pr, 1)), woolMat);
        p.position.set(px, py, pz);
        p.castShadow = true;
        p.receiveShadow = true;
        body.add(p);
      }
      const tail = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.016, 0)), woolMat);
      tail.position.set(0, 0.064, -0.058);
      body.add(tail);

      const head = new THREE.Group();
      head.position.set(0, 0.074, 0.046);
      const snout = new THREE.Mesh(own(new THREE.SphereGeometry(0.022, 8, 6)), sheepDarkMat);
      snout.scale.set(0.86, 0.88, 1.24);
      snout.position.set(0, -0.002, 0.016);
      snout.castShadow = true;
      const crownWool = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.022, 0)), woolMat);
      crownWool.position.set(0, 0.016, 0.006);
      for (const side of [-1, 1]) {
        const ear = new THREE.Mesh(own(new THREE.BoxGeometry(0.022, 0.01, 0.012)), sheepDarkMat);
        ear.position.set(side * 0.022, 0.004, 0.004);
        ear.rotation.z = side * -0.45;
        head.add(ear);
      }
      head.add(snout, crownWool);
      body.add(head);

      const legs: THREE.Mesh[] = [];
      for (const [lx, lz] of [
        [-0.018, 0.022],
        [0.018, 0.022],
        [-0.018, -0.022],
        [0.018, -0.022],
      ]) {
        const leg = new THREE.Mesh(own(new THREE.CylinderGeometry(0.006, 0.005, 0.036, 5)), sheepDarkMat);
        leg.position.set(lx, 0.018, lz);
        leg.castShadow = true;
        body.add(leg);
        legs.push(leg);
      }
      holder.add(body);
      planetGroup.add(holder);
      return { holder, body, head, legs, curDir: nearCactusDir.clone() };
    };

    const sheepPairs = [
      {
        sheep: createLittlePrinceSheep(1.0),
        hideDir: nearCactusDir.clone().addScaledVector(awayFromRoseTan, 0.056).addScaledVector(cactusSideTan, -0.026).normalize(),
        biteDir: roseDir.clone().addScaledVector(toCactusFromRose, 0.072).addScaledVector(biteSideTan, -0.024).normalize(),
        lag: 0,
      },
      {
        sheep: createLittlePrinceSheep(0.88),
        hideDir: nearCactusDir.clone().addScaledVector(awayFromRoseTan, 0.068).addScaledVector(cactusSideTan, 0.032).normalize(),
        biteDir: roseDir.clone().addScaledVector(toCactusFromRose, 0.078).addScaledVector(biteSideTan, 0.032).normalize(),
        lag: 0.14,
      },
    ];

    const sheepFwd = new THREE.Vector3();
    const orientSheepAt = (holder: THREE.Group, dir: THREE.Vector3, lookAtDir: THREE.Vector3) => {
      const surf = getWalkableSurface(dir);
      holder.position.copy(surf.position);
      const up = surf.normal;
      sheepFwd.copy(lookAtDir).sub(dir).addScaledVector(up, -lookAtDir.clone().sub(dir).dot(up)).normalize();
      if (sheepFwd.lengthSq() < 1e-4) sheepFwd.set(0, 0, 1);
      const right = new THREE.Vector3().crossVectors(up, sheepFwd).normalize();
      holder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, sheepFwd));
    };

    sheepPairs.forEach((sp) => {
      sp.sheep.curDir.copy(sp.hideDir);
      orientSheepAt(sp.sheep.holder, sp.sheep.curDir, roseDir);
    });

    const RESCUE_DURATION = 4.15;
    let rescueElapsed = -1;

    const roseHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.145, 0.155, 0.34, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    roseHit.position.y = 0.17;
    roseHolder.add(roseHit);

    const roseCtrl = {
      phase: 'stillness',
      timer: 5.0,
      roseSwayTimer: 0,
      triggerRoseCheck() {
        if (rescueElapsed < 0) {
          rescueElapsed = 0;
        }
        this.phase = 'stillness';
        this.timer = 4.5;
        this.roseSwayTimer = 1.6;
      },
      update(dt: number, nightFactor: number) {
        if (rescueElapsed >= 0) {
          rescueElapsed += dt;
          const t = rescueElapsed;

          // 1) Right when tapped: glass pops UP then falls off to the RIGHT side (+Z local / screen right),
          //    clear of the sheep's charge line; then Sable reaches over to it at 2.28s, picks it up & carries it back onto the Rose!
          if (t < 0.48) {
            const p = smoothstep(0.0, 0.48, t);
            const popArc = Math.sin(p * Math.PI) * 0.16;
            bellJarGroup.position.set(
              p * GLASS_FALL_LOCAL.x,
              0.012 + popArc + p * (GLASS_FALL_LOCAL.y - 0.012),
              p * GLASS_FALL_LOCAL.z
            );
            bellJarGroup.rotation.set(p * 1.38, 0, p * 0.14);
          } else if (t < 2.28) {
            bellJarGroup.position.copy(GLASS_FALL_LOCAL);
            bellJarGroup.rotation.set(1.38, 0, 0.14);
          } else if (t < 2.86) {
            // Sable lifts it directly from where it fell on the right & clamps it back over the Rose!
            const p = smoothstep(2.28, 2.86, t);
            const carryArc = Math.sin(p * Math.PI) * 0.19;
            bellJarGroup.position.set(
              THREE.MathUtils.lerp(GLASS_FALL_LOCAL.x, 0, p),
              THREE.MathUtils.lerp(GLASS_FALL_LOCAL.y, 0.012, p) + carryArc,
              THREE.MathUtils.lerp(GLASS_FALL_LOCAL.z, 0, p)
            );
            bellJarGroup.rotation.set(THREE.MathUtils.lerp(1.38, 0, p), 0, THREE.MathUtils.lerp(0.14, 0, p));
          } else {
            const bounce = t < 3.06 ? Math.abs(Math.sin(((t - 2.86) / 0.2) * Math.PI)) * 0.018 : 0;
            bellJarGroup.position.set(0, 0.012 + bounce, 0);
            bellJarGroup.rotation.set(0, 0, 0);
          }

          // 2) Two sheep charge from behind the cactus (0.20..1.38s), nibble the uncovered Rose (1.38..2.45s), & scurry back!
          for (const sp of sheepPairs) {
            const st = Math.max(0, t - sp.lag);
            if (st < 0.20) {
              sp.sheep.curDir.copy(sp.hideDir);
              orientSheepAt(sp.sheep.holder, sp.sheep.curDir, roseDir);
              sp.sheep.body.position.y = Math.abs(Math.sin(t * 14)) * 0.014;
              sp.sheep.head.rotation.x = -0.25;
              sp.sheep.legs.forEach((l) => (l.rotation.x = 0));
            } else if (st < 1.32) {
              const p = smoothstep(0.20, 1.32, st);
              sp.sheep.curDir.copy(sp.hideDir).lerp(sp.biteDir, p).normalize();
              orientSheepAt(sp.sheep.holder, sp.sheep.curDir, roseDir);
              const stride = Math.sin(t * 21 + sp.lag * 8);
              sp.sheep.body.position.y = Math.abs(stride) * 0.028;
              sp.sheep.head.rotation.x = 0.05;
              sp.sheep.legs[0].rotation.x = stride * 0.58;
              sp.sheep.legs[1].rotation.x = stride * 0.58;
              sp.sheep.legs[2].rotation.x = -stride * 0.58;
              sp.sheep.legs[3].rotation.x = -stride * 0.58;
            } else if (st < 2.38) {
              sp.sheep.curDir.copy(sp.biteDir);
              orientSheepAt(sp.sheep.holder, sp.sheep.curDir, roseDir);
              sp.sheep.body.position.y = 0;
              sp.sheep.head.rotation.x = 0.48 + Math.sin((t - 1.32) * 20 + sp.lag * 6) * 0.24;
              flowerHead.rotation.z = Math.sin((t - 1.32) * 24) * 0.2;
              sp.sheep.legs.forEach((l) => (l.rotation.x = 0));
            } else if (st < 2.74) {
              const jumpP = (st - 2.38) / 0.36;
              sp.sheep.curDir.copy(sp.biteDir).lerp(sp.hideDir, jumpP * 0.14).normalize();
              orientSheepAt(sp.sheep.holder, sp.sheep.curDir, roseDir);
              sp.sheep.body.position.y = Math.sin(jumpP * Math.PI) * 0.058;
              sp.sheep.head.rotation.x = -0.36;
            } else {
              const p = smoothstep(2.74, RESCUE_DURATION - 0.12, st);
              sp.sheep.curDir.copy(sp.biteDir).lerp(sp.hideDir, 0.14 + 0.86 * p).normalize();
              orientSheepAt(sp.sheep.holder, sp.sheep.curDir, p < 0.88 ? sp.hideDir : roseDir);
              const stride = Math.sin(t * 25 + sp.lag * 8);
              sp.sheep.body.position.y = p < 0.95 ? Math.abs(stride) * 0.026 : 0;
              sp.sheep.head.rotation.x = 0;
              sp.sheep.legs[0].rotation.x = p < 0.95 ? stride * 0.62 : 0;
              sp.sheep.legs[1].rotation.x = p < 0.95 ? stride * 0.62 : 0;
              sp.sheep.legs[2].rotation.x = p < 0.95 ? -stride * 0.62 : 0;
              sp.sheep.legs[3].rotation.x = p < 0.95 ? -stride * 0.62 : 0;
            }
          }

          // 3) Sable hurries across to where the glass fell on the right (1.72..2.28), picks it up & brings it back over the Rose (2.28..2.86)!
          wateringVessel.position.lerp(new THREE.Vector3(-0.09, 0, 0.06), 0.2);
          wateringVessel.rotation.z = THREE.MathUtils.lerp(wateringVessel.rotation.z, 0, 0.2);
          if (t < 1.72) {
            sable.dir.lerp(sableRestDir, 0.18).normalize();
            sable.faceTowardDir(roseDir, dt, 10.0);
            sable.poseState = t < 0.6 ? 'hop' : 'sit';
            sable.setGlanceToward(glassFallDir);
          } else if (t < 2.28) {
            const goP = smoothstep(1.72, 2.22, t);
            sable.dir.copy(sableRestDir).lerp(sablePickDir, goP).normalize();
            sable.faceTowardDir(glassFallDir, dt, 14.0);
            sable.poseState = goP > 0.72 ? 'help_reach_down' : 'run';
            sable.setGlanceToward(glassFallDir);
          } else if (t < 2.90) {
            const backP = smoothstep(2.28, 2.84, t);
            sable.dir.copy(sablePickDir).lerp(sableRestDir, backP).normalize();
            sable.faceTowardDir(roseDir, dt, 14.0);
            sable.poseState = 'help_reach_down';
            sable.setGlanceToward(roseDir);
          } else {
            sable.dir.lerp(sableRestDir, 0.22).normalize();
            sable.faceTowardDir(roseDir, dt, 10.0);
            sable.poseState = 'sit';
            sable.setGlanceToward(sheepPairs[0].sheep.curDir);
          }

          if (t >= RESCUE_DURATION) {
            rescueElapsed = -1;
            bellJarGroup.position.set(0, 0.012, 0);
            bellJarGroup.rotation.set(0, 0, 0);
            sheepPairs.forEach((sp) => {
              sp.sheep.curDir.copy(sp.hideDir);
              orientSheepAt(sp.sheep.holder, sp.sheep.curDir, roseDir);
              sp.sheep.body.position.y = 0;
              sp.sheep.head.rotation.x = 0;
              sp.sheep.legs.forEach((l) => (l.rotation.x = 0));
            });
            sable.dir.copy(sableRestDir);
            sable.faceTowardDir(roseDir, dt, 12.0);
          }
          return;
        }

        if (this.roseSwayTimer > 0) {
          this.roseSwayTimer -= dt;
          flowerHead.rotation.z = Math.sin(this.roseSwayTimer * 6.5) * 0.14 * (this.roseSwayTimer / 1.6);
        } else {
          flowerHead.rotation.z = Math.sin(engineNow() * 0.0012) * 0.04;
        }

        // Sable naps in the hot midday sun, and wakes at twilight/night to tend the glowing rose
        if (nightFactor < 0.15 && !sable.interrupted) {
          sable.speed = 0;
          sable.poseState = 'sleep';
          wateringVessel.position.lerp(new THREE.Vector3(-0.09, 0, 0.06), 0.15);
          wateringVessel.rotation.z = THREE.MathUtils.lerp(wateringVessel.rotation.z, 0, 0.15);
          return;
        }

        if (sable.interrupted) {
          sable.poseState = 'sit';
          wateringVessel.position.lerp(new THREE.Vector3(-0.09, 0, 0.06), 0.15);
          wateringVessel.rotation.z = THREE.MathUtils.lerp(wateringVessel.rotation.z, 0, 0.15);
          return;
        }

        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.phase === 'stillness') {
            this.phase = 'check_soil';
            this.timer = 2.6;
          } else if (this.phase === 'check_soil') {
            this.phase = 'water';
            this.timer = 3.0;
            this.roseSwayTimer = 2.4;
          } else if (this.phase === 'water') {
            this.phase = 'shelter';
            this.timer = 3.6;
          } else {
            this.phase = 'stillness';
            this.timer = 5.5 + random() * 3.0;
          }
        }

        if (this.phase === 'check_soil') {
          sable.poseState = 'sniff';
          wateringVessel.position.lerp(new THREE.Vector3(-0.09, 0, 0.06), 0.12);
          wateringVessel.rotation.z = THREE.MathUtils.lerp(wateringVessel.rotation.z, 0, 0.12);
        } else if (this.phase === 'water') {
          sable.poseState = 'rose_water';
          wateringVessel.position.lerp(new THREE.Vector3(-0.045, 0.115, 0.02), 0.12);
          wateringVessel.rotation.z = THREE.MathUtils.lerp(wateringVessel.rotation.z, -0.68, 0.12);
        } else if (this.phase === 'shelter') {
          sable.poseState = 'sit';
          wateringVessel.position.lerp(new THREE.Vector3(-0.09, 0, 0.06), 0.12);
          wateringVessel.rotation.z = THREE.MathUtils.lerp(wateringVessel.rotation.z, 0, 0.12);
          sable.glanceYaw = 0.18;
        } else {
          sable.poseState = 'sit';
          wateringVessel.position.lerp(new THREE.Vector3(-0.09, 0, 0.06), 0.12);
          wateringVessel.rotation.z = THREE.MathUtils.lerp(wateringVessel.rotation.z, 0, 0.12);
        }
      },
    };
    const triggerRoseTap = () => {
      sable.poke(roseDir);
      roseCtrl.triggerRoseCheck();
    };
    interactiveProps.push(
      { mesh: roseMesh, onTap: triggerRoseTap },
      { mesh: bellJarGroup, onTap: triggerRoseTap },
      { mesh: roseHit, onTap: triggerRoseTap },
      ...sheepPairs.map((sp) => ({ mesh: sp.sheep.holder, onTap: triggerRoseTap }))
    );
    controllers.push(roseCtrl);
  }

  // SCENE 4: MINK INVESTIGATING MYSTERY BOX (+ Drifting Feather)
  let sharedFeatherEvent: { active: boolean; t: number; dir: THREE.Vector3; mesh: THREE.Mesh } | null = null;
  {
    const boxDir = WORLD_CONFIG.landmarks.mystery.dir;
    const boxHolder = attachOnSurface(planetGroup, boxDir, 0, 0.4);
    const boxMesh = createMysteryBox(mats);
    const boxBaseY = 0.42;
    boxMesh.position.y = boxBaseY;
    boxHolder.add(boxMesh);

    const feather = new THREE.Mesh(
      own(new THREE.ConeGeometry(0.024, 0.11, 5)),
      own(new THREE.MeshStandardMaterial({ color: '#fff2cc', emissive: '#ffcf66', emissiveIntensity: 0.25, roughness: 0.6 }))
    );
    feather.visible = false;
    planetGroup.add(feather);

    const fern = agents.mystery[0];
    let orbitAng = 0.4;
    let phase = 'circle';
    let timer = 3.2;
    let boxCooldown = 0;

    sharedFeatherEvent = { active: false, t: 0, dir: boxDir.clone(), mesh: feather };

    // Mario-style Super Mushroom that pops out of the ? box and lands on Fern to make them grow!
    const mushroomGroup = new THREE.Group();
    const mushStem = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.022, 0.028, 0.042, 10)),
      own(new THREE.MeshStandardMaterial({ color: '#f7ead0', roughness: 0.65 }))
    );
    mushStem.position.y = 0.021;
    mushStem.castShadow = true;
    mushroomGroup.add(mushStem);
    const mushCap = new THREE.Mesh(
      own(new THREE.SphereGeometry(0.048, 12, 10, 0, Math.PI * 2, 0, Math.PI * 0.58)),
      own(new THREE.MeshStandardMaterial({ color: '#e62e25', roughness: 0.32 }))
    );
    mushCap.position.y = 0.036;
    mushCap.castShadow = true;
    mushroomGroup.add(mushCap);
    const spotMat = own(new THREE.MeshStandardMaterial({ color: '#fffdf7', roughness: 0.4 }));
    for (const [sx, sy, sz] of [
      [0, 0.082, 0],
      [0.036, 0.058, 0.015],
      [-0.036, 0.058, 0.015],
      [0.018, 0.058, -0.035],
      [-0.022, 0.058, -0.032],
    ]) {
      const spot = new THREE.Mesh(own(new THREE.SphereGeometry(0.014, 7, 6)), spotMat);
      spot.position.set(sx, sy, sz);
      mushroomGroup.add(spot);
    }
    mushroomGroup.visible = false;
    planetGroup.add(mushroomGroup);

    let mushroomActive = false;
    let mushroomT = 0;
    let superSizeTimer = 0;

    const triggerBoxBounce = () => {
      if (boxCooldown > 0) return;
      boxCooldown = 1.4;
      mushroomActive = true;
      mushroomT = 0;
      mushroomGroup.visible = true;
      fern.poke(boxDir);
      if (sharedFeatherEvent && !sharedFeatherEvent.active) {
        sharedFeatherEvent.active = true;
        sharedFeatherEvent.t = 0;
        feather.visible = true;
      }
    };

    interactiveProps.push({ mesh: boxMesh, onTap: triggerBoxBounce });

    controllers.push({
      update(dt: number) {
        if (boxCooldown > 0) boxCooldown -= dt;
        boxMesh.position.y = boxBaseY;
        boxMesh.rotation.z = 0;

        // Animate Mario Super Mushroom arcing from the ? box onto Fern
        if (mushroomActive) {
          mushroomT += dt * 1.15;
          if (mushroomT >= 1) {
            mushroomActive = false;
            mushroomGroup.visible = false;
            superSizeTimer = 10.5;
            phase = 'hop_react';
            timer = 1.6;
          } else {
            const mDir = new THREE.Vector3().lerpVectors(boxDir, fern.dir, mushroomT).normalize();
            const surfH = getTerrainHeight(mDir);
            const arcAlt = 0.42 * (1 - mushroomT) + Math.sin(mushroomT * Math.PI) * 0.36 + 0.08 * mushroomT;
            mushroomGroup.position.copy(mDir).multiplyScalar(surfH + arcAlt);
            mushroomGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), mDir);
            mushroomGroup.rotateY(mushroomT * 6.0);
          }
        }

        if (superSizeTimer > 0) {
          superSizeTimer -= dt;
          const elapsedSinceHit = 10.5 - superSizeTimer;
          if (elapsedSinceHit < 0.95) {
            // Classic Mario-style pulsing 3-step power-up growth animation!
            const p = elapsedSinceHit / 0.95;
            const pulse = Math.sin(p * Math.PI * 5.0) * (1 - p) * 0.24;
            fern.targetScale = THREE.MathUtils.lerp(fern.baseScale, 1.42, p) + pulse;
          } else if (superSizeTimer > 0) {
            fern.targetScale = 1.38;
          } else {
            fern.targetScale = fern.baseScale;
          }
        }

        if (sharedFeatherEvent && sharedFeatherEvent.active) {
          sharedFeatherEvent.t += dt * 0.14;
          if (sharedFeatherEvent.t >= 1) {
            sharedFeatherEvent.active = false;
            feather.visible = false;
          } else {
            const fDir = new THREE.Vector3()
              .lerpVectors(WORLD_CONFIG.landmarks.mystery.dir, WORLD_CONFIG.landmarks.astro.dir, sharedFeatherEvent.t)
              .normalize();
            sharedFeatherEvent.dir.copy(fDir);
            const altitude = WORLD_CONFIG.planetRadius + 0.35 + Math.sin(sharedFeatherEvent.t * Math.PI) * 0.42;
            feather.position.copy(fDir).multiplyScalar(altitude);
            feather.rotation.set(sharedFeatherEvent.t * 5, sharedFeatherEvent.t * 7, Math.sin(sharedFeatherEvent.t * 10) * 0.5);
          }
        }

        timer -= dt;
        if (timer <= 0) {
          if (phase === 'circle') {
            phase = 'tap_listen';
            timer = 2.8;
          } else if (phase === 'tap_listen') {
            phase = 'scurry_other_side';
            timer = 2.2;
          } else if (phase === 'scurry_other_side') {
            if (random() < 0.45 && sharedFeatherEvent && !sharedFeatherEvent.active) {
              sharedFeatherEvent.active = true;
              sharedFeatherEvent.t = 0;
              feather.visible = true;
              phase = 'hop_react';
              timer = 1.8;
            } else {
              phase = 'tap_listen';
              timer = 2.6;
            }
          } else {
            phase = 'circle';
            timer = 3.2;
          }
        }

        const up = boxDir.clone();
        const ref = new THREE.Vector3(0, 1, 0);
        const right = new THREE.Vector3().crossVectors(up, ref).normalize();
        const fwd = new THREE.Vector3().crossVectors(right, up).normalize();
        const safeOrbitRadius = 0.165;

        if (phase === 'circle' || phase === 'scurry_other_side') {
          orbitAng += (phase === 'scurry_other_side' ? 1.55 : 0.72) * dt;
          const lookAhead = orbitAng + 0.28;
          const tgt = boxDir
            .clone()
            .addScaledVector(right, Math.cos(lookAhead) * safeOrbitRadius)
            .addScaledVector(fwd, Math.sin(lookAhead) * safeOrbitRadius)
            .normalize();
          fern.faceTowardDir(tgt, dt, 6.8);
          fern.speed = phase === 'scurry_other_side' ? 0.34 : 0.22;
          fern.poseState = 'walk';
          fern.moveAlongSphere(dt);
        } else if (phase === 'tap_listen') {
          fern.faceTowardDir(boxDir, dt, 6.0);
          fern.speed = 0;
          fern.poseState = 'sniff';
          fern.glanceYaw = 0.25;
        } else {
          fern.faceTowardDir(boxDir, dt, 6.0);
          fern.speed = 0;
          fern.poseState = 'hop';
        }
      },
    });
  }

  // SCENE 5: ASTRONOMER OBSERVING SKY & TAKING NOTES
  {
    const astroDir = WORLD_CONFIG.landmarks.astro.dir;
    const astroHolder = attachOnSurface(planetGroup, astroDir, 0, -0.4);
    const { group: astroProps, barrelPivot, notebookGroup } = createTelescopeAndDesk(mats);
    astroProps.scale.setScalar(1.32);
    astroHolder.add(astroProps);

    // Miniature brass desk lamp that switches on at night when Oriel stargazes
    const astroLampMat = own(new THREE.MeshStandardMaterial({
      color: '#ffebb8',
      emissive: '#ffc459',
      emissiveIntensity: 0.05,
      roughness: 0.25,
    }));
    const astroLampPost = new THREE.Mesh(own(new THREE.CylinderGeometry(0.005, 0.008, 0.09, 6)), mats.brass);
    astroLampPost.position.set(0.24, 0.17, -0.06);
    astroHolder.add(astroLampPost);
    const astroLampShade = new THREE.Mesh(own(new THREE.ConeGeometry(0.028, 0.035, 8)), astroLampMat);
    astroLampShade.position.set(0.24, 0.22, -0.06);
    astroHolder.add(astroLampShade);
    const astroLampLight = new THREE.PointLight('#ffd27a', 0, 1.05, 1.8);
    astroLampLight.position.set(0.24, 0.23, -0.06);
    astroHolder.add(astroLampLight);

    const oriel = agents.astro[0];
    // Position Oriel directly behind the scaled telescope eyepiece in astroHolder's exact frame
    const eyepieceSeatLocal = new THREE.Vector3(0.0, 0.0, -0.32);
    const seatWorld = eyepieceSeatLocal.clone().applyQuaternion(astroHolder.quaternion).add(astroHolder.position);
    oriel.dir.copy(seatWorld).normalize();
    const toScope = astroDir.clone().sub(oriel.dir);
    toScope.addScaledVector(oriel.dir, -toScope.dot(oriel.dir)).normalize();
    oriel.forward.copy(toScope);
    oriel.syncTransform();
    oriel.poseState = 'astro_look';

    const astroCtrl = {
      phase: 'observe',
      timer: 4.0,
      pendingTapLook: false,
      onTap() {
        if (this.phase === 'write') {
          this.pendingTapLook = true;
          scheduleTimeout(() => {
            if (this.pendingTapLook) {
              oriel.poke();
              this.pendingTapLook = false;
            }
          }, 550);
        } else {
          oriel.poke();
        }
      },
      update(dt: number, nightFactor: number) {
        // Astronomer's brass desk lamp turns on at dusk/night
        astroLampMat.emissiveIntensity = 0.08 + nightFactor * 0.9;
        astroLampLight.intensity = nightFactor * 0.9;

        // Oriel is twilight-to-night active: sleeps only in bright midday sun
        if (nightFactor < 0.15 && !oriel.interrupted) {
          oriel.poseState = 'sleep';
          oriel.speed = 0;
          return;
        }

        if (sharedFeatherEvent && sharedFeatherEvent.active && sharedFeatherEvent.t > 0.55) {
          oriel.setGlanceToward(sharedFeatherEvent.dir);
          oriel.poseState = 'astro_ponder';
          return;
        }

        if (oriel.interrupted) {
          oriel.poseState = 'sit';
          return;
        }

        this.timer -= dt;
        if (this.timer <= 0) {
          if (this.phase === 'observe') {
            this.phase = 'write';
            this.timer = 3.8;
          } else if (this.phase === 'write') {
            this.phase = 'ponder';
            this.timer = 2.6;
          } else {
            this.phase = 'observe';
            this.timer = 4.4;
          }
        }

        if (this.phase === 'observe') {
          oriel.poseState = 'astro_look';
          barrelPivot.rotation.x = -0.52 + Math.sin(engineNow() * 0.001) * 0.03;
          notebookGroup.rotation.y = THREE.MathUtils.lerp(notebookGroup.rotation.y, 0, 0.12);
        } else if (this.phase === 'write') {
          oriel.poseState = 'astro_write';
          oriel.glanceYaw = -0.35;
          notebookGroup.rotation.y = THREE.MathUtils.lerp(notebookGroup.rotation.y, 0, 0.12);
        } else {
          oriel.poseState = 'astro_ponder';
          notebookGroup.rotation.y = THREE.MathUtils.lerp(notebookGroup.rotation.y, 0.65, 0.08);
        }
      },
    };
    interactiveProps.push({
      mesh: astroProps,
      onTap: () => astroCtrl.onTap(),
    });
    controllers.push(astroCtrl);
  }

  // SCENE 6: SOLO MINK PLAYING WITH WILSON (CAST AWAY VOLLEYBALL)
  {
    const ballCenter = WORLD_CONFIG.landmarks.ball.dir;

    // Painted Wilson volleyball texture (weathered off-white, seams, red handprint face)
    const ballCanvas = document.createElement('canvas');
    ballCanvas.width = 128;
    ballCanvas.height = 64;
    const bctx = ballCanvas.getContext('2d')!;
    // Off-white weathered leather base
    bctx.fillStyle = '#f2ece1';
    bctx.fillRect(0, 0, 128, 64);
    // Subtle volleyball panel seams
    bctx.strokeStyle = '#c8bfb0';
    bctx.lineWidth = 1.5;
    for (let x = 16; x < 128; x += 32) {
      bctx.beginPath();
      bctx.moveTo(x, 0);
      bctx.lineTo(x, 64);
      bctx.stroke();
    }
    bctx.beginPath();
    bctx.moveTo(0, 32);
    bctx.lineTo(128, 32);
    bctx.stroke();
    // Reddish-brown handprint face on the front
    bctx.fillStyle = '#9e2b22';
    bctx.beginPath();
    bctx.ellipse(64, 34, 15, 16, 0, 0, Math.PI * 2);
    bctx.fill();
    // Spiky palm/hair fingers at top of handprint
    for (const [fx, fy, fw, fh] of [
      [51, 13, 4, 12],
      [57, 10, 4, 14],
      [63, 9, 4, 15],
      [69, 10, 4, 14],
      [75, 14, 4, 11],
    ]) {
      bctx.fillRect(fx, fy, fw, fh);
    }
    // Wilson's eyes & nose/mouth cutouts
    bctx.fillStyle = '#f2ece1';
    bctx.beginPath();
    bctx.arc(58, 31, 3.2, 0, Math.PI * 2);
    bctx.arc(70, 31, 3.2, 0, Math.PI * 2);
    bctx.fill();
    bctx.fillStyle = '#3b1512';
    bctx.beginPath();
    bctx.arc(58.5, 31, 1.3, 0, Math.PI * 2);
    bctx.arc(69.5, 31, 1.3, 0, Math.PI * 2);
    bctx.fill();
    // Frown / mouth line
    bctx.strokeStyle = '#f2ece1';
    bctx.lineWidth = 2;
    bctx.beginPath();
    bctx.arc(64, 43, 5.5, Math.PI * 1.15, Math.PI * 1.85);
    bctx.stroke();

    const ballTex = own(new THREE.CanvasTexture(ballCanvas));
    ballTex.colorSpace = THREE.SRGBColorSpace;
    const ballRadius = 0.082;
    const ballMesh = new THREE.Mesh(
      own(new THREE.SphereGeometry(ballRadius, 16, 12)),
      own(new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.45, metalness: 0.04 }))
    );
    ballMesh.castShadow = true;
    ballMesh.receiveShadow = true;
    planetGroup.add(ballMesh);

    const [maple] = agents.ball;
    placeAtLandmark(maple, ballCenter, -0.10, 0.06, true);

    const upB = ballCenter.clone().normalize();
    const refB = Math.abs(upB.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const rightB = new THREE.Vector3().crossVectors(upB, refB).normalize();
    const fwdB = new THREE.Vector3().crossVectors(rightB, upB).normalize();

    const CLEARING_RADIUS = 0.24;
    const minAlt = ballRadius + 0.002;

    // Represent ball position & velocity in clean local clearing coordinates (bx, bz) in radians
    // mapped onto the planet sphere via exact exponential map (never drifts, never teleports, never NaNs).
    let bx = 0.08;
    let bz = -0.05;
    let vx = -0.18;
    let vz = 0.12;
    let ballAlt = minAlt;
    let ballAltVel = 0.32;

    let mapleState: 'chase' | 'watch' = 'watch';
    let watchTimer = 0.45;
    let quietTimer = 0;

    const ballDir = new THREE.Vector3();
    const _targetDir = new THREE.Vector3();
    const _tangentVel = new THREE.Vector3();
    const _rollAxis = new THREE.Vector3();
    const _rollQuat = new THREE.Quaternion();

    const diskToDir = (x: number, z: number, out: THREE.Vector3) => {
      const r = Math.hypot(x, z);
      if (r < 1e-6) {
        out.copy(ballCenter);
        return;
      }
      const s = Math.sin(r) / r;
      out
        .copy(ballCenter)
        .multiplyScalar(Math.cos(r))
        .addScaledVector(rightB, x * s)
        .addScaledVector(fwdB, z * s)
        .normalize();
    };

    const dirToDisk = (dir: THREE.Vector3): [number, number] => {
      const cosA = THREE.MathUtils.clamp(dir.dot(ballCenter), -1, 1);
      const angle = Math.acos(cosA);
      if (angle < 1e-6) return [0, 0];
      const px = dir.dot(rightB);
      const pz = dir.dot(fwdB);
      const plen = Math.hypot(px, pz);
      if (plen < 1e-6) return [0, 0];
      const scale = angle / plen;
      return [px * scale, pz * scale];
    };

    const launchBall = (kx: number, kz: number, speed: number, upVel: number) => {
      const len = Math.hypot(kx, kz);
      let ux = len > 1e-6 ? kx / len : 1;
      let uz = len > 1e-6 ? kz / len : 0;

      // Bias kicks inward whenever near the clearing rim so Wilson arcs across open grass
      const r = Math.hypot(bx, bz);
      if (r > CLEARING_RADIUS * 0.55) {
        const ix = -bx / r;
        const iz = -bz / r;
        const mixX = ux * 0.35 + ix * 0.65;
        const mixZ = uz * 0.35 + iz * 0.65;
        const mLen = Math.hypot(mixX, mixZ);
        if (mLen > 1e-6) {
          ux = mixX / mLen;
          uz = mixZ / mLen;
        }
      }

      const jitter = (random() - 0.5) * 0.52;
      const c = Math.cos(jitter);
      const s = Math.sin(jitter);
      vx = (ux * c - uz * s) * speed;
      vz = (ux * s + uz * c) * speed;
      ballAltVel = upVel;
      quietTimer = 0;
    };

    diskToDir(bx, bz, ballDir);
    ballMesh.position.copy(ballDir).multiplyScalar(getRenderedTerrainHeight(ballDir) + ballAlt);

    const ballHit = new THREE.Mesh(
      own(new THREE.SphereGeometry(0.165, 8, 6)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    ballMesh.add(ballHit);

    const triggerBallHit = () => {
      const [mx, mz] = dirToDisk(maple.dir);
      launchBall(bx - mx, bz - mz, 0.42, 0.78);
      mapleState = 'watch';
      watchTimer = 1.05;
      maple.poke(ballDir);
    };

    interactiveProps.push(
      { mesh: ballMesh, onTap: triggerBallHit },
      { mesh: ballHit, onTap: triggerBallHit }
    );

    controllers.push({
      update(dt: number, nightFactor: number) {
        // 1. Integrate ball motion inside the open circular clearing
        const isAirborne = ballAlt > minAlt + 0.006;
        bx += vx * dt;
        bz += vz * dt;

        const drag = Math.exp(-(isAirborne ? 0.16 : 1.1) * dt);
        vx *= drag;
        vz *= drag;

        // Clamp speed for stability
        const speed = Math.hypot(vx, vz);
        if (speed > 0.58) {
          const s = 0.58 / speed;
          vx *= s;
          vz *= s;
        }

        // Clean elastic bounce off the circular clearing boundary (never teleports)
        const r = Math.hypot(bx, bz);
        if (r > CLEARING_RADIUS) {
          const nx = bx / r;
          const nz = bz / r;
          bx = nx * CLEARING_RADIUS;
          bz = nz * CLEARING_RADIUS;
          const vRad = vx * nx + vz * nz;
          if (vRad > 0) {
            vx -= 1.68 * vRad * nx;
            vz -= 1.68 * vRad * nz;
          }
        }

        // Vertical gravity bounce resting flush on the rendered faceted terrain
        ballAltVel -= 2.45 * dt;
        ballAlt += ballAltVel * dt;
        if (ballAlt < minAlt) {
          ballAlt = minAlt;
          if (ballAltVel < -0.14) {
            ballAltVel = -ballAltVel * 0.56;
            vx *= 0.92;
            vz *= 0.92;
          } else {
            ballAltVel = 0;
          }
        }

        diskToDir(bx, bz, ballDir);
        const surfH = getRenderedTerrainHeight(ballDir);
        ballMesh.position.copy(ballDir).multiplyScalar(surfH + ballAlt);

        // Roll ball smoothly around axis perpendicular to tangent velocity
        const rollSpeed = Math.hypot(vx, vz);
        if (rollSpeed > 0.002) {
          _tangentVel.copy(rightB).multiplyScalar(vx).addScaledVector(fwdB, vz);
          _tangentVel.addScaledVector(ballDir, -_tangentVel.dot(ballDir));
          _rollAxis.crossVectors(ballDir, _tangentVel);
          if (_rollAxis.lengthSq() > 1e-8) {
            _rollAxis.normalize();
            const rollAngle = (rollSpeed * WORLD_CONFIG.planetRadius * dt) / ballRadius;
            _rollQuat.setFromAxisAngle(_rollAxis, rollAngle);
            ballMesh.quaternion.premultiply(_rollQuat);
          }
        }

        // 2. At night Maple curls up to sleep beside Wilson
        if (nightFactor > 0.72 && !maple.interrupted) {
          maple.speed = 0;
          maple.poseState = 'sleep';
          quietTimer = 0;
          return;
        }

        // Keep Maple smoothly inside the clearing disk
        let [mx, mz] = dirToDisk(maple.dir);
        const mr = Math.hypot(mx, mz);
        if (mr > CLEARING_RADIUS + 0.03) {
          const clampScale = (CLEARING_RADIUS + 0.03) / mr;
          mx *= clampScale;
          mz *= clampScale;
          diskToDir(mx, mz, maple.dir);
        }

        const dx = bx - mx;
        const dz = bz - mz;
        const distToBall = Math.hypot(dx, dz);

        // Gentle watchdog: if the ball ever stays still for >3.5s, bounce it playfully toward center
        if (rollSpeed < 0.025 && ballAlt <= minAlt + 0.004) {
          quietTimer += dt;
          if (quietTimer >= 3.5) {
            launchBall(-bx + 0.02, -bz + 0.01, 0.34, 0.68);
            mapleState = 'watch';
            watchTimer = 0.5;
          }
        } else {
          quietTimer = 0;
        }

        // 3. Clean two-state Maple play behavior: 'watch' (after kick/tap) -> 'chase' -> kick
        if (mapleState === 'watch') {
          watchTimer -= dt;
          maple.faceTowardDir(ballDir, dt, 6.2);
          maple.speed = THREE.MathUtils.lerp(maple.speed, 0, 1 - Math.exp(-10.0 * dt));
          maple.poseState = 'idle';

          // Elastic rebound if Wilson bounces back into Maple while Maple is watching
          if (distToBall < 0.072 && ballAlt < minAlt + 0.12) {
            const nx = distToBall > 1e-5 ? dx / distToBall : 1;
            const nz = distToBall > 1e-5 ? dz / distToBall : 0;
            bx = mx + nx * 0.074;
            bz = mz + nz * 0.074;
            const vRad = vx * nx + vz * nz;
            if (vRad < 0) {
              vx -= 1.45 * vRad * nx;
              vz -= 1.45 * vRad * nz;
            }
            diskToDir(bx, bz, ballDir);
            ballMesh.position.copy(ballDir).multiplyScalar(getRenderedTerrainHeight(ballDir) + ballAlt);
          }

          if (watchTimer <= 0) {
            mapleState = 'chase';
          }
        } else {
          if (distToBall < 0.082 && ballAlt < minAlt + 0.14) {
            launchBall(dx, dz, 0.34 + random() * 0.09, 0.48 + random() * 0.16);
            mapleState = 'watch';
            watchTimer = 0.68;
            maple.speed = 0;
          } else {
            let tx = bx;
            let tz = bz;
            if (r > 0.15 && distToBall > 0.095) {
              const outR = Math.min(CLEARING_RADIUS, r + 0.055) / r;
              tx = bx * outR;
              tz = bz * outR;
            }
            diskToDir(tx, tz, _targetDir);
            maple.faceTowardDir(_targetDir, dt, 6.8);
            const desiredSpeed = distToBall > 0.12 ? 0.44 : 0.28;
            maple.speed = THREE.MathUtils.lerp(maple.speed, desiredSpeed, 1 - Math.exp(-6.5 * dt));
            maple.poseState = maple.speed > 0.31 ? 'run' : 'walk';
            maple.moveAlongSphere(dt);
          }
        }

        maple.setGlanceToward(ballDir);
      },
    });
  }

  // SCENE 7: THERE WILL BE BLOOD DESERT OIL DERRICK (Tap to ignite!)
  {
    const derrickDir = WORLD_CONFIG.landmarks.derrick.dir;
    const derrickHolder = attachOnSurface(planetGroup, derrickDir, -0.025, 0.25);
    const {
      group: derrickMesh,
      beamPivot,
      pumpRod,
      fireGroup,
      flameMain,
      flameCore,
      blastSphere,
      embers,
      smokePuffs,
    } = createOilDerrick(mats);
    derrickMesh.scale.setScalar(1.65);
    derrickHolder.add(derrickMesh);

    const daniel = agents.derrick[0];
    placeAtLandmark(daniel, derrickDir, 0.03, 0.22, true);
    daniel.poseState = 'sit';

    let fireTimer = 0;
    let blastElapsed = 99;
    let pumpPhase = 0;

    interactiveProps.push({
      mesh: derrickMesh,
      onTap: () => {
        fireTimer = 9.0;
        blastElapsed = 0;
        fireGroup.visible = true;
        blastSphere.visible = true;
        daniel.poke(derrickDir);
      },
    });

    controllers.push({
      update(dt: number) {
        pumpPhase += dt * (fireTimer > 0 ? 4.8 : 2.1);
        const rock = Math.sin(pumpPhase);
        beamPivot.rotation.z = rock * 0.26;
        pumpRod.position.y = 0.11 - rock * 0.042;

        if (fireTimer > 0) {
          fireTimer -= dt;
          blastElapsed += dt;
          fireGroup.visible = true;

          // Dramatic initial gusher fireball & flying embers (first 0.9s)
          if (blastElapsed < 0.9) {
            const bt = blastElapsed / 0.9;
            blastSphere.visible = true;
            const s = 0.4 + Math.sin(bt * Math.PI) * 1.95;
            blastSphere.scale.setScalar(s);
            blastSphere.position.y = 0.26 + bt * 0.55;
            (blastSphere.material as THREE.MeshStandardMaterial).opacity = (1 - bt) * 0.92;

            embers.forEach((ember, idx) => {
              ember.visible = true;
              const ang = (idx / embers.length) * Math.PI * 2 + 0.3;
              const spread = bt * 0.52;
              ember.position.set(
                Math.cos(ang) * spread,
                0.28 + bt * 0.85 - bt * bt * 0.45,
                Math.sin(ang) * spread
              );
              ember.scale.setScalar(1 - bt * 0.7);
            });
          } else {
            blastSphere.visible = false;
            embers.forEach((e) => {
              e.visible = false;
            });
          }

          const intensity = Math.min(1, fireTimer / 1.4);
          const f1 = (0.95 + Math.sin(engineNow() * 0.02) * 0.24) * intensity;
          const f2 = (0.92 + Math.cos(engineNow() * 0.028) * 0.26) * intensity;
          flameMain.scale.set(1.0 + Math.sin(engineNow() * 0.016) * 0.14, f1, 1.0);
          flameCore.scale.set(0.95, f2, 0.95);
          smokePuffs.forEach((puff, idx) => {
            const cycle = (engineNow() * 0.00075 + idx * 0.2) % 1;
            puff.position.y = 0.75 + cycle * 0.65;
            puff.position.x = Math.sin(cycle * 6 + idx) * 0.08;
            puff.position.z = Math.cos(cycle * 5 + idx) * 0.06;
            puff.scale.setScalar((0.8 + cycle * 1.1) * intensity);
          });

          // Daniel Plainview celebrates the gusher!
          daniel.faceTowardDir(derrickDir, dt, 6.0);
          daniel.poseState = fireTimer > 3.5 ? 'hop' : 'sit';
          daniel.glancePitch = -0.45;
          daniel.glanceYaw = Math.sin(engineNow() * 0.009) * 0.4;
        } else {
          fireGroup.visible = false;
          blastSphere.visible = false;
          daniel.faceTowardDir(derrickDir, dt, 4.0);
          daniel.poseState = 'sit';
        }
      },
    });
  }

  // SCENE 8: 2001: A SPACE ODYSSEY MONOLITH (Two worshipping minks + tool on ground + Dawn of Man sequence!)
  {
    const monoDir = WORLD_CONFIG.landmarks.monolith.dir;
    const monoHolder = attachOnSurface(planetGroup, monoDir, -0.01, 0.4);

    // Classic 1 : 4 : 9 pure black obsidian monolith (no white/gold flash on tap)
    const monoMat = own(new THREE.MeshStandardMaterial({
      color: '#0c0d11',
      roughness: 0.14,
      metalness: 0.38,
    }));
    const monoMesh = new THREE.Mesh(own(new THREE.BoxGeometry(0.285, 0.63, 0.068)), monoMat);
    monoMesh.position.y = 0.315;
    monoMesh.castShadow = true;
    monoMesh.receiveShadow = true;
    monoHolder.add(monoMesh);

    // Use monoHolder's yaw-rotated unit-sphere tangent frame so both minks keep spacious distance from the obelisk AND the tool sits dead center between them!
    monoHolder.updateMatrixWorld(true);
    const monoRight = new THREE.Vector3(1, 0, 0).applyQuaternion(monoHolder.quaternion).normalize();
    const monoFwd = new THREE.Vector3(0, 0, 1).applyQuaternion(monoHolder.quaternion).normalize();
    const getMonoSpot = (rRad: number, fRad: number) =>
      monoDir.clone().addScaledVector(monoRight, rRad).addScaledVector(monoFwd, fRad).normalize();

    const placeOnDirFacing = (agent: MinkAgent, spotDir: THREE.Vector3, lookDir: THREE.Vector3) => {
      agent.dir.copy(spotDir);
      const toLook = lookDir.clone().sub(spotDir);
      toLook.addScaledVector(spotDir, -toLook.dot(spotDir)).normalize();
      agent.forward.copy(toLook);
      agent.syncTransform();
    };

    const [dave, moonwatcher] = agents.monolith;
    const daveSpot = getMonoSpot(-0.16, 0.34);
    const moonSpot = getMonoSpot(0.16, 0.34);
    const centerSpot = getMonoSpot(0.0, 0.34);
    placeOnDirFacing(dave, daveSpot, monoDir);
    placeOnDirFacing(moonwatcher, moonSpot, monoDir);

    // Prehistoric Dawn of Man bone/stone tool — ALREADY resting directly between them on the curved ground surface!
    const toolGroup = new THREE.Group();
    const boneMat = own(new THREE.MeshStandardMaterial({ color: '#ece3cf', roughness: 0.62, flatShading: true }));
    const stoneHeadMat = own(new THREE.MeshStandardMaterial({ color: '#78736a', roughness: 0.88, flatShading: true }));
    const boneShaft = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.013, 0.22, 6)), boneMat);
    boneShaft.position.y = 0.11;
    boneShaft.castShadow = true;
    toolGroup.add(boneShaft);
    const knobA = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.023, 0)), stoneHeadMat);
    knobA.position.set(0.008, 0.22, 0);
    knobA.castShadow = true;
    toolGroup.add(knobA);
    const knobB = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.018, 0)), boneMat);
    knobB.position.set(-0.007, 0.205, 0.004);
    toolGroup.add(knobB);

    const toolSurf = getWalkableSurface(centerSpot);
    const placeToolOnGround = () => {
      planetGroup.add(toolGroup);
      toolGroup.position.copy(toolSurf.position).addScaledVector(toolSurf.normal, 0.024);
      const upT = toolSurf.normal.clone();
      const fwdT = monoFwd.clone().addScaledVector(upT, -monoFwd.dot(upT)).normalize();
      const rightT = new THREE.Vector3().crossVectors(upT, fwdT).normalize();
      const basis = new THREE.Matrix4().makeBasis(rightT, upT, fwdT);
      toolGroup.quaternion.setFromRotationMatrix(basis);
      toolGroup.rotateX(Math.PI * 0.48);
      toolGroup.rotateZ(0.32);
      toolGroup.scale.setScalar(1.0);
      toolGroup.visible = true;
    };
    placeToolOnGround();

    type MonoSeqState = 'worship' | 'approach_tool' | 'approach_target' | 'windup_strike' | 'play_dead' | 'return_tool';
    let seqState: MonoSeqState = 'worship';
    let seqTimer = 0;
    let toolPickedUp = false;
    let toolDropped = false;
    const STRIKE_MIN_DIST = 0.215; // keeps a clean non-overlapping gap between Dave & Moonwatcher during the hit

    const triggerMonolithSequence = () => {
      if (seqState !== 'worship') return;
      seqState = 'approach_tool';
      seqTimer = 0;
      toolPickedUp = false;
      toolDropped = false;
    };

    dave.onTap = triggerMonolithSequence;
    moonwatcher.onTap = triggerMonolithSequence;

    const monoHit = new THREE.Mesh(
      own(new THREE.BoxGeometry(0.4, 0.72, 0.24)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    monoHit.position.y = 0.34;
    monoHolder.add(monoHit);

    interactiveProps.push(
      { mesh: monoMesh, onTap: triggerMonolithSequence },
      { mesh: monoHit, onTap: triggerMonolithSequence },
      { mesh: toolGroup, onTap: triggerMonolithSequence }
    );

    const enforceStrikeSpacing = () => {
      const d = dave.dir.angleTo(moonwatcher.dir);
      if (d < STRIKE_MIN_DIST - 0.01 && d > 1e-5) {
        const back = dave.dir.clone().sub(moonwatcher.dir);
        back.addScaledVector(dave.dir, -back.dot(dave.dir)).normalize();
        dave.dir.copy(moonwatcher.dir).addScaledVector(back, STRIKE_MIN_DIST).normalize();
      }
    };

    controllers.push({
      update(dt: number) {
        if (seqState === 'worship') {
          const dErr = dave.dir.angleTo(daveSpot);
          if (dErr > 0.015) {
            dave.faceTowardDir(daveSpot, dt, 6.0);
            dave.speed = 0.24;
            dave.poseState = 'walk';
            dave.moveAlongSphere(dt);
          } else {
            dave.faceTowardDir(monoDir, dt, 6.5);
            dave.speed = 0;
            dave.poseState = 'worship';
            dave.setGlanceToward(monoDir);
          }

          const mErr = moonwatcher.dir.angleTo(moonSpot);
          if (mErr > 0.015) {
            moonwatcher.faceTowardDir(moonSpot, dt, 6.0);
            moonwatcher.speed = 0.24;
            moonwatcher.poseState = 'walk';
            moonwatcher.moveAlongSphere(dt);
          } else {
            moonwatcher.faceTowardDir(monoDir, dt, 6.5);
            moonwatcher.speed = 0;
            moonwatcher.poseState = 'worship';
            moonwatcher.setGlanceToward(monoDir);
          }
          return;
        }

        seqTimer += dt;

        if (seqState === 'approach_tool') {
          // Step 1: Dave walks directly to the midpoint where the tool sits and picks it up in place
          const distCenter = dave.dir.angleTo(centerSpot);
          if (!toolPickedUp && distCenter > 0.028 && seqTimer < 2.2) {
            dave.faceTowardDir(centerSpot, dt, 7.5);
            dave.speed = 0.28;
            dave.poseState = 'walk';
            dave.moveAlongSphere(dt);
          } else {
            dave.speed = 0;
            dave.poseState = 'sniff';
            if (!toolPickedUp) {
              toolPickedUp = true;
              dave.rig.propAnchor.add(toolGroup);
              toolGroup.position.set(0.024, 0.01, 0.015);
              toolGroup.rotation.set(0.35, 0, -0.18);
              toolGroup.scale.setScalar(1.0);
              seqTimer = 0;
            } else if (seqTimer > 0.3) {
              seqState = 'approach_target';
              seqTimer = 0;
            }
          }
          moonwatcher.faceTowardDir(dave.dir, dt, 6.0);
          moonwatcher.speed = 0;
          moonwatcher.poseState = 'confused';
        } else if (seqState === 'approach_target') {
          // Step 2: Dave stops well back (STRIKE_MIN_DIST = 0.215 rad) so heads & bodies never overlap on hit
          const distM = dave.dir.angleTo(moonwatcher.dir);
          dave.faceTowardDir(moonwatcher.dir, dt, 8.5);
          moonwatcher.faceTowardDir(dave.dir, dt, 6.5);
          moonwatcher.speed = 0;
          moonwatcher.poseState = 'confused';

          if (distM > STRIKE_MIN_DIST && seqTimer < 2.0) {
            dave.speed = 0.26;
            dave.poseState = 'walk';
            dave.moveAlongSphere(dt);
          } else {
            enforceStrikeSpacing();
            dave.speed = 0;
            seqState = 'windup_strike';
            seqTimer = 0;
          }
        } else if (seqState === 'windup_strike') {
          // Step 3: Dave winds up and swings down — Moonwatcher ONLY flips after the strike lands
          enforceStrikeSpacing();
          dave.faceTowardDir(moonwatcher.dir, dt, 8.0);
          dave.speed = 0;
          moonwatcher.faceTowardDir(dave.dir, dt, 6.5);
          moonwatcher.speed = 0;

          if (seqTimer < 0.48) {
            dave.poseState = 'windup';
            toolGroup.rotation.x = THREE.MathUtils.lerp(toolGroup.rotation.x, -0.45, Math.min(1, dt * 10));
            moonwatcher.poseState = 'confused';
          } else {
            dave.poseState = 'strike';
            toolGroup.rotation.x = THREE.MathUtils.lerp(toolGroup.rotation.x, 1.05, Math.min(1, dt * 18));
            moonwatcher.poseState = seqTimer >= 0.66 ? 'play_dead' : 'confused';
          }

          if (seqTimer >= 1.05) {
            seqState = 'play_dead';
            seqTimer = 0;
          }
        } else if (seqState === 'play_dead') {
          // Step 4: Moonwatcher lies flat on their back playing dead for ~1.6 seconds
          enforceStrikeSpacing();
          dave.faceTowardDir(moonwatcher.dir, dt, 6.0);
          dave.speed = 0;
          dave.poseState = 'idle';
          toolGroup.rotation.x = THREE.MathUtils.lerp(toolGroup.rotation.x, 0.3, Math.min(1, dt * 8));
          moonwatcher.speed = 0;
          moonwatcher.poseState = 'play_dead';

          if (seqTimer >= 1.65) {
            seqState = 'return_tool';
            seqTimer = 0;
          }
        } else if (seqState === 'return_tool') {
          // Step 5: Moonwatcher rolls back up; Dave sets the tool right back between them and both resume worship
          if (seqTimer < 0.55) {
            moonwatcher.speed = 0;
            moonwatcher.poseState = 'hop';
            moonwatcher.faceTowardDir(monoDir, dt, 6.0);
          } else {
            const mErr = moonwatcher.dir.angleTo(moonSpot);
            if (mErr > 0.025) {
              moonwatcher.faceTowardDir(moonSpot, dt, 6.5);
              moonwatcher.speed = 0.24;
              moonwatcher.poseState = 'walk';
              moonwatcher.moveAlongSphere(dt);
            } else {
              moonwatcher.faceTowardDir(monoDir, dt, 6.5);
              moonwatcher.speed = 0;
              moonwatcher.poseState = 'worship';
            }
          }

          if (!toolDropped) {
            const dCenter = dave.dir.angleTo(centerSpot);
            if (dCenter > 0.028 && seqTimer < 2.2) {
              dave.faceTowardDir(centerSpot, dt, 6.5);
              dave.speed = 0.26;
              dave.poseState = 'walk';
              dave.moveAlongSphere(dt);
            } else {
              toolDropped = true;
              placeToolOnGround();
            }
          } else {
            const dErr = dave.dir.angleTo(daveSpot);
            if (dErr > 0.025) {
              dave.faceTowardDir(daveSpot, dt, 6.5);
              dave.speed = 0.24;
              dave.poseState = 'walk';
              dave.moveAlongSphere(dt);
            } else {
              dave.faceTowardDir(monoDir, dt, 6.5);
              dave.speed = 0;
              dave.poseState = 'worship';
            }
          }

          if (
            toolDropped &&
            seqTimer > 0.65 &&
            dave.dir.angleTo(daveSpot) <= 0.03 &&
            moonwatcher.dir.angleTo(moonSpot) <= 0.03
          ) {
            seqState = 'worship';
          }
        }
      },
    });
  }

  // SCENE 9: DUNE THUMPER & GIANT SANDWORM (Dynamic wind-swept crescent dunes & compact Fremen thumper)
  {
    const thumperDir = WORLD_CONFIG.landmarks.thumper.dir;
    const thumperHolder = attachOnSurface(planetGroup, thumperDir, -0.015, 0.25);

    const duneSandMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#c89f68', roughness: 0.96, flatShading: true })), 0.34, 5.0);
    const duneCrestMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#d7b07a', roughness: 0.96, flatShading: true })), 0.34, 5.0);
    const duneRimMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#a66846', roughness: 0.96, flatShading: true })), 0.34, 5.0);
    const dryScrubMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#8f8953', roughness: 0.96, flatShading: true })), 0.34, 5.0);

    // Wind-aligned crescent barchan sand dune waves fanning dynamically across the desert basin
    const WIND_YAW = -0.48;
    const buildCrescentDune = (len: number, h: number, w: number, x: number, z: number, yawBias = 0) => {
      const dune = new THREE.Group();
      dune.position.set(x, -0.016, z);
      dune.rotation.y = WIND_YAW + yawBias;
      // Asymmetric prism crest with sharper wind-carved slip face
      const crestGeo = own(new THREE.ConeGeometry(w, len, 4));
      crestGeo.rotateZ(Math.PI * 0.5);
      crestGeo.scale(1.0, h / w, 0.85);
      const crest = new THREE.Mesh(crestGeo, duneCrestMat);
      crest.position.y = h * 0.22;
      crest.castShadow = true;
      crest.receiveShadow = true;
      dune.add(crest);

      const windward = new THREE.Mesh(own(new THREE.CylinderGeometry(w * 0.55, w * 0.95, len * 0.82, 5)), duneSandMat);
      windward.rotation.z = Math.PI * 0.5;
      windward.scale.set(1.0, (h * 0.55) / w, 1.15);
      windward.position.set(0, h * 0.08, -w * 0.35);
      windward.receiveShadow = true;
      dune.add(windward);
      return dune;
    };

    thumperHolder.add(buildCrescentDune(0.62, 0.075, 0.14, -0.34, 0.36, 0.08));
    thumperHolder.add(buildCrescentDune(0.74, 0.085, 0.16, 0.44, -0.28, -0.06));
    thumperHolder.add(buildCrescentDune(0.56, 0.068, 0.13, -0.22, -0.44, 0.12));
    thumperHolder.add(buildCrescentDune(0.48, 0.058, 0.11, 0.52, 0.22, -0.1));

    // Stratified wind-eroded sandstone spires + sparse golden desert scrub tufts along dune troughs
    const mesaSpireSpecs: [number, number, number, number][] = [
      [-0.50, 0.22, 0.095, 0.036],
      [0.54, -0.14, 0.075, 0.03],
    ];
    for (const [mx, mz, mh, mr] of mesaSpireSpecs) {
      const spire = new THREE.Group();
      spire.position.set(mx, 0, mz);
      const baseLayer = new THREE.Mesh(own(new THREE.CylinderGeometry(mr * 0.85, mr * 1.15, mh * 0.52, 6)), duneRimMat);
      baseLayer.position.y = mh * 0.24;
      baseLayer.castShadow = true;
      baseLayer.receiveShadow = true;
      spire.add(baseLayer);

      const capLayer = new THREE.Mesh(own(new THREE.CylinderGeometry(mr * 1.05, mr * 0.72, mh * 0.36, 6)), duneCrestMat);
      capLayer.position.y = mh * 0.66;
      capLayer.rotation.y = 0.45;
      capLayer.castShadow = true;
      spire.add(capLayer);
      thumperHolder.add(spire);
    }

    const scrubOffsets: [number, number][] = [
      [-0.24, 0.18],
      [-0.14, -0.22],
      [0.36, 0.26],
      [-0.40, -0.12],
      [0.14, -0.34],
    ];
    for (const [sx, sz] of scrubOffsets) {
      for (let b = 0; b < 3; b++) {
        const blade = new THREE.Mesh(own(new THREE.ConeGeometry(0.011, 0.044, 4)), dryScrubMat);
        blade.position.set(sx + (b - 1) * 0.012, 0.018, sz + (b % 2) * 0.01);
        blade.rotation.z = (b - 1) * 0.28;
        blade.rotation.x = 0.14;
        thumperHolder.add(blade);
      }
    }

    // Compact, scaled-down Fremen Dune thumper stake & subtle sand vibration ripples
    const thumperUnit = new THREE.Group();
    thumperUnit.scale.setScalar(0.52);
    thumperHolder.add(thumperUnit);

    const thumperBody = new THREE.Mesh(own(new THREE.CylinderGeometry(0.014, 0.018, 0.145, 8)), mats.brass);
    thumperBody.position.y = 0.088;
    thumperBody.castShadow = true;
    thumperUnit.add(thumperBody);

    const thumperCollar = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.022, 0.026, 0.02, 8)),
      own(new THREE.MeshStandardMaterial({ color: '#453e38', roughness: 0.65, metalness: 0.35 }))
    );
    thumperCollar.position.y = 0.032;
    thumperUnit.add(thumperCollar);

    const thumperPiston = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.023, 0.023, 0.032, 8)),
      own(new THREE.MeshStandardMaterial({ color: '#453e38', roughness: 0.5, metalness: 0.55 }))
    );
    thumperPiston.position.y = 0.165;
    thumperPiston.castShadow = true;
    thumperUnit.add(thumperPiston);

    const rippleRings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
    for (let r = 0; r < 3; r++) {
      const rMat = own(new THREE.MeshBasicMaterial({ color: '#ead2a4', transparent: true, opacity: 0, side: THREE.DoubleSide }));
      const ring = new THREE.Mesh(own(new THREE.RingGeometry(0.03, 0.042, 22)), rMat);
      ring.rotation.x = -Math.PI * 0.5;
      ring.position.y = 0.022;
      ring.visible = false;
      thumperUnit.add(ring);
      rippleRings.push({ mesh: ring, mat: rMat });
    }

    // Raised sand crater rim & dark inner pit at (0.24, 0.03, 0.04)
    const craterX = 0.24;
    const craterZ = 0.04;
    const craterRim = new THREE.Mesh(own(new THREE.TorusGeometry(0.145, 0.032, 7, 16)), duneRimMat);
    craterRim.rotation.x = Math.PI * 0.5;
    craterRim.position.set(craterX, 0.034, craterZ);
    craterRim.scale.setScalar(0.01);
    craterRim.castShadow = true;
    craterRim.receiveShadow = true;
    thumperHolder.add(craterRim);

    const wormHole = new THREE.Mesh(
      own(new THREE.CircleGeometry(0.135, 16)),
      own(new THREE.MeshBasicMaterial({ color: '#1b130d' }))
    );
    wormHole.rotation.x = -Math.PI * 0.5;
    wormHole.position.set(craterX, 0.036, craterZ);
    wormHole.scale.setScalar(0.01);
    thumperHolder.add(wormHole);

    // Giant segmented Shai-Hulud Sandworm anchored strictly at the crater center (never clips below terrain)
    const wormGroup = new THREE.Group();
    wormGroup.position.set(craterX, 0.025, craterZ);
    wormGroup.visible = false;
    const wormMat = own(new THREE.MeshStandardMaterial({ color: '#8f6d4c', roughness: 0.85, flatShading: true }));
    const wormRidgeMat = own(new THREE.MeshStandardMaterial({ color: '#6b4e33', roughness: 0.9, flatShading: true }));

    const wormSegments: THREE.Mesh[] = [];
    const SEG_COUNT = 10;
    const SEG_STEP = 0.088;
    for (let i = 0; i < SEG_COUNT; i++) {
      const r = 0.112 - i * 0.0025;
      const seg = new THREE.Mesh(
        own(new THREE.CylinderGeometry(r * 0.96, r, 0.105, 10)),
        i % 2 === 0 ? wormMat : wormRidgeMat
      );
      seg.castShadow = true;
      seg.visible = false;
      wormGroup.add(seg);
      wormSegments.push(seg);
    }

    // Head/jaw group mounted at the tip of segment 0
    const wormHead = new THREE.Group();
    const throat = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.095, 0.06, 0.05, 10)),
      own(new THREE.MeshBasicMaterial({ color: '#1a0e0a' }))
    );
    throat.position.y = 0.03;
    wormHead.add(throat);
    const toothMat = own(new THREE.MeshStandardMaterial({ color: '#f5eedc', roughness: 0.35 }));
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      const tooth = new THREE.Mesh(own(new THREE.ConeGeometry(0.014, 0.055, 4)), toothMat);
      tooth.position.set(Math.cos(a) * 0.092, 0.048, Math.sin(a) * 0.092);
      tooth.rotation.z = Math.cos(a) * 0.45;
      tooth.rotation.x = -Math.sin(a) * 0.45;
      wormHead.add(tooth);
    }
    wormGroup.add(wormHead);
    thumperHolder.add(wormGroup);

    let thumpClock = 0;
    let wormTimer = 0;
    const WORM_DURATION = 5.2;
    const MAX_WORM_HEIGHT = 0.78;

    interactiveProps.push({
      mesh: thumperHolder,
      onTap: () => {
        if (wormTimer <= 0) {
          wormTimer = WORM_DURATION;
          wormGroup.visible = true;
        }
      },
    });

    controllers.push({
      update(dt: number) {
        thumpClock += dt;
        // Discrete heavy thumper slam every 1.65s -> triggers decelerating reverberating seismic shockwaves!
        const THUMP_PERIOD = 1.65;
        const cyc = (thumpClock / THUMP_PERIOD) % 1;
        const STRIKE_AT = 0.62;
        if (cyc < 0.52) {
          const lift = smoothstep(0.0, 0.52, cyc);
          thumperPiston.position.y = THREE.MathUtils.lerp(0.152, 0.198, lift);
        } else if (cyc < STRIKE_AT) {
          const slam = (cyc - 0.52) / (STRIKE_AT - 0.52);
          thumperPiston.position.y = THREE.MathUtils.lerp(0.198, 0.124, slam * slam);
        } else {
          const recoil = smoothstep(STRIKE_AT, 0.85, cyc);
          thumperPiston.position.y = THREE.MathUtils.lerp(0.124, 0.152, recoil);
        }

        const sinceImpact = (cyc - STRIKE_AT + 1) % 1; // 0.0 at exact ground strike
        thumperCollar.position.y = 0.032 - Math.exp(-sinceImpact * 15.0) * Math.sin(sinceImpact * 42.0) * 0.0045;

        rippleRings.forEach((rg, idx) => {
          const delay = idx * 0.085;
          const windowDur = 0.56;
          if (sinceImpact < delay || sinceImpact > delay + windowDur) {
            rg.mesh.visible = false;
            return;
          }
          rg.mesh.visible = true;
          const u = (sinceImpact - delay) / windowDur;
          const expand = 1 - Math.pow(1 - u, 2.7);
          const reverbPulse = 0.84 + 0.16 * Math.cos(u * Math.PI * 6.0);
          rg.mesh.scale.setScalar((0.52 + expand * 2.25) * (1 - idx * 0.08));
          rg.mat.opacity = Math.max(0, (1 - u) * (1 - u) * (0.58 - idx * 0.14) * reverbPulse);
        });

        if (wormTimer > 0) {
          wormTimer = Math.max(0, wormTimer - dt);
          const progress = 1 - wormTimer / WORM_DURATION; // 0 -> 1

          // 1. Crater begins as a tiny trembling pinpoint (0.00..0.32), widens dramatically as sand collapses, then closes (0.88..1.0)
          const holeGrow = Math.pow(smoothstep(0.0, 0.32, progress), 1.75);
          const holeClose = 1 - smoothstep(0.88, 1.0, progress);
          const tremor = progress < 0.32 ? Math.sin(progress * 90.0) * 0.014 * holeGrow : 0;
          const holeScale = Math.max(0.015, holeGrow * holeClose + tremor);
          wormHole.scale.setScalar(holeScale);
          craterRim.scale.setScalar(holeScale);

          // 2. Vertical emergence: bursts up after pit widens (0.18..0.42), looms tall (0.42..0.72), dives cleanly down (0.72..0.88)
          const rise = smoothstep(0.18, 0.42, progress);
          const dive = 1 - smoothstep(0.72, 0.88, progress);
          const emergentHeight = rise * dive * MAX_WORM_HEIGHT;

          // Sway envelope shrinks smoothly to 0 before re-entry so it dives straight down the crater center
          const swayEnv = smoothstep(0.24, 0.42, progress) * (1 - smoothstep(0.66, 0.84, progress));

          const evalCurve = (yAboveCrater: number) => {
            const hFrac = Math.max(0, yAboveCrater) / MAX_WORM_HEIGHT;
            const bend = hFrac * hFrac * swayEnv;
            return {
              x: Math.sin(progress * 11.5 - hFrac * 1.4) * 0.11 * bend,
              z: Math.cos(progress * 8.5 - hFrac * 1.2) * 0.075 * bend,
            };
          };

          for (let i = 0; i < SEG_COUNT; i++) {
            const seg = wormSegments[i];
            const segY = emergentHeight - i * SEG_STEP;
            if (segY < 0.0) {
              seg.visible = false;
              continue;
            }
            seg.visible = true;
            const off = evalCurve(segY);
            const offAbove = evalCurve(segY + 0.04);
            seg.position.set(off.x, segY, off.z);
            seg.rotation.z = -(offAbove.x - off.x) * 8.5;
            seg.rotation.x = (offAbove.z - off.z) * 8.5;
          }

          if (emergentHeight >= 0.03) {
            wormHead.visible = true;
            const headOff = evalCurve(emergentHeight + 0.04);
            const neckOff = evalCurve(emergentHeight);
            wormHead.position.set(headOff.x, emergentHeight + 0.035, headOff.z);
            wormHead.rotation.z = -(headOff.x - neckOff.x) * 10.0;
            wormHead.rotation.x = (headOff.z - neckOff.z) * 10.0;
          } else {
            wormHead.visible = false;
          }

          if (wormTimer <= 0) {
            wormGroup.visible = false;
            wormHead.visible = false;
            wormSegments.forEach((s) => {
              s.visible = false;
            });
            wormHole.scale.setScalar(0.01);
            craterRim.scale.setScalar(0.01);
          }
        }
      },
    });
  }

  // SCENE 10: FARGO SNOW SUITCASE & RED ICE SCRAPER (Beside the Snowy Alpine Ridge)
  {
    const fargoDir = WORLD_CONFIG.landmarks.fargo.dir;
    const fargoHolder = attachOnSurface(planetGroup, fargoDir, -0.01, 0.5);

    // Sculpted white snowdrift bank
    const snowMat = own(new THREE.MeshStandardMaterial({ color: '#f2f6fa', roughness: 0.78 }));
    const snowBank = new THREE.Mesh(own(new THREE.SphereGeometry(0.15, 10, 8)), snowMat);
    snowBank.scale.set(1.3, 0.42, 1.0);
    snowBank.position.y = 0.015;
    snowBank.receiveShadow = true;
    fargoHolder.add(snowBank);

    // Half-buried weathered leather briefcase
    const leatherMat = own(new THREE.MeshStandardMaterial({ color: '#5c3822', roughness: 0.72 }));
    const suitcase = new THREE.Mesh(own(new THREE.BoxGeometry(0.13, 0.085, 0.042)), leatherMat);
    suitcase.position.set(0.02, 0.042, 0.01);
    suitcase.rotation.set(0.25, 0.35, -0.18);
    suitcase.castShadow = true;
    fargoHolder.add(suitcase);

    const handle = new THREE.Mesh(own(new THREE.TorusGeometry(0.02, 0.004, 5, 10, Math.PI)), mats.brass);
    handle.position.set(0.02, 0.088, 0.01);
    handle.rotation.y = 0.35;
    fargoHolder.add(handle);

    // Iconic bright red ice scraper sticking straight up out of the snowbank!
    const redScraperMat = own(new THREE.MeshStandardMaterial({ color: '#d92626', roughness: 0.35 }));
    const scraperBlade = new THREE.Mesh(own(new THREE.BoxGeometry(0.036, 0.14, 0.008)), redScraperMat);
    scraperBlade.position.set(-0.07, 0.085, 0.04);
    scraperBlade.rotation.z = 0.08;
    scraperBlade.castShadow = true;
    fargoHolder.add(scraperBlade);

    // Weathered wooden fence post beside the snowbank
    const fencePost = new THREE.Mesh(own(new THREE.CylinderGeometry(0.012, 0.015, 0.24, 6)), mats.wood);
    fencePost.position.set(-0.14, 0.11, -0.05);
    fencePost.rotation.z = -0.06;
    fencePost.castShadow = true;
    fargoHolder.add(fencePost);
  }

  // SCENE 11: COMFYUI WHITE FENNEC GIRL (FACING VIEWER, DANCING) + SKYWARD NODE SPAGHETTI + PURPLE GALAXY GLASS BOTTLE
  {
    const comfyDir = WORLD_CONFIG.landmarks.comfy.dir;
    // yaw = Math.PI + 0.12 rotates local +Z to face downward toward the screen/viewer!
    const comfyHolder = attachOnSurface(planetGroup, comfyDir, -0.008, Math.PI + 0.12);

    // Stylized low-res ComfyUI Fennec Fox Girl (larger, standing, doing a cheerful little dance!)
    const fennecGroup = new THREE.Group();
    const skinMat = own(new THREE.MeshStandardMaterial({ color: '#fde6d8', roughness: 0.78, flatShading: true }));
    const hairWhiteMat = own(new THREE.MeshStandardMaterial({ color: '#f7f4ec', roughness: 0.82, flatShading: true }));
    const innerEarMat = own(new THREE.MeshStandardMaterial({ color: '#f4b6c2', roughness: 0.78, flatShading: true }));
    const hoodieMat = own(new THREE.MeshStandardMaterial({ color: '#2b2e3b', roughness: 0.82, flatShading: true }));
    const hoodieAccentMat = own(new THREE.MeshStandardMaterial({ color: '#38bdf8', emissive: '#38bdf8', emissiveIntensity: 0.35, roughness: 0.4 }));
    const skirtMat = own(new THREE.MeshStandardMaterial({ color: '#4c3f7a', roughness: 0.82, flatShading: true }));
    const bootMat = own(new THREE.MeshStandardMaterial({ color: '#1f222c', roughness: 0.75, flatShading: true }));
    const eyeMat = own(new THREE.MeshStandardMaterial({ color: '#2e6be6', emissive: '#1d4ed8', emissiveIntensity: 0.25, roughness: 0.25 }));

    const bodyPivot = new THREE.Group();
    fennecGroup.add(bodyPivot);

    // Legs & boots
    const legL = new THREE.Mesh(own(new THREE.BoxGeometry(0.032, 0.095, 0.032)), skinMat);
    legL.position.set(-0.028, 0.055, 0);
    const bootL = new THREE.Mesh(own(new THREE.BoxGeometry(0.038, 0.042, 0.046)), bootMat);
    bootL.position.set(-0.028, 0.021, 0.006);
    bootL.castShadow = true;
    const legR = legL.clone();
    legR.position.x = 0.028;
    const bootR = bootL.clone();
    bootR.position.x = 0.028;
    bodyPivot.add(legL, bootL, legR, bootR);

    // Pleated skirt
    const skirt = new THREE.Mesh(own(new THREE.CylinderGeometry(0.048, 0.072, 0.068, 7)), skirtMat);
    skirt.position.set(0, 0.115, 0);
    skirt.castShadow = true;
    bodyPivot.add(skirt);

    // Oversized cozy ComfyUI tech-hoodie torso
    const torso = new THREE.Mesh(own(new THREE.BoxGeometry(0.105, 0.115, 0.072)), hoodieMat);
    torso.position.set(0, 0.195, 0);
    torso.castShadow = true;
    bodyPivot.add(torso);

    // Glowing cyan ComfyUI hoodie zipper/accent stripe
    const stripe = new THREE.Mesh(own(new THREE.BoxGeometry(0.014, 0.105, 0.075)), hoodieAccentMat);
    stripe.position.set(0, 0.195, 0);
    bodyPivot.add(stripe);

    // Dancing arms
    const armLPivot = new THREE.Group();
    armLPivot.position.set(-0.068, 0.235, 0);
    const armL = new THREE.Mesh(own(new THREE.BoxGeometry(0.034, 0.095, 0.034)), hoodieMat);
    armL.position.y = -0.042;
    armL.castShadow = true;
    armLPivot.add(armL);
    bodyPivot.add(armLPivot);

    const armRPivot = new THREE.Group();
    armRPivot.position.set(0.068, 0.235, 0);
    const armR = new THREE.Mesh(own(new THREE.BoxGeometry(0.034, 0.095, 0.034)), hoodieMat);
    armR.position.y = -0.042;
    armR.castShadow = true;
    armRPivot.add(armR);
    bodyPivot.add(armRPivot);

    // Head + fluffy white anime hair + expressive eyes
    const headPivot = new THREE.Group();
    headPivot.position.set(0, 0.295, 0.004);
    const face = new THREE.Mesh(own(new THREE.BoxGeometry(0.098, 0.092, 0.088)), skinMat);
    face.castShadow = true;
    headPivot.add(face);

    // Messy white anime hair cap + bangs + side locks
    const hairTop = new THREE.Mesh(own(new THREE.BoxGeometry(0.112, 0.045, 0.102)), hairWhiteMat);
    hairTop.position.set(0, 0.036, -0.004);
    hairTop.castShadow = true;
    headPivot.add(hairTop);

    const hairBack = new THREE.Mesh(own(new THREE.BoxGeometry(0.114, 0.12, 0.042)), hairWhiteMat);
    hairBack.position.set(0, -0.012, -0.042);
    hairBack.castShadow = true;
    headPivot.add(hairBack);

    for (const side of [-1, 1]) {
      const sideLock = new THREE.Mesh(own(new THREE.BoxGeometry(0.024, 0.092, 0.032)), hairWhiteMat);
      sideLock.position.set(side * 0.052, -0.005, 0.025);
      headPivot.add(sideLock);
    }

    // Large bright anime eyes
    const eyeL = new THREE.Mesh(own(new THREE.BoxGeometry(0.02, 0.024, 0.008)), eyeMat);
    eyeL.position.set(-0.024, -0.002, 0.045);
    const eyeR = eyeL.clone();
    eyeR.position.x = 0.024;
    headPivot.add(eyeL, eyeR);

    // Oversized iconic white Fennec Fox ears!
    const earPivots: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const ep = new THREE.Group();
      ep.position.set(side * 0.052, 0.048, 0);
      ep.rotation.z = -side * 0.58;
      const earOuter = new THREE.Mesh(own(new THREE.ConeGeometry(0.042, 0.165, 4)), hairWhiteMat);
      earOuter.position.y = 0.075;
      earOuter.rotation.y = side * 0.25;
      earOuter.castShadow = true;
      ep.add(earOuter);

      const earInner = new THREE.Mesh(own(new THREE.ConeGeometry(0.024, 0.118, 4)), innerEarMat);
      earInner.position.set(0, 0.072, 0.018);
      earInner.rotation.y = side * 0.25;
      ep.add(earInner);

      headPivot.add(ep);
      earPivots.push(ep);
    }
    bodyPivot.add(headPivot);

    // Big fluffy bushy white fennec tail wagging behind her
    const tailPivot = new THREE.Group();
    tailPivot.position.set(0, 0.11, -0.045);
    const tailMesh = new THREE.Mesh(own(new THREE.ConeGeometry(0.048, 0.17, 5)), hairWhiteMat);
    tailMesh.position.set(0, 0.02, -0.075);
    tailMesh.rotation.x = -Math.PI * 0.42;
    tailMesh.castShadow = true;
    tailPivot.add(tailMesh);
    bodyPivot.add(tailPivot);

    comfyHolder.add(fennecGroup);

    // Magical ComfyUI Default Glass Bottle ("purple galaxy bottle") on the ground beside her
    const bottleGroup = new THREE.Group();
    bottleGroup.position.set(0.17, 0, 0.06);
    const glassMat = own(new THREE.MeshPhysicalMaterial({
      color: '#d8e8ff',
      roughness: 0.12,
      metalness: 0.05,
      transmission: 0.72,
      transparent: true,
      opacity: 0.55,
    }));
    const bottleBody = new THREE.Mesh(own(new THREE.CylinderGeometry(0.048, 0.054, 0.11, 10)), glassMat);
    bottleBody.position.y = 0.056;
    bottleBody.castShadow = true;
    bottleGroup.add(bottleBody);

    const bottleNeck = new THREE.Mesh(own(new THREE.CylinderGeometry(0.022, 0.032, 0.04, 8)), glassMat);
    bottleNeck.position.y = 0.13;
    bottleGroup.add(bottleNeck);

    const corkMat = own(new THREE.MeshStandardMaterial({ color: '#a8794b', roughness: 0.9 }));
    const cork = new THREE.Mesh(own(new THREE.CylinderGeometry(0.02, 0.017, 0.024, 7)), corkMat);
    cork.position.y = 0.155;
    bottleGroup.add(cork);

    // Glowing purple galaxy nebula core + floating star motes inside the bottle
    const galaxyMat = own(new THREE.MeshStandardMaterial({
      color: '#8b3dff',
      emissive: '#9d4edd',
      emissiveIntensity: 1.15,
      roughness: 0.3,
    }));
    const galaxyCore = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.034, 0)), galaxyMat);
    galaxyCore.position.y = 0.054;
    bottleGroup.add(galaxyCore);

    const starMat = own(new THREE.MeshBasicMaterial({ color: '#fff3b0' }));
    const bottleStars: THREE.Mesh[] = [];
    for (let s = 0; s < 5; s++) {
      const st = new THREE.Mesh(own(new THREE.OctahedronGeometry(0.0055, 0)), starMat);
      st.position.set(Math.cos(s * 1.3) * 0.026, 0.036 + s * 0.012, Math.sin(s * 1.3) * 0.026);
      bottleGroup.add(st);
      bottleStars.push(st);
    }
    comfyHolder.add(bottleGroup);

    // Magical Floating ComfyUI Node Spaghetti rising UPWARD toward the sky & facing toward the user camera
    const nodeGraphGroup = new THREE.Group();
    nodeGraphGroup.visible = false;
    nodeGraphGroup.scale.setScalar(0.001);
    comfyHolder.add(nodeGraphGroup);

    const nodeMat = own(new THREE.MeshStandardMaterial({ color: '#242731', roughness: 0.65, metalness: 0.15 }));
    const nodeHeaderColors = ['#3b82f6', '#a855f7', '#ec4899', '#10b981'];
    // Ascending skyward arc above her head & galaxy bottle, slightly inclined toward viewer
    const nodePositions = [
      new THREE.Vector3(0.15, 0.35, 0.05),
      new THREE.Vector3(-0.14, 0.49, 0.07),
      new THREE.Vector3(0.10, 0.65, 0.09),
      new THREE.Vector3(-0.02, 0.81, 0.11),
    ];
    const nodeMeshes: THREE.Group[] = [];
    nodePositions.forEach((pos, idx) => {
      const nGroup = new THREE.Group();
      nGroup.position.copy(pos);
      const card = new THREE.Mesh(own(new THREE.BoxGeometry(0.102, 0.064, 0.012)), nodeMat);
      card.castShadow = true;
      nGroup.add(card);
      const headerMat = own(new THREE.MeshStandardMaterial({
        color: nodeHeaderColors[idx],
        emissive: nodeHeaderColors[idx],
        emissiveIntensity: 0.65,
        roughness: 0.38,
      }));
      const header = new THREE.Mesh(own(new THREE.BoxGeometry(0.102, 0.016, 0.014)), headerMat);
      header.position.set(0, 0.024, 0.001);
      nGroup.add(header);
      // Small front-facing node progress bar so the front face clearly points at the viewer
      const pinBar = new THREE.Mesh(
        own(new THREE.BoxGeometry(0.064, 0.009, 0.004)),
        own(new THREE.MeshBasicMaterial({ color: '#d8e2ff' }))
      );
      pinBar.position.set(0, -0.008, 0.007);
      nGroup.add(pinBar);
      nodeGraphGroup.add(nGroup);
      nodeMeshes.push(nGroup);
    });

    // Noodles & signal orbs stream UPWARD from the purple galaxy bottle into the sky nodes!
    const bottleOrigin = new THREE.Vector3(0.17, 0.17, 0.06);
    const noodleDefs: { from: THREE.Vector3; to: THREE.Vector3; midOffset: THREE.Vector3; color: string }[] = [
      { from: bottleOrigin, to: nodePositions[0], midOffset: new THREE.Vector3(0.05, 0.03, 0.04), color: '#a855f7' },
      { from: nodePositions[0], to: nodePositions[1], midOffset: new THREE.Vector3(-0.04, 0.06, 0.05), color: '#38bdf8' },
      { from: nodePositions[0], to: nodePositions[2], midOffset: new THREE.Vector3(0.06, 0.04, 0.04), color: '#f472b6' },
      { from: nodePositions[1], to: nodePositions[3], midOffset: new THREE.Vector3(-0.04, 0.05, 0.04), color: '#fbbf24' },
      { from: nodePositions[2], to: nodePositions[3], midOffset: new THREE.Vector3(0.03, 0.05, 0.04), color: '#34d399' },
    ];

    const noodleMats: THREE.MeshStandardMaterial[] = [];
    const signalOrbs: { mesh: THREE.Mesh; curve: THREE.QuadraticBezierCurve3; phase: number; speed: number }[] = [];

    for (let i = 0; i < noodleDefs.length; i++) {
      const def = noodleDefs[i];
      const mid = def.from.clone().lerp(def.to, 0.5).add(def.midOffset);
      const curve = new THREE.QuadraticBezierCurve3(def.from, mid, def.to);
      const nMat = own(new THREE.MeshStandardMaterial({
        color: def.color,
        emissive: def.color,
        emissiveIntensity: 0.9,
        roughness: 0.25,
      }));
      noodleMats.push(nMat);
      const tube = new THREE.Mesh(own(new THREE.TubeGeometry(curve, 16, 0.005, 6, false)), nMat);
      nodeGraphGroup.add(tube);

      const orb = new THREE.Mesh(
        own(new THREE.SphereGeometry(0.011, 7, 6)),
        own(new THREE.MeshBasicMaterial({ color: '#ffffff' }))
      );
      nodeGraphGroup.add(orb);
      signalOrbs.push({ mesh: orb, curve, phase: i * 0.2, speed: 0.62 + (i % 2) * 0.16 });
    }

    const comfyLight = new THREE.PointLight('#b366ff', 0.0, 1.6, 2);
    comfyLight.position.set(0.04, 0.36, 0.08);
    comfyHolder.add(comfyLight);

    const _comfyHolderQ = new THREE.Quaternion();
    const _comfySkyUp = new THREE.Vector3();

    let queueTimer = 0;
    let nodeReveal = 0;
    let comfyClock = 0;
    const comfyHit = new THREE.Mesh(
      own(new THREE.SphereGeometry(0.42, 10, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.0, depthWrite: false }))
    );
    comfyHit.position.set(0.06, 0.26, 0.02);
    comfyHolder.add(comfyHit);

    const triggerComfyTap = () => {
      queueTimer = 5.2;
    };
    interactiveProps.push(
      { mesh: fennecGroup, onTap: triggerComfyTap },
      { mesh: bottleGroup, onTap: triggerComfyTap },
      { mesh: nodeGraphGroup, onTap: triggerComfyTap },
      { mesh: comfyHit, onTap: triggerComfyTap }
    );

    controllers.push({
      update(dt) {
        comfyClock += dt;
        const elapsed = comfyClock;
        if (queueTimer > 0) queueTimer = Math.max(0, queueTimer - dt);
        const targetReveal = queueTimer > 0 ? 1 : 0;
        nodeReveal = THREE.MathUtils.lerp(nodeReveal, targetReveal, Math.min(1, dt * 5.8));

        // Cheerful little idle dance (faster & bouncier when generating!)
        const danceSpeed = queueTimer > 0 ? 7.4 : 4.2;
        const bounce = Math.abs(Math.sin(elapsed * danceSpeed)) * (queueTimer > 0 ? 0.026 : 0.014);
        bodyPivot.position.y = bounce;
        bodyPivot.rotation.z = Math.sin(elapsed * danceSpeed * 0.5) * 0.08;
        headPivot.rotation.z = -Math.sin(elapsed * danceSpeed * 0.5) * 0.12;
        armLPivot.rotation.z = -0.35 + Math.sin(elapsed * danceSpeed) * 0.42;
        armRPivot.rotation.z = 0.35 + Math.sin(elapsed * danceSpeed) * 0.42;
        earPivots[0].rotation.z = 0.58 + Math.sin(elapsed * danceSpeed + 0.4) * 0.1;
        earPivots[1].rotation.z = -0.58 - Math.sin(elapsed * danceSpeed + 0.4) * 0.1;
        tailPivot.rotation.y = Math.sin(elapsed * danceSpeed * 1.1) * 0.45;

        // Show & animate magical ComfyUI node spaghetti rising skyward toward the user only when tapped
        if (nodeReveal > 0.015) {
          nodeGraphGroup.visible = true;
          nodeGraphGroup.scale.set(nodeReveal, nodeReveal, nodeReveal);
          nodeGraphGroup.position.y = (1 - nodeReveal) * -0.08;
          if (camera) {
            comfyHolder.getWorldQuaternion(_comfyHolderQ);
            _comfySkyUp.set(0, 1, 0).applyQuaternion(_comfyHolderQ).normalize();
          }
          nodeMeshes.forEach((n, idx) => {
            n.position.y = nodePositions[idx].y + Math.sin(elapsed * 2.2 + idx * 1.1) * 0.018;
            if (camera) {
              n.up.copy(_comfySkyUp);
              n.lookAt(camera.position);
            }
          });
          for (const s of signalOrbs) {
            const t = (elapsed * s.speed * 1.8 + s.phase) % 1;
            s.curve.getPoint(t, s.mesh.position);
          }
          for (const m of noodleMats) {
            m.emissiveIntensity = 0.45 + Math.sin(elapsed * 4.0) * 0.14;
          }
          comfyLight.intensity = nodeReveal * 0.55;
        } else {
          nodeGraphGroup.visible = false;
          comfyLight.intensity = 0.0;
        }

        // Swirl the purple galaxy inside the glass bottle
        galaxyCore.rotation.y = elapsed * 1.1;
        galaxyCore.rotation.x = elapsed * 0.6;
        galaxyMat.emissiveIntensity = 1.05 + nodeReveal * 0.85;
        bottleStars.forEach((st, idx) => {
          const a = elapsed * (1.2 + idx * 0.2) + idx * 1.3;
          st.position.x = Math.cos(a) * 0.025;
          st.position.z = Math.sin(a) * 0.025;
        });
      },
    });
  }

  // SCENE 12: THE SIX-FINGERED HAND STONE SCULPTURE + WORSHIPPING MINK (Palm faces directly toward the mink!)
  {
    const handDir = WORLD_CONFIG.landmarks.sixhand.dir;
    const [latent] = agents.sixhand;
    placeAtLandmark(latent, handDir, -0.095, -0.125, true);

    const handHolder = attachOnSurface(planetGroup, handDir, -0.015, 0);
    const surfNorm = getTerrainNormal(handDir);
    const toLatent = latent.dir
      .clone()
      .sub(handDir)
      .addScaledVector(surfNorm, -latent.dir.clone().sub(handDir).dot(surfNorm))
      .normalize();
    const handRight = new THREE.Vector3().crossVectors(surfNorm, toLatent).normalize();
    handHolder.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(handRight, surfNorm, toLatent));

    const stoneMat = own(new THREE.MeshStandardMaterial({ color: '#9a968e', roughness: 0.92, flatShading: true }));
    const stoneDarkMat = own(new THREE.MeshStandardMaterial({ color: '#7c7870', roughness: 0.94, flatShading: true }));
    const stonePalmHollowMat = own(new THREE.MeshStandardMaterial({ color: '#6b675f', roughness: 0.95, flatShading: true }));
    const stoneNailMat = own(new THREE.MeshStandardMaterial({ color: '#b5b1a8', roughness: 0.78, flatShading: true }));

    // Mossy carved stone pedestal
    const plinth = new THREE.Mesh(own(new THREE.CylinderGeometry(0.115, 0.145, 0.065, 8)), stoneDarkMat);
    plinth.position.y = 0.032;
    plinth.castShadow = true;
    plinth.receiveShadow = true;
    handHolder.add(plinth);

    const handSculpture = new THREE.Group();
    handSculpture.position.y = 0.06;

    // Wrist & Palm (sculpted so +Z is clearly the open palm facing Latent, -Z is the back of the hand!)
    const wrist = new THREE.Mesh(own(new THREE.CylinderGeometry(0.052, 0.062, 0.07, 7)), stoneMat);
    wrist.position.y = 0.035;
    wrist.castShadow = true;
    handSculpture.add(wrist);

    const palm = new THREE.Mesh(own(new THREE.BoxGeometry(0.145, 0.12, 0.04)), stoneMat);
    palm.position.y = 0.115;
    palm.castShadow = true;
    palm.receiveShadow = true;
    handSculpture.add(palm);

    // Distinct Palm anatomy on +Z side: thumb muscle mount (thenar), outer heel pad, and carved palm crease
    const thenarPad = new THREE.Mesh(own(new THREE.SphereGeometry(0.042, 7, 6)), stoneMat);
    thenarPad.scale.set(0.9, 1.18, 0.48);
    thenarPad.position.set(-0.042, 0.095, 0.018);
    const heelPad = new THREE.Mesh(own(new THREE.SphereGeometry(0.034, 7, 6)), stoneMat);
    heelPad.scale.set(0.85, 1.15, 0.45);
    heelPad.position.set(0.044, 0.1, 0.017);
    const palmHollow = new THREE.Mesh(own(new THREE.CylinderGeometry(0.032, 0.028, 0.006, 8)), stonePalmHollowMat);
    palmHollow.rotation.x = Math.PI * 0.5;
    palmHollow.position.set(0.004, 0.122, 0.02);
    handSculpture.add(thenarPad, heelPad, palmHollow);

    // Six distinct stone fingers curling gently toward the +Z palm side, with sculpted fingernails on -Z back
    const fingerSpecs = [
      { x: -0.088, y: 0.112, z: 0.01, len: 0.085, r: 0.015, rz: 0.58, rx: 0.24 }, // Thumb angled toward palm
      { x: -0.056, y: 0.185, z: 0.002, len: 0.112, r: 0.013, rz: 0.18, rx: 0.1 }, // Index
      { x: -0.028, y: 0.195, z: 0.003, len: 0.128, r: 0.013, rz: 0.06, rx: 0.09 }, // Middle 1
      { x: 0.002, y: 0.196, z: 0.003, len: 0.126, r: 0.013, rz: -0.04, rx: 0.09 }, // Middle 2 (extra!)
      { x: 0.032, y: 0.19, z: 0.002, len: 0.114, r: 0.0125, rz: -0.14, rx: 0.1 }, // Ring
      { x: 0.06, y: 0.175, z: 0.0, len: 0.092, r: 0.0115, rz: -0.28, rx: 0.12 }, // Pinky
    ];
    const fingerMeshes: { group: THREE.Group; baseRx: number }[] = [];
    for (const f of fingerSpecs) {
      const fPivot = new THREE.Group();
      fPivot.position.set(f.x, f.y, f.z);
      fPivot.rotation.set(f.rx, 0, f.rz);
      const seg = new THREE.Mesh(own(new THREE.CylinderGeometry(f.r * 0.85, f.r, f.len, 6)), stoneMat);
      seg.position.y = f.len * 0.5;
      seg.castShadow = true;
      fPivot.add(seg);
      const tip = new THREE.Mesh(own(new THREE.SphereGeometry(f.r * 0.85, 6, 5)), stoneMat);
      tip.position.y = f.len;
      fPivot.add(tip);
      // Fingernail on -Z (back of hand), so +Z clearly reads as the open palm facing Latent
      const nail = new THREE.Mesh(own(new THREE.BoxGeometry(f.r * 1.05, f.r * 1.15, 0.004)), stoneNailMat);
      nail.position.set(0, f.len - f.r * 0.45, -f.r * 0.82);
      fPivot.add(nail);
      handSculpture.add(fPivot);
      fingerMeshes.push({ group: fPivot, baseRx: f.rx });
    }

    handHolder.add(handSculpture);

    let handPulse = 0;
    let handClock = 0;
    const handHit = new THREE.Mesh(
      own(new THREE.SphereGeometry(0.22, 8, 6)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    handHit.position.y = 0.2;
    handHolder.add(handHit);
    interactiveProps.push({
      mesh: handHit,
      onTap: () => {
        handPulse = 2.6;
        latent.poke(handDir);
      },
    });

    controllers.push({
      update(dt) {
        handClock += dt;
        const elapsed = handClock;
        if (handPulse > 0) {
          handPulse = Math.max(0, handPulse - dt);
          fingerMeshes.forEach((f, idx) => {
            f.group.rotation.x = f.baseRx + Math.sin(elapsed * 14 + idx * 0.9) * 0.28 * (handPulse / 2.6);
          });
        } else {
          fingerMeshes.forEach((f) => {
            f.group.rotation.x = THREE.MathUtils.lerp(f.group.rotation.x, f.baseRx, Math.min(1, dt * 6));
          });
        }

        // Latent bows down and worships the Six-Fingered Hand all day
        latent.faceTowardDir(handDir, dt, 6.5);
        latent.speed = 0;
        if (handPulse > 1.8) {
          latent.poseState = 'hop';
        } else {
          latent.poseState = 'worship';
        }
        latent.setGlanceToward(handDir);
      },
    });
  }

  // SCENE 13: VERY EARLY ART — LASCAUX HANDPRINT BOULDER (ENLARGED)
  {
    const lascauxDir = WORLD_CONFIG.landmarks.lascaux.dir;
    const boulderHolder = attachOnSurface(planetGroup, lascauxDir, -0.022, 0.35);

    const ochreRockMat = own(new THREE.MeshStandardMaterial({ color: '#c49b6c', roughness: 0.93, flatShading: true }));
    const darkRockMat = own(new THREE.MeshStandardMaterial({ color: '#8f6c47', roughness: 0.95, flatShading: true }));

    const boulderGroup = new THREE.Group();
    boulderGroup.scale.setScalar(1.85);
    boulderHolder.add(boulderGroup);

    // Chunky sculpted sandstone boulders
    const mainBoulder = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.145, 0)), ochreRockMat);
    mainBoulder.scale.set(1.22, 1.05, 0.88);
    mainBoulder.position.set(0, 0.10, -0.03);
    mainBoulder.castShadow = true;
    mainBoulder.receiveShadow = true;
    boulderGroup.add(mainBoulder);

    const sideStone = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.075, 0)), darkRockMat);
    sideStone.scale.set(1.1, 0.72, 0.95);
    sideStone.position.set(-0.13, 0.042, 0.02);
    sideStone.castShadow = true;
    boulderGroup.add(sideStone);

    // Bold, crisp 16x16 pixel Lascaux stenciled red handprint + tiny charcoal bison on the rock face!
    const handprintTex = createPixelArtTexture(16, 16, (px) => {
      px(0, 0, 16, 16, '#cc9f6e');
      px(0, 0, 16, 2, '#b88b5a');
      px(0, 13, 16, 3, '#b18555');
      // Chunky red-ochre stenciled handprint (reads clearly even when tiny)
      px(5, 6, 5, 4, '#a62619'); // palm
      px(3, 7, 2, 2, '#a62619'); // thumb
      px(5, 2, 1, 4, '#a62619'); // index
      px(7, 1, 1, 5, '#a62619'); // middle
      px(9, 2, 1, 4, '#a62619'); // ring
      px(11, 4, 1, 4, '#a62619'); // pinky
      px(6, 10, 3, 1, '#a62619'); // wrist
      // Tiny dark charcoal Lascaux bison silhouette below-left
      px(2, 12, 4, 2, '#3a241a');
      px(1, 12, 1, 1, '#3a241a');
      px(2, 14, 1, 1, '#3a241a');
      px(5, 14, 1, 1, '#3a241a');
    });
    const muralPlate = new THREE.Mesh(
      own(new THREE.PlaneGeometry(0.145, 0.145)),
      own(new THREE.MeshStandardMaterial({ map: handprintTex, roughness: 0.92 }))
    );
    muralPlate.position.set(0.01, 0.115, 0.088);
    muralPlate.rotation.x = -0.18;
    boulderGroup.add(muralPlate);

    // Small prehistoric ember dish warming the handprint boulder
    const bowl = new THREE.Mesh(own(new THREE.CylinderGeometry(0.032, 0.022, 0.024, 6)), darkRockMat);
    bowl.position.set(0.125, 0.012, 0.085);
    boulderGroup.add(bowl);

    const flameMat = own(new THREE.MeshStandardMaterial({
      color: '#ff922b',
      emissive: '#ff5e14',
      emissiveIntensity: 1.35,
      roughness: 0.4,
    }));
    const flame = new THREE.Mesh(own(new THREE.ConeGeometry(0.02, 0.042, 5)), flameMat);
    flame.position.set(0.125, 0.04, 0.085);
    boulderGroup.add(flame);

    const boulderLight = new THREE.PointLight('#ff923b', 0.65, 1.8, 2);
    boulderLight.position.set(0.18, 0.16, 0.20);
    boulderHolder.add(boulderLight);

    let torchFlare = 0;
    let lascauxClock = 0;
    const boulderHit = new THREE.Mesh(
      own(new THREE.SphereGeometry(0.32, 8, 6)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    boulderHit.position.set(0, 0.18, 0.02);
    boulderHolder.add(boulderHit);
    interactiveProps.push(
      {
        mesh: boulderGroup,
        onTap: () => {
          torchFlare = 3.0;
        },
      },
      {
        mesh: boulderHit,
        onTap: () => {
          torchFlare = 3.0;
        },
      }
    );

    controllers.push({
      update(dt) {
        lascauxClock += dt;
        const elapsed = lascauxClock;
        if (torchFlare > 0) torchFlare = Math.max(0, torchFlare - dt);
        const boost = torchFlare > 0 ? 1 + (torchFlare / 3.0) * 1.4 : 1;
        const flicker = 0.88 + Math.sin(elapsed * 9.5) * 0.14;
        flame.scale.set(0.95 + Math.sin(elapsed * 11) * 0.12, flicker * boost, 0.95);
        flameMat.emissiveIntensity = 1.2 * flicker * boost;
        boulderLight.intensity = 0.65 * flicker * boost;
      },
    });
  }

  // SCENE 14: RENAISSANCE ART — MONUMENTAL 3X STATUE OF DAVID + TWO YOUNG CONFUSED MINKS + SPARSE QUESTION MARKS
  {
    const davidDir = WORLD_CONFIG.landmarks.david.dir;
    const davidHolder = attachOnSurface(planetGroup, davidDir, -0.02, 0.15);

    const darkPlinthMat = own(new THREE.MeshStandardMaterial({ color: '#6b6760', roughness: 0.88, flatShading: true }));
    const marbleMat = own(new THREE.MeshStandardMaterial({ color: '#f5f1e8', roughness: 0.45, flatShading: true }));
    const marbleShadeMat = own(new THREE.MeshStandardMaterial({ color: '#e2dcd0', roughness: 0.56, flatShading: true }));
    const bronzePlaqueMat = own(new THREE.MeshStandardMaterial({ color: '#8f754f', roughness: 0.52, metalness: 0.35 }));

    // Well-proportioned ~1.9x scale Renaissance statue assembly (~0.75 world units tall)
    const davidScaleGroup = new THREE.Group();
    davidScaleGroup.scale.setScalar(1.9);
    davidHolder.add(davidScaleGroup);

    // Proportionate classical stepped marble + dark stone pedestal with molding & bronze plaque
    const stepBase = new THREE.Mesh(own(new THREE.BoxGeometry(0.126, 0.022, 0.126)), darkPlinthMat);
    stepBase.position.y = 0.011;
    stepBase.castShadow = true;
    stepBase.receiveShadow = true;
    const pedBaseMold = new THREE.Mesh(own(new THREE.BoxGeometry(0.106, 0.012, 0.106)), marbleShadeMat);
    pedBaseMold.position.y = 0.028;
    const pedShaft = new THREE.Mesh(own(new THREE.BoxGeometry(0.084, 0.088, 0.084)), marbleShadeMat);
    pedShaft.position.y = 0.078;
    pedShaft.castShadow = true;
    pedShaft.receiveShadow = true;
    const plaqueFront = new THREE.Mesh(own(new THREE.BoxGeometry(0.052, 0.04, 0.006)), bronzePlaqueMat);
    plaqueFront.position.set(0, 0.078, 0.043);
    const pedCornice = new THREE.Mesh(own(new THREE.BoxGeometry(0.102, 0.014, 0.102)), marbleMat);
    pedCornice.position.y = 0.128;
    const pedCap = new THREE.Mesh(own(new THREE.BoxGeometry(0.11, 0.016, 0.11)), darkPlinthMat);
    pedCap.position.y = 0.142;
    davidScaleGroup.add(stepBase, pedBaseMold, pedShaft, plaqueFront, pedCornice, pedCap);

    // Detailed standing Michelangelo's David in classic contrapposto!
    const davidFig = new THREE.Group();
    davidFig.position.y = 0.15;

    // Sculpted marble base slab under feet
    const footBase = new THREE.Mesh(own(new THREE.CylinderGeometry(0.048, 0.052, 0.012, 8)), marbleShadeMat);
    footBase.position.y = 0.006;
    davidFig.add(footBase);

    // Detailed Right (weight-bearing) Leg: foot, calf taper, knee, thigh + tree-stump support
    const footR = new THREE.Mesh(own(new THREE.BoxGeometry(0.018, 0.01, 0.03)), marbleMat);
    footR.position.set(0.016, 0.014, 0.006);
    const calfR = new THREE.Mesh(own(new THREE.CylinderGeometry(0.013, 0.0095, 0.046, 7)), marbleMat);
    calfR.position.set(0.016, 0.042, 0);
    calfR.castShadow = true;
    const kneeR = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.013, 0)), marbleMat);
    kneeR.position.set(0.016, 0.066, 0.003);
    const thighR = new THREE.Mesh(own(new THREE.CylinderGeometry(0.016, 0.013, 0.048, 7)), marbleMat);
    thighR.position.set(0.015, 0.09, 0);
    thighR.castShadow = true;

    // Carved marble tree-stump brace behind right leg
    const stump = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.016, 0.072, 6)), marbleShadeMat);
    stump.position.set(0.031, 0.04, -0.011);
    stump.castShadow = true;

    // Detailed Left (free) Leg: stepped back & bent gracefully at knee
    const thighL = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0155, 0.0125, 0.046, 7)), marbleMat);
    thighL.position.set(-0.017, 0.088, 0.008);
    thighL.rotation.x = -0.22;
    thighL.rotation.z = 0.06;
    thighL.castShadow = true;
    const kneeL = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.0125, 0)), marbleMat);
    kneeL.position.set(-0.02, 0.064, 0.017);
    const calfL = new THREE.Mesh(own(new THREE.CylinderGeometry(0.012, 0.009, 0.046, 7)), marbleMat);
    calfL.position.set(-0.021, 0.04, 0.011);
    calfL.rotation.x = 0.2;
    calfL.castShadow = true;
    const footL = new THREE.Mesh(own(new THREE.BoxGeometry(0.018, 0.01, 0.028)), marbleMat);
    footL.position.set(-0.021, 0.014, 0.008);

    davidFig.add(footR, calfR, kneeR, thighR, stump, thighL, kneeL, calfL, footL);

    // Detailed anatomical torso: pelvis, sculpted waist/abs, broad ribcage & pectoral planes
    const pelvis = new THREE.Mesh(own(new THREE.CylinderGeometry(0.028, 0.031, 0.028, 8)), marbleMat);
    pelvis.scale.set(1.08, 1, 0.68);
    pelvis.position.y = 0.114;
    pelvis.rotation.z = -0.07;
    const abdomen = new THREE.Mesh(own(new THREE.CylinderGeometry(0.031, 0.026, 0.034, 8)), marbleMat);
    abdomen.scale.set(1.05, 1, 0.66);
    abdomen.position.y = 0.14;
    abdomen.castShadow = true;
    const ribcage = new THREE.Mesh(own(new THREE.CylinderGeometry(0.039, 0.031, 0.044, 8)), marbleMat);
    ribcage.scale.set(1.12, 1, 0.68);
    ribcage.position.y = 0.174;
    ribcage.rotation.z = 0.05;
    ribcage.castShadow = true;
    // Sculpted chest/pectoral planes & subtle rib definition
    for (const side of [-1, 1]) {
      const pec = new THREE.Mesh(own(new THREE.BoxGeometry(0.028, 0.02, 0.014)), marbleMat);
      pec.position.set(side * 0.016, 0.178, 0.018);
      pec.rotation.y = side * -0.14;
      davidFig.add(pec);
    }
    davidFig.add(pelvis, abdomen, ribcage);

    // Right arm hanging by thigh with Michelangelo's famously large stone-gripping hand!
    const shoulderR = new THREE.Mesh(own(new THREE.SphereGeometry(0.013, 6, 5)), marbleMat);
    shoulderR.position.set(0.044, 0.186, 0);
    const upperArmR = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.0095, 0.044, 6)), marbleMat);
    upperArmR.position.set(0.047, 0.162, 0.002);
    upperArmR.rotation.z = 0.08;
    upperArmR.castShadow = true;
    const foreArmR = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0095, 0.008, 0.042, 6)), marbleMat);
    foreArmR.position.set(0.048, 0.125, 0.008);
    foreArmR.rotation.x = -0.18;
    const handR = new THREE.Mesh(own(new THREE.BoxGeometry(0.014, 0.022, 0.016)), marbleMat);
    handR.position.set(0.046, 0.10, 0.013);
    const stoneInHand = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.009, 0)), marbleShadeMat);
    stoneInHand.position.set(0.046, 0.092, 0.017);

    // Left arm raised & bent, hand holding the leather/marble sling on shoulder
    const shoulderL = new THREE.Mesh(own(new THREE.SphereGeometry(0.013, 6, 5)), marbleMat);
    shoulderL.position.set(-0.044, 0.188, 0.002);
    const upperArmL = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.0095, 0.044, 6)), marbleMat);
    upperArmL.position.set(-0.047, 0.168, 0.012);
    upperArmL.rotation.z = -0.22;
    upperArmL.rotation.x = -0.35;
    upperArmL.castShadow = true;
    const foreArmL = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0095, 0.008, 0.044, 6)), marbleMat);
    foreArmL.position.set(-0.036, 0.188, 0.024);
    foreArmL.rotation.z = 0.78;
    foreArmL.rotation.x = -0.52;
    const handL = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.011, 0)), marbleMat);
    handL.position.set(-0.024, 0.201, 0.022);

    // Marble sling draped from left hand over shoulder & down David's back
    const slingFront = new THREE.Mesh(own(new THREE.BoxGeometry(0.013, 0.026, 0.012)), marbleShadeMat);
    slingFront.position.set(-0.024, 0.194, 0.018);
    const slingBack = new THREE.Mesh(own(new THREE.BoxGeometry(0.014, 0.088, 0.01)), marbleShadeMat);
    slingBack.position.set(0.004, 0.155, -0.026);
    slingBack.rotation.z = 0.45;
    davidFig.add(
      shoulderR, upperArmR, foreArmR, handR, stoneInHand,
      shoulderL, upperArmL, foreArmL, handL, slingFront, slingBack
    );

    // Detailed Head turned defiantly left: muscular neck, nose, brow ridge, chin, curly locks
    const neck = new THREE.Mesh(own(new THREE.CylinderGeometry(0.012, 0.014, 0.022, 7)), marbleMat);
    neck.position.y = 0.203;
    const headGroup = new THREE.Group();
    headGroup.position.y = 0.228;
    headGroup.rotation.y = 0.36;
    const dCranium = new THREE.Mesh(own(new THREE.BoxGeometry(0.034, 0.04, 0.036)), marbleMat);
    dCranium.castShadow = true;
    const dJaw = new THREE.Mesh(own(new THREE.BoxGeometry(0.026, 0.016, 0.028)), marbleMat);
    dJaw.position.set(0, -0.014, 0.005);
    const dBrow = new THREE.Mesh(own(new THREE.BoxGeometry(0.026, 0.006, 0.01)), marbleShadeMat);
    dBrow.position.set(0, 0.007, 0.017);
    const dNose = new THREE.Mesh(own(new THREE.BoxGeometry(0.006, 0.014, 0.01)), marbleMat);
    dNose.position.set(0, -0.001, 0.02);
    headGroup.add(dCranium, dJaw, dBrow, dNose);

    // Layered Renaissance curly marble hair cluster!
    const curlOffsets: [number, number, number, number][] = [
      [0, 0.022, 0.002, 0.015],
      [-0.014, 0.019, 0.008, 0.013],
      [0.014, 0.019, 0.008, 0.013],
      [-0.018, 0.008, 0.002, 0.012],
      [0.018, 0.008, 0.002, 0.012],
      [-0.015, 0.012, -0.014, 0.013],
      [0.015, 0.012, -0.014, 0.013],
      [0, 0.015, -0.018, 0.014],
      [-0.012, -0.004, -0.017, 0.012],
      [0.012, -0.004, -0.017, 0.012],
      [0, -0.004, -0.018, 0.012],
      [-0.008, 0.022, 0.014, 0.011],
      [0.008, 0.022, 0.014, 0.011],
    ];
    for (const [cx, cy, cz, cr] of curlOffsets) {
      const curl = new THREE.Mesh(own(new THREE.DodecahedronGeometry(cr, 0)), marbleMat);
      curl.position.set(cx, cy, cz);
      curl.castShadow = true;
      headGroup.add(curl);
    }
    davidFig.add(neck, headGroup);

    davidScaleGroup.add(davidFig);

    const spotLight = new THREE.PointLight('#fff0d2', 0.4, 2.0, 2);
    spotLight.position.set(0, 0.72, 0.28);
    davidHolder.add(spotLight);

    // Two Younger, Smaller Confused Minks standing before David with sparse tiny pixel '?' marks!
    const [minkA, minkB] = agents.david;
    placeAtLandmark(minkA, davidDir, -0.14, 0.26, true);
    placeAtLandmark(minkB, davidDir, 0.15, 0.25, true);

    const qMarkTex = createPixelArtTexture(9, 12, (px) => {
      // Crisp tiny pixel question mark with subtle dark outline so it reads clearly against sky or grass
      px(2, 0, 5, 1, '#261e18');
      px(1, 1, 2, 3, '#261e18');
      px(6, 1, 2, 4, '#261e18');
      px(4, 4, 3, 2, '#261e18');
      px(3, 6, 3, 2, '#261e18');
      px(3, 9, 3, 3, '#261e18');
      // Bright cream-gold '?' center
      px(3, 1, 3, 1, '#ffe066');
      px(2, 2, 1, 1, '#ffe066');
      px(6, 2, 1, 2, '#ffe066');
      px(4, 4, 2, 1, '#ffe066');
      px(4, 5, 1, 2, '#ffe066');
      px(4, 10, 1, 1, '#ffe066');
    });

    interface FloatingQ {
      sprite: THREE.Sprite;
      owner: MinkAgent;
      phase: number;
      sideX: number;
    }
    // Sparse: 1 tiny '?' sprite per young mink on a slow staggered cycle
    const qMarks: FloatingQ[] = [];
    for (const [owner, phase, sideX] of [
      [minkA, 0.0, -0.02],
      [minkB, 0.5, 0.02],
    ] as [MinkAgent, number, number][]) {
      const sMat = own(new THREE.SpriteMaterial({
        map: qMarkTex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }));
      const sp = new THREE.Sprite(sMat);
      sp.scale.set(0.036, 0.048, 1);
      planetGroup.add(sp);
      qMarks.push({ sprite: sp, owner, phase, sideX });
    }

    let davidCuriousBoost = 0;
    let davidClock = 0;
    const davidHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.18, 0.2, 0.82, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    davidHit.position.y = 0.41;
    davidHolder.add(davidHit);
    const triggerDavidTap = () => {
      davidCuriousBoost = 2.8;
      minkA.poke(davidDir);
      minkB.poke(davidDir);
    };
    minkA.onTap = triggerDavidTap;
    minkB.onTap = triggerDavidTap;
    interactiveProps.push(
      { mesh: davidScaleGroup, onTap: triggerDavidTap },
      { mesh: davidHit, onTap: triggerDavidTap }
    );

    const tmpUp = new THREE.Vector3();
    const tmpRight = new THREE.Vector3();
    controllers.push({
      update(dt) {
        davidClock += dt;
        const elapsed = davidClock;
        if (davidCuriousBoost > 0) davidCuriousBoost = Math.max(0, davidCuriousBoost - dt);
        spotLight.intensity = davidCuriousBoost > 0 ? 1.25 : 0.45;

        for (const m of [minkA, minkB]) {
          m.faceTowardDir(davidDir, dt, 5.5);
          m.speed = 0;
          m.poseState = davidCuriousBoost > 1.9 ? 'hop' : 'confused';
          m.setGlanceToward(davidDir);
        }

        // Sparse floating '?' marks: brief gentle pop over a slow staggered cycle
        for (const q of qMarks) {
          const speed = davidCuriousBoost > 0 ? 0.85 : 0.24;
          const cycle = (elapsed * speed + q.phase) % 1;
          const activeWindow = davidCuriousBoost > 0 ? 0.72 : 0.36;
          if (cycle > activeWindow) {
            q.sprite.visible = false;
            continue;
          }
          q.sprite.visible = true;
          const tNorm = cycle / activeWindow;
          tmpUp.copy(q.owner.dir).normalize();
          tmpRight.crossVectors(tmpUp, q.owner.forward).normalize();
          const surfH = getTerrainHeight(tmpUp);
          const alt = 0.17 + tNorm * 0.11;
          const sway = Math.sin(tNorm * Math.PI * 2 + q.phase * 6) * 0.01 + q.sideX * (0.5 + tNorm * 0.5);
          q.sprite.position.copy(tmpUp).multiplyScalar(surfH + alt).addScaledVector(tmpRight, sway);
          const fade = Math.sin(tNorm * Math.PI);
          (q.sprite.material as THREE.SpriteMaterial).opacity = Math.min(1, fade * 1.35);
          const popScale = (0.72 + 0.32 * fade) * (davidCuriousBoost > 0 ? 1.25 : 1.0);
          q.sprite.scale.set(0.036 * popScale, 0.048 * popScale, 1);
        }
      },
    });
  }

  // SCENE 15: PILLAR 01 · ARTISTIC AMBITION — THE PAINTER'S EASEL STUDIO
  {
    const painterDir = WORLD_CONFIG.landmarks.painter.dir;
    const painterHolder = attachOnSurface(planetGroup, painterDir, -0.01, 0.25);

    // Woven terracotta clay mat grounding the studio
    const rugMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#9a5a3a', roughness: 0.96 })), 0.34, 5.0);
    const rug = new THREE.Mesh(own(new THREE.CylinderGeometry(0.24, 0.25, 0.012, 12)), rugMat);
    rug.position.y = 0.004;
    rug.receiveShadow = true;
    painterHolder.add(rug);

    // A-Frame Wooden Easel
    const easel = new THREE.Group();
    easel.position.set(0.02, 0, -0.04);
    const legL = new THREE.Mesh(own(new THREE.BoxGeometry(0.016, 0.28, 0.016)), mats.wood);
    legL.position.set(-0.055, 0.135, 0.02);
    legL.rotation.z = -0.14;
    legL.rotation.x = 0.14;
    legL.castShadow = true;
    const legR = legL.clone();
    legR.position.x = 0.055;
    legR.rotation.z = 0.14;
    const legBack = new THREE.Mesh(own(new THREE.BoxGeometry(0.014, 0.26, 0.014)), mats.wood);
    legBack.position.set(0, 0.125, -0.065);
    legBack.rotation.x = -0.34;
    legBack.castShadow = true;
    const tray = new THREE.Mesh(own(new THREE.BoxGeometry(0.16, 0.014, 0.032)), mats.woodLight);
    tray.position.set(0, 0.11, 0.035);
    tray.castShadow = true;
    easel.add(legL, legR, legBack, tray);

    // Crisp Pixel-Art Canvas Plates (tap to cycle paintings!)
    const makeCanvasTex = (variant: number) =>
      createPixelArtTexture(16, 16, (px) => {
        px(0, 0, 16, 16, '#efe6d5');
        px(0, 0, 16, 1, '#d4c6b0');
        px(0, 15, 16, 1, '#d4c6b0');
        px(0, 0, 1, 16, '#d4c6b0');
        px(15, 0, 1, 16, '#d4c6b0');
        if (variant === 0) {
          // Warm terracotta sun circle (echoes Pillar 01 pixel card!)
          px(5, 4, 6, 6, '#b86843');
          px(4, 5, 8, 4, '#b86843');
          px(6, 5, 4, 4, '#d98457');
        } else if (variant === 1) {
          // Night sky + orange moon & hills
          px(1, 1, 14, 9, '#2b3252');
          px(1, 10, 14, 5, '#556f49');
          px(10, 3, 3, 3, '#f26d13');
        } else {
          // Minimalist orange mink portrait study
          px(5, 5, 6, 7, '#f26d13');
          px(6, 4, 2, 2, '#f26d13');
          px(9, 4, 2, 2, '#f26d13');
          px(7, 8, 2, 4, '#faebd0');
        }
      });

    const paintingTextures = [makeCanvasTex(0), makeCanvasTex(1), makeCanvasTex(2)];
    let paintingIdx = 0;
    const artPlaneMat = own(new THREE.MeshStandardMaterial({ map: paintingTextures[0], roughness: 0.9 }));
    const canvasFrame = new THREE.Mesh(own(new THREE.BoxGeometry(0.145, 0.155, 0.014)), mats.woodLight);
    canvasFrame.position.set(0, 0.19, 0.02);
    canvasFrame.rotation.x = -0.15;
    canvasFrame.castShadow = true;
    const artFace = new THREE.Mesh(own(new THREE.PlaneGeometry(0.128, 0.138)), artPlaneMat);
    artFace.position.set(0, 0.19, 0.028);
    artFace.rotation.x = -0.15;
    easel.add(canvasFrame, artFace);
    painterHolder.add(easel);

    // Tiny wooden paint palette + clay brush jar on the right
    const palette = new THREE.Mesh(own(new THREE.CylinderGeometry(0.042, 0.042, 0.008, 10)), mats.woodLight);
    palette.position.set(0.14, 0.015, 0.05);
    painterHolder.add(palette);
    for (const [pxx, pzz, pcol] of [
      [0.128, 0.04, '#f26d13'],
      [0.15, 0.045, '#bf9462'],
      [0.14, 0.064, '#556f49'],
    ] as [number, number, string][]) {
      const dab = new THREE.Mesh(
        own(new THREE.SphereGeometry(0.009, 6, 5)),
        own(new THREE.MeshStandardMaterial({ color: pcol, roughness: 0.85 }))
      );
      dab.scale.y = 0.45;
      dab.position.set(pxx, 0.02, pzz);
      painterHolder.add(dab);
    }

    const [sienna] = agents.painter;
    const easelWorldCenter = new THREE.Vector3(0.02, 0, -0.04).applyQuaternion(painterHolder.quaternion).add(painterHolder.position).normalize();
    placeAtLandmark(sienna, painterDir, 0.08, 0.08, true);

    // Held tiny wooden paintbrush in Sienna's paw
    const brushGroup = new THREE.Group();
    const brushHandle = new THREE.Mesh(own(new THREE.CylinderGeometry(0.004, 0.006, 0.075, 5)), mats.woodLight);
    brushHandle.position.y = 0.036;
    const brushTip = new THREE.Mesh(own(new THREE.ConeGeometry(0.007, 0.018, 5)), mats.rose);
    brushTip.position.y = 0.08;
    brushGroup.add(brushHandle, brushTip);
    sienna.rig.propAnchor.add(brushGroup);
    brushGroup.position.set(0.032, 0.005, 0.02);
    brushGroup.rotation.set(0.75, 0, -0.2);

    let paintBurst = 0;
    const painterHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.16, 0.18, 0.34, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    painterHit.position.set(0.03, 0.16, 0.02);
    painterHolder.add(painterHit);

    const triggerPainterTap = () => {
      paintingIdx = (paintingIdx + 1) % paintingTextures.length;
      artPlaneMat.map = paintingTextures[paintingIdx];
      artPlaneMat.needsUpdate = true;
      paintBurst = 2.0;
      sienna.poke(easelWorldCenter);
    };
    sienna.onTap = triggerPainterTap;
    interactiveProps.push({ mesh: easel, onTap: triggerPainterTap }, { mesh: painterHit, onTap: triggerPainterTap });

    controllers.push({
      update(dt: number, nightFactor: number) {
        if (paintBurst > 0) paintBurst = Math.max(0, paintBurst - dt);
        if (nightFactor > 0.72 && !sienna.interrupted && paintBurst <= 0) {
          sienna.speed = 0;
          sienna.poseState = 'sleep';
          brushGroup.visible = false;
          return;
        }
        brushGroup.visible = true;
        sienna.faceTowardDir(easelWorldCenter, dt, 6.0);
        sienna.speed = 0;
        sienna.poseState = paintBurst > 1.3 ? 'hop' : 'paint';
      },
    });
  }

  // SCENE 16: PILLAR 02 · LIQUID SOFTWARE — THE TINKERER'S WORKBENCH
  {
    const tinkDir = WORLD_CONFIG.landmarks.tinkerer.dir;
    const tinkHolder = attachOnSurface(planetGroup, tinkDir, -0.01, -0.35);

    const stoneSlab = new THREE.Mesh(own(new THREE.BoxGeometry(0.24, 0.032, 0.16)), mats.stone);
    stoneSlab.position.y = 0.014;
    stoneSlab.castShadow = true;
    stoneSlab.receiveShadow = true;
    tinkHolder.add(stoneSlab);

    const ochreBlockMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#c49658', roughness: 0.94 })), 0.35, 5.0);
    const slateBlockMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#5b6c7a', roughness: 0.94 })), 0.35, 5.0);
    const terraBlockMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#a66846', roughness: 0.94 })), 0.35, 5.0);

    // Modular stackable blocks + brass wrench
    const blocks: THREE.Mesh[] = [];
    const blockConfigs: [number, number, number, THREE.Material][] = [
      [-0.045, 0.048, -0.01, slateBlockMat],
      [-0.045, 0.088, -0.01, ochreBlockMat],
      [-0.045, 0.128, -0.01, terraBlockMat],
      [0.035, 0.048, 0.025, ochreBlockMat],
    ];
    for (const [bx, by, bz, bmat] of blockConfigs) {
      const blk = new THREE.Mesh(own(new THREE.BoxGeometry(0.046, 0.038, 0.046)), bmat);
      blk.position.set(bx, by, bz);
      blk.castShadow = true;
      blk.receiveShadow = true;
      tinkHolder.add(blk);
      blocks.push(blk);
    }
    const wrench = new THREE.Mesh(own(new THREE.BoxGeometry(0.072, 0.012, 0.016)), mats.brass);
    wrench.position.set(0.055, 0.036, -0.025);
    wrench.rotation.y = 0.55;
    wrench.castShadow = true;
    tinkHolder.add(wrench);

    const [cora] = agents.tinkerer;
    placeAtLandmark(cora, tinkDir, 0.07, 0.09, true);

    let tinkConfigIdx = 0;
    let tinkClock = 0;
    let tinkBoost = 0;
    const tinkConfigs: [number, number, number][][] = [
      [[-0.045, 0.048, -0.01], [-0.045, 0.088, -0.01], [-0.045, 0.128, -0.01], [0.035, 0.048, 0.025]],
      [[-0.055, 0.048, 0.0], [0.015, 0.048, 0.0], [-0.02, 0.088, 0.0], [-0.02, 0.128, 0.0]],
      [[0.03, 0.048, -0.015], [0.03, 0.088, -0.015], [-0.05, 0.048, 0.02], [-0.05, 0.088, 0.02]],
    ];

    const tinkHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.16, 0.18, 0.24, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    tinkHit.position.y = 0.1;
    tinkHolder.add(tinkHit);

    const triggerTinkTap = () => {
      tinkConfigIdx = (tinkConfigIdx + 1) % tinkConfigs.length;
      tinkBoost = 1.8;
      cora.poke(tinkDir);
    };
    cora.onTap = triggerTinkTap;
    interactiveProps.push({ mesh: stoneSlab, onTap: triggerTinkTap }, { mesh: tinkHit, onTap: triggerTinkTap });

    controllers.push({
      update(dt: number, nightFactor: number) {
        tinkClock += dt;
        if (tinkBoost > 0) tinkBoost = Math.max(0, tinkBoost - dt);
        if (tinkClock > 9.5) {
          tinkClock = 0;
          tinkConfigIdx = (tinkConfigIdx + 1) % tinkConfigs.length;
        }
        const targetPts = tinkConfigs[tinkConfigIdx];
        blocks.forEach((b, idx) => {
          const [tx, ty, tz] = targetPts[idx];
          b.position.lerp(new THREE.Vector3(tx, ty, tz), 1 - Math.exp(-6.5 * dt));
        });

        if (nightFactor > 0.72 && !cora.interrupted) {
          cora.speed = 0;
          cora.poseState = 'sleep';
          return;
        }
        cora.faceTowardDir(tinkDir, dt, 6.0);
        cora.speed = 0;
        cora.poseState = tinkBoost > 1.1 ? 'hop' : 'tinker';
      },
    });
  }

  // SCENE 17: PILLAR 03 · COMPOUNDING INTELLIGENCE — GARDEN LIBRARY
  {
    const keeperDir = WORLD_CONFIG.landmarks.keeper.dir;
    const keeperHolder = attachOnSurface(planetGroup, keeperDir, -0.01, 0.35);

    const gardenStone = new THREE.Mesh(own(new THREE.CylinderGeometry(0.22, 0.24, 0.025, 10)), mats.stone);
    gardenStone.position.y = 0.008;
    gardenStone.receiveShadow = true;
    keeperHolder.add(gardenStone);

    // Growing stack of 4 matte hardcover books (echoing Pillar 03)
    const bookColors = ['#4d5f72', '#556f49', '#a66846', '#bf9462'];
    const bookStack = new THREE.Group();
    bookStack.position.set(0, 0.02, 0);
    bookColors.forEach((col, i) => {
      const coverMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: col, roughness: 0.94 })), 0.35, 5.0);
      const book = new THREE.Mesh(own(new THREE.BoxGeometry(0.115 - i * 0.006, 0.022, 0.086 - i * 0.004)), coverMat);
      book.position.set((i % 2 === 0 ? 1 : -1) * 0.006, 0.011 + i * 0.023, 0);
      book.rotation.y = (i - 1.5) * 0.14;
      book.castShadow = true;
      book.receiveShadow = true;
      bookStack.add(book);
      const pages = new THREE.Mesh(own(new THREE.BoxGeometry(0.106 - i * 0.006, 0.014, 0.078 - i * 0.004)), mats.ceramic);
      pages.position.copy(book.position);
      pages.rotation.copy(book.rotation);
      bookStack.add(pages);
    });
    keeperHolder.add(bookStack);

    // Tiny cozy garden blooms & mossy border stones
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4;
      const bloom = new THREE.Mesh(own(new THREE.SphereGeometry(0.016, 6, 5)), i % 2 === 0 ? mats.leafA : mats.boxGold);
      bloom.scale.y = 0.6;
      bloom.position.set(Math.cos(a) * 0.19, 0.02, Math.sin(a) * 0.19);
      keeperHolder.add(bloom);
    }

    // Subtle non-neon muted gold pixel sparkles above the book stack
    const sparkleTex = createPixelArtTexture(7, 7, (px) => {
      px(3, 0, 1, 7, '#e6cc8a');
      px(0, 3, 7, 1, '#e6cc8a');
      px(2, 2, 3, 3, '#f7ebd0');
    });
    const sparkles: { sp: THREE.Sprite; phase: number; r: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const sp = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: sparkleTex, transparent: true, opacity: 0.72, depthWrite: false })));
      sp.scale.set(0.032, 0.032, 1);
      keeperHolder.add(sp);
      sparkles.push({ sp, phase: i * 2.1, r: 0.08 + i * 0.025 });
    }

    const [lark] = agents.keeper;
    lark.surfaceLift = 0.018;
    placeAtLandmark(lark, keeperDir, -0.03, 0.08, true);

    // Held tiny open book in Lark's paws
    const heldBook = new THREE.Group();
    const hbL = new THREE.Mesh(own(new THREE.BoxGeometry(0.038, 0.007, 0.048)), mats.ceramic);
    hbL.position.x = -0.019;
    hbL.rotation.z = 0.25;
    const hbR = hbL.clone();
    hbR.position.x = 0.019;
    hbR.rotation.z = -0.25;
    heldBook.add(hbL, hbR);
    lark.rig.propAnchor.add(heldBook);
    heldBook.position.set(0, -0.005, 0.045);

    let keeperBurst = 0;
    let keeperClock = 0;
    const keeperHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.18, 0.2, 0.26, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    keeperHit.position.y = 0.12;
    keeperHolder.add(keeperHit);

    const triggerKeeperTap = () => {
      keeperBurst = 2.4;
      lark.poke(keeperDir);
    };
    lark.onTap = triggerKeeperTap;
    interactiveProps.push({ mesh: bookStack, onTap: triggerKeeperTap }, { mesh: keeperHit, onTap: triggerKeeperTap });

    controllers.push({
      update(dt: number, nightFactor: number) {
        keeperClock += dt;
        if (keeperBurst > 0) keeperBurst = Math.max(0, keeperBurst - dt);
        sparkles.forEach((s, idx) => {
          const cycle = keeperClock * 0.9 + s.phase;
          const a = cycle * 0.7;
          s.sp.position.set(Math.cos(a) * s.r, 0.22 + Math.sin(cycle * 2.1) * 0.04 + idx * 0.03, Math.sin(a) * s.r);
          const fade = 0.35 + 0.45 * (0.5 + 0.5 * Math.sin(cycle * 2.5));
          (s.sp.material as THREE.SpriteMaterial).opacity = keeperBurst > 0 ? Math.min(0.95, fade + 0.3) : fade;
        });

        if (nightFactor > 0.72 && !lark.interrupted) {
          lark.speed = 0;
          lark.poseState = 'sleep';
          heldBook.visible = false;
          return;
        }
        heldBook.visible = true;
        lark.faceTowardDir(keeperDir, dt, 5.5);
        lark.speed = 0;
        lark.poseState = keeperBurst > 1.6 ? 'hop' : 'read';
      },
    });
  }

  // SCENE 18: PILLAR 04 · SHARED ENDEAVOUR — THE HELPING HAND ROCKY RIDGE
  {
    const helpDir = WORLD_CONFIG.landmarks.helping.dir;
    const helpHolder = attachOnSurface(planetGroup, helpDir, -0.025, 2.35);

    const slateRockMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#6b7e8d', roughness: 0.96, flatShading: true })), 0.35, 5.0);
    const slateMidMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#586978', roughness: 0.96, flatShading: true })), 0.35, 5.0);
    const slateDarkMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#465463', roughness: 0.96, flatShading: true })), 0.35, 5.0);

    // Three-tier stepped slate crag echoing Pillar 04 card, sized and oriented so Rowan & Reed stay cleanly separated
    const lowerStep = new THREE.Mesh(own(new THREE.BoxGeometry(0.38, 0.13, 0.29)), slateDarkMat);
    lowerStep.position.set(-0.34, 0.055, 0.03);
    lowerStep.rotation.y = 0.08;
    lowerStep.castShadow = true;
    lowerStep.receiveShadow = true;
    helpHolder.add(lowerStep);

    const midStep = new THREE.Mesh(own(new THREE.BoxGeometry(0.30, 0.22, 0.27)), slateMidMat);
    midStep.position.set(0.0, 0.095, 0.0);
    midStep.rotation.y = -0.04;
    midStep.castShadow = true;
    midStep.receiveShadow = true;
    helpHolder.add(midStep);

    const upperLedge = new THREE.Mesh(own(new THREE.BoxGeometry(0.38, 0.32, 0.29)), slateRockMat);
    upperLedge.position.set(0.34, 0.145, -0.03);
    upperLedge.rotation.y = -0.08;
    upperLedge.castShadow = true;
    upperLedge.receiveShadow = true;
    helpHolder.add(upperLedge);

    // Small muted cream-gold pixel star above the ridge (direct visual nod to Pillar 04!)
    const starTex = createPixelArtTexture(9, 9, (px) => {
      px(4, 0, 1, 9, '#f2dfa8');
      px(0, 4, 9, 1, '#f2dfa8');
      px(3, 2, 3, 5, '#faefd0');
      px(2, 3, 5, 3, '#faefd0');
    });
    const guideStar = new THREE.Sprite(own(new THREE.SpriteMaterial({ map: starTex, transparent: true, opacity: 0.85, depthWrite: false })));
    guideStar.position.set(0.02, 0.54, 0);
    guideStar.scale.set(0.054, 0.054, 1);
    helpHolder.add(guideStar);

    // Project exact world top-surface height & angled gaze targets so Rowan perches high on upper cliff and Reed climbs below
    helpHolder.updateMatrixWorld(true);
    const [rowan, reed] = agents.helping;
    const upperTopWorld = new THREE.Vector3(0.38, 0.305, -0.03)
      .applyQuaternion(helpHolder.quaternion)
      .add(helpHolder.position);
    const lowerTopWorld = new THREE.Vector3(-0.37, 0.120, 0.03)
      .applyQuaternion(helpHolder.quaternion)
      .add(helpHolder.position);
    const upperSpotWorld = upperTopWorld.clone().normalize();
    const lowerSpotWorld = lowerTopWorld.clone().normalize();
    const upperLookWorld = new THREE.Vector3(-0.18, 0.120, -0.02)
      .applyQuaternion(helpHolder.quaternion)
      .add(helpHolder.position)
      .normalize();
    const lowerLookWorld = new THREE.Vector3(0.18, 0.305, 0.02)
      .applyQuaternion(helpHolder.quaternion)
      .add(helpHolder.position)
      .normalize();

    rowan.dir.copy(upperSpotWorld);
    reed.dir.copy(lowerSpotWorld);
    rowan.surfaceLift = Math.max(0, upperTopWorld.length() - getWalkableSurface(upperSpotWorld).position.length() - 0.005);
    reed.surfaceLift = Math.max(0, lowerTopWorld.length() - getWalkableSurface(lowerSpotWorld).position.length() - 0.005);
    rowan.faceTowardDir(upperLookWorld, 1.0, 20.0);
    reed.faceTowardDir(lowerLookWorld, 1.0, 20.0);
    rowan.syncTransform();
    reed.syncTransform();

    let helpCelebrate = 0;
    let helpClock = 0;
    const helpHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.44, 0.48, 0.42, 10)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    helpHit.position.y = 0.21;
    helpHolder.add(helpHit);

    const triggerHelpTap = () => {
      helpCelebrate = 2.4;
      rowan.poke(upperLookWorld);
      reed.poke(lowerLookWorld);
    };
    rowan.onTap = triggerHelpTap;
    reed.onTap = triggerHelpTap;
    interactiveProps.push(
      { mesh: lowerStep, onTap: triggerHelpTap },
      { mesh: midStep, onTap: triggerHelpTap },
      { mesh: upperLedge, onTap: triggerHelpTap },
      { mesh: helpHit, onTap: triggerHelpTap }
    );

    controllers.push({
      update(dt: number, nightFactor: number) {
        helpClock += dt;
        if (helpCelebrate > 0) helpCelebrate = Math.max(0, helpCelebrate - dt);
        guideStar.position.y = 0.54 + Math.sin(helpClock * 2.0) * 0.025;
        (guideStar.material as THREE.SpriteMaterial).opacity = 0.65 + 0.25 * Math.sin(helpClock * 2.6);

        rowan.dir.copy(upperSpotWorld);
        reed.dir.copy(lowerSpotWorld);
        rowan.surfaceLift = Math.max(0, upperTopWorld.length() - getWalkableSurface(upperSpotWorld).position.length() - 0.005);
        reed.surfaceLift = Math.max(0, lowerTopWorld.length() - getWalkableSurface(lowerSpotWorld).position.length() - 0.005);

        if (nightFactor > 0.72 && !rowan.interrupted && !reed.interrupted) {
          rowan.speed = 0;
          reed.speed = 0;
          rowan.poseState = 'sleep';
          reed.poseState = 'sleep';
          return;
        }
        rowan.faceTowardDir(upperLookWorld, dt, 6.0);
        reed.faceTowardDir(lowerLookWorld, dt, 6.0);
        rowan.speed = 0;
        reed.speed = 0;
        if (helpCelebrate > 1.5) {
          rowan.poseState = 'hop';
          reed.poseState = 'hop';
        } else {
          rowan.poseState = 'help_ledge_down';
          reed.poseState = 'help_reach_up';
        }
      },
    });
  }

  // SCENE 19: ABOVE-GROUND HILLSIDE HOBBIT HOLE WITH HINGED ROUND DOOR & CHIMNEY SMOKE
  {
    const hobbitDir = WORLD_CONFIG.landmarks.hobbit.dir;
    const hobbitHolder = attachOnSurface(planetGroup, hobbitDir, -0.012, -0.45);

    const hillMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#556f49', roughness: 0.96, flatShading: true })), 0.34, 5.0);
    const hillMossMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#657e53', roughness: 0.96, flatShading: true })), 0.34, 5.0);
    const hobbitDoorMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#4f6e48', roughness: 0.92, flatShading: true })), 0.34, 5.0);
    const chimneyMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#a66846', roughness: 0.95, flatShading: true })), 0.34, 5.0);
    const windowGlowMat = own(new THREE.MeshStandardMaterial({
      color: '#ffe3a3',
      emissive: '#e69b45',
      emissiveIntensity: 0.38,
      roughness: 0.6,
    }));

    // Grassy earthen knoll standing cleanly above the planet surface
    const hillMound = new THREE.Mesh(own(new THREE.SphereGeometry(0.28, 14, 10)), hillMat);
    hillMound.scale.set(1.22, 0.95, 1.12);
    hillMound.position.set(0, 0.095, -0.055);
    hillMound.castShadow = true;
    hillMound.receiveShadow = true;
    hobbitHolder.add(hillMound);

    const sideKnoll = new THREE.Mesh(own(new THREE.SphereGeometry(0.18, 10, 8)), hillMossMat);
    sideKnoll.scale.set(1.15, 0.8, 1.0);
    sideKnoll.position.set(-0.22, 0.055, -0.04);
    sideKnoll.castShadow = true;
    sideKnoll.receiveShadow = true;
    hobbitHolder.add(sideKnoll);

    // Protruding warm earthen & stone front porch wall around the round door
    const facadeWall = new THREE.Mesh(own(new THREE.CylinderGeometry(0.19, 0.22, 0.2, 10, 1, false, -0.9, 1.8)), mats.ceramic);
    facadeWall.position.set(0, 0.11, 0.065);
    facadeWall.rotation.y = Math.PI;
    facadeWall.castShadow = true;
    facadeWall.receiveShadow = true;
    hobbitHolder.add(facadeWall);

    // Stone arch frame & dark cozy hearth alcove behind the door
    const stoneArch = new THREE.Mesh(own(new THREE.TorusGeometry(0.105, 0.025, 7, 16, Math.PI * 1.32)), mats.stone);
    stoneArch.position.set(0, 0.11, 0.215);
    stoneArch.rotation.z = -Math.PI * 0.16;
    stoneArch.castShadow = true;
    hobbitHolder.add(stoneArch);

    const interiorGlow = new THREE.Mesh(
      own(new THREE.CircleGeometry(0.088, 16)),
      own(new THREE.MeshStandardMaterial({ color: '#3b2416', emissive: '#d6782a', emissiveIntensity: 0.45, roughness: 0.8 }))
    );
    interiorGlow.position.set(0, 0.11, 0.205);
    hobbitHolder.add(interiorGlow);

    // Hinged round green Bag-End door + brass center knob
    const doorPivot = new THREE.Group();
    doorPivot.position.set(-0.085, 0.11, 0.218);
    const doorDisc = new THREE.Mesh(own(new THREE.CylinderGeometry(0.088, 0.088, 0.018, 16)), hobbitDoorMat);
    doorDisc.rotation.x = Math.PI * 0.5;
    doorDisc.position.set(0.085, 0, 0);
    doorDisc.castShadow = true;
    doorPivot.add(doorDisc);

    const doorKnob = new THREE.Mesh(own(new THREE.SphereGeometry(0.014, 7, 6)), mats.brass);
    doorKnob.position.set(0.085, 0, 0.014);
    doorPivot.add(doorKnob);
    hobbitHolder.add(doorPivot);

    // Flanking round glowing porthole windows on the hillside facade
    for (const side of [-1, 1]) {
      const winFrame = new THREE.Mesh(own(new THREE.TorusGeometry(0.036, 0.008, 6, 12)), mats.wood);
      winFrame.position.set(side * 0.165, 0.115, 0.16);
      winFrame.rotation.y = side * 0.42;
      hobbitHolder.add(winFrame);

      const winPane = new THREE.Mesh(own(new THREE.CircleGeometry(0.032, 12)), windowGlowMat);
      winPane.position.set(side * 0.168, 0.115, 0.162);
      winPane.rotation.y = side * 0.42;
      hobbitHolder.add(winPane);
    }

    // Terracotta brick chimney protruding out the top of the grassy mound + gentle clay smoke puffs
    const chimney = new THREE.Mesh(own(new THREE.CylinderGeometry(0.025, 0.032, 0.14, 7)), chimneyMat);
    chimney.position.set(0.05, 0.345, -0.05);
    chimney.castShadow = true;
    hobbitHolder.add(chimney);

    const smokePuffs: THREE.Mesh[] = [];
    const puffMat = own(new THREE.MeshStandardMaterial({ color: '#dcd7cf', transparent: true, opacity: 0.45, roughness: 1.0 }));
    for (let i = 0; i < 4; i++) {
      const puff = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.022, 1)), own(puffMat.clone()));
      puff.position.set(0.05, 0.43 + i * 0.055, -0.05);
      hobbitHolder.add(puff);
      smokePuffs.push(puff);
    }

    // Garden stepping stones & cozy wooden bench
    for (let s = 0; s < 3; s++) {
      const step = new THREE.Mesh(own(new THREE.CylinderGeometry(0.038 - s * 0.004, 0.042, 0.014, 7)), mats.stone);
      step.position.set(s * 0.015 - 0.01, 0.016, 0.255 + s * 0.075);
      step.receiveShadow = true;
      hobbitHolder.add(step);
    }
    const bench = new THREE.Mesh(own(new THREE.BoxGeometry(0.095, 0.024, 0.038)), mats.woodLight);
    bench.position.set(-0.22, 0.028, 0.18);
    bench.rotation.y = 0.35;
    bench.castShadow = true;
    hobbitHolder.add(bench);

    // Grumpy painted-clay Hobbit living behind the door who rushes out & shakes his fist at the sky when tapped!
    const hobbitFig = new THREE.Group();
    const hobSkinMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#eec5a6', roughness: 0.9, flatShading: true })), 0.34, 5.0);
    const hobHairMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#4d3221', roughness: 0.95, flatShading: true })), 0.34, 5.0);
    const hobVestMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#7a4d2d', roughness: 0.94, flatShading: true })), 0.34, 5.0);
    const hobShirtMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#ebe0ca', roughness: 0.94, flatShading: true })), 0.34, 5.0);
    const hobPantsMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#4b6340', roughness: 0.94, flatShading: true })), 0.34, 5.0);

    for (const side of [-1, 1]) {
      const foot = new THREE.Mesh(own(new THREE.BoxGeometry(0.018, 0.01, 0.028)), hobHairMat);
      foot.position.set(side * 0.016, 0.005, 0.005);
      const leg = new THREE.Mesh(own(new THREE.CylinderGeometry(0.01, 0.009, 0.036, 5)), hobPantsMat);
      leg.position.set(side * 0.016, 0.026, 0);
      hobbitFig.add(foot, leg);
    }
    const hobTorso = new THREE.Mesh(own(new THREE.CylinderGeometry(0.025, 0.031, 0.056, 7)), hobVestMat);
    hobTorso.position.y = 0.064;
    hobTorso.castShadow = true;
    const hobShirt = new THREE.Mesh(own(new THREE.BoxGeometry(0.022, 0.048, 0.02)), hobShirtMat);
    hobShirt.position.set(0, 0.064, 0.018);
    hobbitFig.add(hobTorso, hobShirt);

    const hobArmL = new THREE.Mesh(own(new THREE.CylinderGeometry(0.008, 0.007, 0.044, 5)), hobShirtMat);
    hobArmL.position.set(-0.032, 0.062, 0.004);
    hobArmL.rotation.z = 0.24;
    hobbitFig.add(hobArmL);

    const hobFistArm = new THREE.Group();
    hobFistArm.position.set(0.03, 0.084, 0.006);
    const armUpper = new THREE.Mesh(own(new THREE.CylinderGeometry(0.008, 0.007, 0.046, 5)), hobShirtMat);
    armUpper.position.set(0.005, 0.022, 0.006);
    armUpper.rotation.z = -0.18;
    const fist = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.012, 0)), hobSkinMat);
    fist.position.set(0.009, 0.048, 0.01);
    hobFistArm.add(armUpper, fist);
    hobbitFig.add(hobFistArm);

    const hobHead = new THREE.Group();
    hobHead.position.set(0, 0.112, 0.004);
    const face = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.023, 0)), hobSkinMat);
    face.castShadow = true;
    const hair = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.025, 0)), hobHairMat);
    hair.scale.set(1.06, 0.85, 1.06);
    hair.position.set(0, 0.011, -0.005);
    const brow = new THREE.Mesh(own(new THREE.BoxGeometry(0.024, 0.005, 0.008)), hobHairMat);
    brow.position.set(0, 0.005, 0.02);
    hobHead.add(face, hair, brow);
    hobbitFig.add(hobHead);

    hobbitFig.position.set(0, 0.02, 0.14);
    hobbitFig.visible = false;
    hobbitHolder.add(hobbitFig);

    let hobbitClock = 0;
    let hobbitEventTime = -1;
    const HOBBIT_OUT_DURATION = 4.2;
    const hobbitHit = new THREE.Mesh(
      own(new THREE.SphereGeometry(0.32, 10, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    hobbitHit.position.set(0, 0.14, 0.06);
    hobbitHolder.add(hobbitHit);

    const triggerHobbitTap = () => {
      hobbitEventTime = 0;
    };
    interactiveProps.push(
      { mesh: doorDisc, onTap: triggerHobbitTap },
      { mesh: stoneArch, onTap: triggerHobbitTap },
      { mesh: hillMound, onTap: triggerHobbitTap },
      { mesh: hobbitFig, onTap: triggerHobbitTap },
      { mesh: hobbitHit, onTap: triggerHobbitTap }
    );

    controllers.push({
      update(dt: number, nightFactor: number) {
        hobbitClock += dt;
        if (hobbitEventTime >= 0) {
          hobbitEventTime += dt;
          const t = hobbitEventTime;
          if (t < HOBBIT_OUT_DURATION) {
            hobbitFig.visible = true;
            const doorOpen = smoothstep(0.0, 0.35, t) * (1 - smoothstep(3.65, 4.18, t));
            doorPivot.rotation.y = -1.42 * doorOpen;

            if (t < 0.45) {
              const p = smoothstep(0.1, 0.45, t);
              hobbitFig.position.set(0.015 * p, 0.02 + Math.abs(Math.sin(t * 18)) * 0.008, THREE.MathUtils.lerp(0.14, 0.27, p));
              hobbitFig.rotation.y = 0.06;
              hobHead.rotation.x = -0.25 * p;
              hobFistArm.rotation.x = -1.1 * p;
            } else if (t < 3.35) {
              // Standing indignantly on the doorstep shaking fist at the sky!
              const shake = Math.sin((t - 0.45) * 18.0);
              hobbitFig.position.set(0.015, 0.02 + Math.abs(Math.sin(t * 10.0)) * 0.011, 0.27);
              hobbitFig.rotation.y = 0.08 + Math.sin(t * 4.0) * 0.08;
              hobHead.rotation.x = -0.52 + shake * 0.06;
              hobFistArm.rotation.x = -0.35 + shake * 0.48;
              hobFistArm.rotation.z = -0.15 + Math.cos((t - 0.45) * 18.0) * 0.16;
            } else {
              const p = smoothstep(3.35, 3.85, t);
              hobbitFig.position.set(0.015 * (1 - p), 0.02 + Math.abs(Math.sin(t * 16)) * 0.007, THREE.MathUtils.lerp(0.27, 0.14, p));
              hobbitFig.rotation.y = THREE.MathUtils.lerp(0.08, 0, p);
              hobHead.rotation.x = THREE.MathUtils.lerp(-0.5, 0, p);
              hobFistArm.rotation.x = THREE.MathUtils.lerp(-0.35, 1.2, p);
            }
          } else {
            hobbitEventTime = -1;
            hobbitFig.visible = false;
            doorPivot.rotation.y = 0;
          }
        } else {
          doorPivot.rotation.y = THREE.MathUtils.lerp(doorPivot.rotation.y, 0, 1 - Math.exp(-7.5 * dt));
          hobbitFig.visible = false;
        }

        windowGlowMat.emissiveIntensity = 0.28 + nightFactor * 0.65;

        smokePuffs.forEach((p, idx) => {
          const cycle = (hobbitClock * 0.34 + idx * 0.25) % 1;
          p.position.set(
            0.05 + Math.sin(cycle * 5 + idx) * 0.018,
            0.425 + cycle * 0.22,
            -0.05 + cycle * 0.04
          );
          const sc = 0.55 + cycle * 1.15;
          p.scale.setScalar(sc);
          (p.material as THREE.MeshStandardMaterial).opacity = (1 - cycle) * 0.42;
        });
      },
    });
  }

  // SCENE 19: RODIN'S "THE THINKER" (Enlarged, prominent bronze statue perched on a stepped granite pedestal in the open south-left expanse!)
  {
    const thinkerDir = WORLD_CONFIG.landmarks.thinker.dir;
    const thinkerHolder = attachOnSurface(planetGroup, thinkerDir, -0.018, 0.45);

    const plinthStoneMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#61666d', roughness: 0.92, flatShading: true })), 0.34, 5.0);
    const mossPatchMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#4c6943', roughness: 0.96, flatShading: true })), 0.34, 5.0);
    const bronzeMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#474036', roughness: 0.78, flatShading: true })), 0.34, 5.0);
    const bronzePatinaMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#5c786a', roughness: 0.84, flatShading: true })), 0.34, 5.0);

    // Enlarged (~1.7x) sculptural group so Rodin's hunched chin-on-fist silhouette reads clearly across the globe
    const thinkerScaleGroup = new THREE.Group();
    thinkerScaleGroup.scale.setScalar(1.7);
    thinkerHolder.add(thinkerScaleGroup);

    const stepLow = new THREE.Mesh(own(new THREE.CylinderGeometry(0.135, 0.155, 0.035, 8)), plinthStoneMat);
    stepLow.position.y = 0.016;
    stepLow.castShadow = true;
    stepLow.receiveShadow = true;
    const stepMid = new THREE.Mesh(own(new THREE.BoxGeometry(0.15, 0.068, 0.14)), plinthStoneMat);
    stepMid.position.y = 0.064;
    stepMid.castShadow = true;
    stepMid.receiveShadow = true;
    const mossAccent = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.036, 0)), mossPatchMat);
    mossAccent.scale.set(1.2, 0.45, 1.0);
    mossAccent.position.set(-0.088, 0.036, 0.055);
    thinkerScaleGroup.add(stepLow, stepMid, mossAccent);

    // Rodin's Bronze Thinker seated hunched forward on stone block
    const thinkerFig = new THREE.Group();
    thinkerFig.position.y = 0.098;

    const stoneSeat = new THREE.Mesh(own(new THREE.BoxGeometry(0.098, 0.072, 0.092)), bronzePatinaMat);
    stoneSeat.position.set(0, 0.036, -0.012);
    stoneSeat.castShadow = true;
    thinkerFig.add(stoneSeat);

    for (const side of [-1, 1]) {
      const thigh = new THREE.Mesh(own(new THREE.CylinderGeometry(0.017, 0.015, 0.058, 6)), bronzeMat);
      thigh.rotation.x = Math.PI * 0.44;
      thigh.position.set(side * 0.025, 0.070, 0.023);
      thigh.castShadow = true;
      const calf = new THREE.Mesh(own(new THREE.CylinderGeometry(0.014, 0.010, 0.062, 6)), bronzeMat);
      calf.rotation.x = -0.18;
      calf.position.set(side * 0.025, 0.035, 0.045);
      calf.castShadow = true;
      const foot = new THREE.Mesh(own(new THREE.BoxGeometry(0.019, 0.012, 0.034)), bronzeMat);
      foot.position.set(side * 0.025, 0.006, 0.054);
      thinkerFig.add(thigh, calf, foot);
    }

    const torso = new THREE.Mesh(own(new THREE.CylinderGeometry(0.036, 0.030, 0.076, 7)), bronzeMat);
    torso.scale.set(1.12, 1.0, 0.85);
    torso.position.set(0, 0.098, 0.004);
    torso.rotation.x = 0.56;
    torso.castShadow = true;
    const shoulders = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.037, 0)), bronzePatinaMat);
    shoulders.scale.set(1.18, 0.72, 0.88);
    shoulders.position.set(0, 0.128, 0.024);
    shoulders.castShadow = true;
    thinkerFig.add(torso, shoulders);

    const upperArmR = new THREE.Mesh(own(new THREE.CylinderGeometry(0.013, 0.011, 0.058, 6)), bronzeMat);
    upperArmR.position.set(0.029, 0.10, 0.037);
    upperArmR.rotation.set(0.45, 0, -0.22);
    const foreArmR = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.0095, 0.054, 6)), bronzeMat);
    foreArmR.position.set(0.016, 0.116, 0.049);
    foreArmR.rotation.set(-0.32, 0, 0.34);
    const fistR = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.015, 0)), bronzePatinaMat);
    fistR.position.set(0.004, 0.139, 0.047);

    const upperArmL = new THREE.Mesh(own(new THREE.CylinderGeometry(0.013, 0.011, 0.056, 6)), bronzeMat);
    upperArmL.position.set(-0.033, 0.10, 0.031);
    upperArmL.rotation.set(0.35, 0, 0.18);
    const foreArmL = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.0095, 0.046, 6)), bronzeMat);
    foreArmL.position.set(-0.027, 0.074, 0.047);
    foreArmL.rotation.set(0.9, 0, -0.18);
    thinkerFig.add(upperArmR, foreArmR, fistR, upperArmL, foreArmL);

    const thinkerHead = new THREE.Group();
    thinkerHead.position.set(0, 0.158, 0.042);
    const cranium = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.025, 0)), bronzePatinaMat);
    cranium.scale.set(0.88, 1.08, 0.96);
    cranium.castShadow = true;
    const jaw = new THREE.Mesh(own(new THREE.BoxGeometry(0.025, 0.018, 0.023)), bronzeMat);
    jaw.position.set(0, -0.012, 0.008);
    thinkerHead.add(cranium, jaw);
    thinkerHead.rotation.x = 0.28;
    thinkerFig.add(thinkerHead);

    thinkerScaleGroup.add(thinkerFig);

    let thinkerClock = 0;
    let thinkerPonder = 0;
    const thinkerHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.24, 0.26, 0.56, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    thinkerHit.position.y = 0.28;
    thinkerHolder.add(thinkerHit);

    const triggerThinkerTap = () => {
      thinkerPonder = 2.4;
    };
    interactiveProps.push(
      { mesh: thinkerScaleGroup, onTap: triggerThinkerTap },
      { mesh: thinkerHit, onTap: triggerThinkerTap }
    );

    controllers.push({
      update(dt: number) {
        thinkerClock += dt;
        if (thinkerPonder > 0) thinkerPonder = Math.max(0, thinkerPonder - dt);
        const ponderNorm = thinkerPonder / 2.4;
        thinkerHead.rotation.x = 0.28 + Math.sin(thinkerClock * 0.9) * 0.03 + Math.sin(ponderNorm * Math.PI) * 0.16;
        thinkerHead.rotation.z = Math.sin(ponderNorm * Math.PI * 2) * 0.09;
      },
    });
  }

  // SCENE 20: THE IRON GIANT (Sitting lonely in a sparse grassy clearing with arms wrapped around drawn-up knees, looking sad)
  {
    const giantDir = WORLD_CONFIG.landmarks.irongiant.dir;
    const giantHolder = attachOnSurface(planetGroup, giantDir, -0.02, 0.55);

    const ironHullMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#616d78', roughness: 0.84, flatShading: true })), 0.34, 5.0);
    const ironJointMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#3f474f', roughness: 0.88, flatShading: true })), 0.34, 5.0);
    const ironRustMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#7a5945', roughness: 0.92, flatShading: true })), 0.34, 5.0);
    const ironEyeMat = own(new THREE.MeshStandardMaterial({
      color: '#ffdf9e',
      emissive: '#f2b857',
      emissiveIntensity: 0.55,
      roughness: 0.35,
    }));

    const giantScale = new THREE.Group();
    giantScale.scale.setScalar(1.38);
    giantHolder.add(giantScale);

    // Pelvis seated directly on the natural green grass (no flat disc underneath)
    const pelvis = new THREE.Mesh(own(new THREE.CylinderGeometry(0.056, 0.064, 0.044, 8)), ironJointMat);
    pelvis.position.set(0, 0.028, -0.028);
    pelvis.castShadow = true;
    giantScale.add(pelvis);

    // Drawn-up knees & planted heavy iron feet
    for (const side of [-1, 1]) {
      const thigh = new THREE.Mesh(own(new THREE.CylinderGeometry(0.026, 0.029, 0.135, 7)), ironHullMat);
      thigh.position.set(side * 0.056, 0.084, 0.022);
      thigh.rotation.x = 0.88;
      thigh.rotation.z = -side * 0.06;
      thigh.castShadow = true;
      giantScale.add(thigh);

      const kneeCap = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.032, 0)), ironJointMat);
      kneeCap.position.set(side * 0.06, 0.134, 0.078);
      kneeCap.castShadow = true;
      giantScale.add(kneeCap);

      const shin = new THREE.Mesh(own(new THREE.CylinderGeometry(0.028, 0.034, 0.128, 7)), ironHullMat);
      shin.position.set(side * 0.06, 0.068, 0.095);
      shin.rotation.x = -0.22;
      shin.castShadow = true;
      giantScale.add(shin);

      const foot = new THREE.Mesh(own(new THREE.BoxGeometry(0.048, 0.024, 0.072)), ironJointMat);
      foot.position.set(side * 0.06, 0.013, 0.118);
      foot.castShadow = true;
      giantScale.add(foot);
    }

    // Slumped broad ribbed upper torso & shoulders (pivoted at waist for heavy sad breathing sigh)
    const giantTorsoPivot = new THREE.Group();
    giantTorsoPivot.position.set(0, 0.055, -0.032);
    giantTorsoPivot.rotation.x = 0.34; // hunched forward over drawn-up knees

    const waist = new THREE.Mesh(own(new THREE.CylinderGeometry(0.046, 0.05, 0.046, 8)), ironJointMat);
    waist.position.set(0, 0.025, 0);
    giantTorsoPivot.add(waist);

    const chest = new THREE.Mesh(own(new THREE.CylinderGeometry(0.082, 0.054, 0.118, 8)), ironHullMat);
    chest.scale.set(1.18, 1.0, 0.78);
    chest.position.set(0, 0.098, 0);
    chest.castShadow = true;
    giantTorsoPivot.add(chest);

    // Signature chest plate & subtle rust/rivet trim
    const chestPlate = new THREE.Mesh(own(new THREE.BoxGeometry(0.074, 0.052, 0.018)), ironRustMat);
    chestPlate.position.set(0, 0.112, 0.06);
    giantTorsoPivot.add(chestPlate);

    for (const side of [-1, 1]) {
      const pauldron = new THREE.Mesh(own(new THREE.SphereGeometry(0.038, 8, 6)), ironHullMat);
      pauldron.scale.set(1.05, 0.85, 0.95);
      pauldron.position.set(side * 0.096, 0.145, 0);
      pauldron.castShadow = true;
      giantTorsoPivot.add(pauldron);
    }

    // Arms wrapped forward and hugged tightly across his drawn-up shins/knees!
    for (const side of [-1, 1]) {
      const upperArm = new THREE.Mesh(own(new THREE.CylinderGeometry(0.021, 0.018, 0.112, 7)), ironHullMat);
      upperArm.position.set(side * 0.098, 0.088, 0.024);
      upperArm.rotation.set(-0.42, 0, side * 0.12);
      upperArm.castShadow = true;
      giantTorsoPivot.add(upperArm);

      // Forearms wrapping inward around the front of his knees
      const foreArm = new THREE.Mesh(own(new THREE.CylinderGeometry(0.02, 0.016, 0.128, 7)), ironHullMat);
      foreArm.position.set(side * 0.038, 0.045, 0.088 + (side > 0 ? 0.012 : -0.004));
      foreArm.rotation.set(0.18, side * 0.34, side * 1.18);
      foreArm.castShadow = true;
      giantTorsoPivot.add(foreArm);

      const handClamp = new THREE.Mesh(own(new THREE.BoxGeometry(0.032, 0.026, 0.024)), ironJointMat);
      handClamp.position.set(-side * 0.024, 0.028 + (side > 0 ? 0.01 : -0.006), 0.106);
      handClamp.rotation.y = side * 0.4;
      giantTorsoPivot.add(handClamp);
    }

    // Iconic Iron Giant dome head with central dorsal fin, hinged jaw & wistful glowing round eyes looking down
    const giantHeadPivot = new THREE.Group();
    giantHeadPivot.position.set(0, 0.172, 0.012);
    giantHeadPivot.rotation.x = 0.42; // bowed downward in sadness

    const cranium = new THREE.Mesh(own(new THREE.CylinderGeometry(0.034, 0.036, 0.044, 10)), ironHullMat);
    cranium.position.y = 0.026;
    cranium.castShadow = true;
    const domeTop = new THREE.Mesh(own(new THREE.SphereGeometry(0.034, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)), ironHullMat);
    domeTop.position.y = 0.047;
    domeTop.castShadow = true;
    const headFin = new THREE.Mesh(own(new THREE.BoxGeometry(0.008, 0.028, 0.056)), ironRustMat);
    headFin.position.set(0, 0.068, -0.004);
    const chinJaw = new THREE.Mesh(own(new THREE.BoxGeometry(0.046, 0.02, 0.048)), ironJointMat);
    chinJaw.position.set(0, -0.002, 0.006);
    chinJaw.rotation.x = 0.12; // slightly slack sad jaw
    giantHeadPivot.add(cranium, domeTop, headFin, chinJaw);

    for (const side of [-1, 1]) {
      const earPod = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.011, 0.014, 8)), ironJointMat);
      earPod.rotation.z = Math.PI * 0.5;
      earPod.position.set(side * 0.038, 0.022, 0);
      const eyeRim = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.011, 0.008, 10)), ironJointMat);
      eyeRim.rotation.x = Math.PI * 0.5;
      eyeRim.position.set(side * 0.015, 0.032, 0.032);
      const eyeGlow = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0075, 0.0075, 0.01, 10)), ironEyeMat);
      eyeGlow.rotation.x = Math.PI * 0.5;
      eyeGlow.position.set(side * 0.015, 0.032, 0.033);
      giantHeadPivot.add(earPod, eyeRim, eyeGlow);
    }

    giantTorsoPivot.add(giantHeadPivot);
    giantScale.add(giantTorsoPivot);

    let giantClock = 0;
    let giantTap = 0;
    const giantHit = new THREE.Mesh(
      own(new THREE.CylinderGeometry(0.22, 0.24, 0.5, 8)),
      own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
    );
    giantHit.position.y = 0.25;
    giantHolder.add(giantHit);

    const triggerGiantTap = () => {
      giantTap = 3.2;
    };
    interactiveProps.push(
      { mesh: giantScale, onTap: triggerGiantTap },
      { mesh: giantHit, onTap: triggerGiantTap }
    );

    controllers.push({
      update(dt: number, nightFactor: number) {
        giantClock += dt;
        if (giantTap > 0) giantTap = Math.max(0, giantTap - dt);
        const sigh = Math.sin(giantClock * 1.15);
        const tapNorm = giantTap > 0 ? Math.sin((1 - giantTap / 3.2) * Math.PI) : 0;

        // Heavy wistful breathing slump; when comforted/tapped, slowly looks up softly then settles back onto his knees
        giantTorsoPivot.rotation.x = 0.34 + sigh * 0.035 - tapNorm * 0.16;
        giantHeadPivot.rotation.x = 0.42 + sigh * 0.045 - tapNorm * 0.46;
        giantHeadPivot.rotation.y = Math.sin(giantClock * 0.55) * 0.07;
        ironEyeMat.emissiveIntensity = 0.38 + nightFactor * 0.45 + tapNorm * 0.65;
      },
    });
  }

  return { controllers, interactiveProps };
}

  let seed = 84;
  const random = options.fixedPose ? () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  } : Math.random;
  const engineNow = options.fixedPose ? () => 0 : () => performance.now();
  const isSoftwareGl = (() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return true;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const param = ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER;
    const gpu = String(gl.getParameter(param));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /SwiftShader|llvmpipe|softpipe|Software|Basic Render/i.test(gpu);
  })();

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !isSoftwareGl,
      alpha: true,
      powerPreference: 'high-performance',
    });
  } catch {
    return null;
  }

  let disposed = false;
  const timeoutIds = new Set<number>();
  const pendingSyncs = new Set<WebGLSync>();
  const scheduleTimeout = (callback: () => void, delay: number): number => {
    const id = window.setTimeout(() => {
      timeoutIds.delete(id);
      if (!disposed) callback();
    }, delay);
    timeoutIds.add(id);
    return id;
  };

  renderer.setPixelRatio(isSoftwareGl ? 1 : Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = !isSoftwareGl;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 45);
  camera.position.set(0, 1.45, 12.6);
  camera.lookAt(0, 0, 0);

  const hemiLight = new THREE.HemisphereLight('#8b9ec7', '#3b3c54', 1.15);
  scene.add(hemiLight);

  const sunLight = new THREE.DirectionalLight('#f4a26a', 1.9);
  sunLight.position.set(5.5, 4.8, 4.8);
  sunLight.castShadow = !isSoftwareGl;
  sunLight.shadow.mapSize.set(2048, 2048);
  sunLight.shadow.camera.near = 1;
  sunLight.shadow.camera.far = 20;
  const d = 4.3;
  sunLight.shadow.camera.left = -d;
  sunLight.shadow.camera.right = d;
  sunLight.shadow.camera.top = d;
  sunLight.shadow.camera.bottom = -d;
  sunLight.shadow.bias = -0.0005;
  sunLight.shadow.normalBias = 0.022;
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight('#8da6d6', 0.45);
  rimLight.position.set(-5.0, -2.0, -4.5);
  scene.add(rimLight);

  const planetGroup = new THREE.Group();
  scene.add(planetGroup);

  const minkTex = createMinkPixelTexture();
  const minkMat = applyPaintedClayFinish(
    own(new THREE.MeshStandardMaterial({ map: minkTex, roughness: 0.92, metalness: 0.0 })),
    0.22,
    6.0
  );
  const clayMat = applyPaintedClayFinish(
    own(new THREE.MeshStandardMaterial({ color: '#ddd3c4', roughness: 0.96, metalness: 0.0 })),
    0.34,
    5.0
  );

  const mats: WorldMats = {
    wood: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#6b4d37', roughness: 0.96 }))),
    woodLight: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#a87d52', roughness: 0.95 }))),
    leafA: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#657e53', roughness: 0.96 }))),
    leafB: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#496340', roughness: 0.96 }))),
    stone: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#6b7785', roughness: 0.96 }))),
    ceramic: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#ece5d6', roughness: 0.94 }))),
    ceramicTrim: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#c46f3d', roughness: 0.94 }))),
    rose: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#b84b44', roughness: 0.94 }))),
    roseDark: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#872b28', roughness: 0.95 }))),
    boxGold: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#bf9462', roughness: 0.94 }))),
    boxRim: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#997044', roughness: 0.95 }))),
    brass: applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#b38c4e', roughness: 0.92 }))),
  };

  const { mesh: planetMesh, material: planetMat } = buildPlanetMesh();
  planetGroup.add(planetMesh);

  const { mesh: waterMesh, uniforms: waterUniforms } = buildWaterMesh();
  planetGroup.add(waterMesh);

  const bridgeHolder = new THREE.Group();
  bridgeHolder.position.copy(WORLD_CONFIG.landmarks.bridge.dir).multiplyScalar(BRIDGE_BASE_R);
  bridgeHolder.quaternion.copy(BRIDGE_QUAT);
  bridgeHolder.add(createWoodenBridge(mats));
  planetGroup.add(bridgeHolder);

  // Solid spherical obstacles (radii in unit-sphere radians) for collision avoidance
  const worldObstacles: { dir: THREE.Vector3; radius: number }[] = [
    { dir: WORLD_CONFIG.landmarks.tea.dir.clone(), radius: 0.068 },
    { dir: WORLD_CONFIG.landmarks.mystery.dir.clone(), radius: 0.072 },
    { dir: WORLD_CONFIG.landmarks.rose.dir.clone(), radius: 0.068 },
    { dir: WORLD_CONFIG.landmarks.astro.dir.clone(), radius: 0.095 },
    { dir: WORLD_CONFIG.landmarks.derrick.dir.clone(), radius: 0.135 },
    { dir: WORLD_CONFIG.landmarks.monolith.dir.clone(), radius: 0.068 },
  ];

  // Big Society Windmill on the north bank, oriented directly toward the river & bridge
  const windmillDir = new THREE.Vector3(0.46, 0.54, 0.705).normalize();
  const windmillHolder = attachOnSurface(planetGroup, windmillDir, -0.015, 0);
  {
    const toRiver = WORLD_CONFIG.landmarks.bridge.dir.clone().sub(windmillDir);
    const up = windmillDir.clone();
    toRiver.addScaledVector(up, -toRiver.dot(up)).normalize();
    const right = new THREE.Vector3().crossVectors(up, toRiver).normalize();
    const basis = new THREE.Matrix4().makeBasis(right, up, toRiver);
    windmillHolder.quaternion.setFromRotationMatrix(basis);
  }
  const { group: windmillGroup, rotor: windmillRotor } = createWindmill(mats);
  windmillGroup.scale.setScalar(1.36);
  windmillHolder.add(windmillGroup);
  worldObstacles.push({ dir: windmillDir.clone(), radius: 0.145 });

  const signpostDir = new THREE.Vector3(-0.14, 0.52, 0.84).normalize();
  const signpostHolder = attachOnSurface(planetGroup, signpostDir, 0, 0.3);
  signpostHolder.add(createSignpost(mats));
  worldObstacles.push({ dir: signpostDir.clone(), radius: 0.038 });

  const campfireDir = new THREE.Vector3(-0.62, -0.35, 0.7).normalize();
  const campfireHolder = attachOnSurface(planetGroup, campfireDir, 0, 0.6);
  const { group: campfireGroup, flame: campfireFlame, light: campfireLight, smokePuffs: campfireSmoke } = createCampfire(mats);
  campfireHolder.add(campfireGroup);
  worldObstacles.push({ dir: campfireDir.clone(), radius: 0.078 });

  const treeDirs = [
    [0.10, 0.62, 0.78, 1.05],
    [0.78, 0.52, 0.35, 0.88],
    [-0.65, 0.25, 0.71, 0.96],
    [-0.2, 0.82, -0.53, 1.0],
    [0.18, -0.45, 0.87, 0.92],
    [-0.55, 0.65, -0.52, 0.85],
    [-0.78, -0.34, -0.52, 0.95],
    [0.85, 0.24, -0.47, 1.12],
    [0.15, -0.75, -0.64, 0.84],
    // Extra groves filling out previously sparse areas of the planet
    [0.52, 0.76, -0.38, 0.98],
    [0.72, 0.52, 0.45, 0.86],
    [-0.78, -0.48, 0.38, 1.04],
    [-0.32, -0.88, -0.35, 0.92],
    [0.36, -0.72, 0.58, 0.95],
    [-0.88, 0.38, 0.28, 0.88],
    [-0.24, 0.88, 0.41, 0.96],
    [0.48, -0.22, 0.85, 0.9],
    [-0.62, -0.15, -0.77, 1.02],
  ];
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.comfy.dir.clone(), radius: 0.22 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.sixhand.dir.clone(), radius: 0.20 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.lascaux.dir.clone(), radius: 0.28 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.david.dir.clone(), radius: 0.045 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.thumper.dir.clone(), radius: 0.14 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.painter.dir.clone(), radius: 0.16 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.tinkerer.dir.clone(), radius: 0.15 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.keeper.dir.clone(), radius: 0.16 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.helping.dir.clone(), radius: 0.24 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.hobbit.dir.clone(), radius: 0.24 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.thinker.dir.clone(), radius: 0.11 });
  worldObstacles.push({ dir: WORLD_CONFIG.landmarks.irongiant.dir.clone(), radius: 0.20 });

  // Non-colliding scenic open-ground clearings that still shouldn't have trees/rocks planted in them
  const openClearanceZones = [
    { dir: WORLD_CONFIG.landmarks.bridge.dir, radius: 0.14 },
    { dir: WORLD_CONFIG.landmarks.meadow.dir, radius: 0.18 },
    { dir: WORLD_CONFIG.landmarks.ball.dir, radius: 0.18 },
  ];
  // Guarantee every tree/rock leaves >= 0.105 rad clearance around ALL obstacles (windmill, bridge, landmarks, earlier trees) so zero mink-width traps form
  const isBlockedPropSpot = (dVec: THREE.Vector3, propRadius: number) =>
    worldObstacles.some((o) => dVec.angleTo(o.dir) < o.radius + propRadius + 0.105) ||
    openClearanceZones.some((z) => dVec.angleTo(z.dir) < z.radius + propRadius + 0.105);

  for (const [x, y, z, s] of treeDirs) {
    const dVec = new THREE.Vector3(x, y, z).normalize();
    const treeRadius = 0.065 * s;
    if (getRiverFactor(dVec) < 0.25 && getDesertMask(dVec) < 0.35 && getAlpineMask(dVec) < 0.25 && !isBlockedPropSpot(dVec, treeRadius)) {
      const h = attachOnSurface(planetGroup, dVec, -0.015, random() * 6.28);
      h.add(createRoundedTree(s, mats));
      worldObstacles.push({ dir: dVec.clone(), radius: treeRadius });
    }
  }

  const rockDirs = [
    [0.48, -0.1, 0.87, 1.1],
    [-0.22, 0.42, 0.88, 0.85],
    [-0.78, -0.08, 0.62, 1.2],
    [0.72, 0.55, -0.42, 0.95],
    [-0.45, -0.62, -0.64, 1.15],
    [0.05, 0.92, -0.38, 0.9],
    [0.62, -0.68, -0.38, 1.15],
    [-0.72, -0.58, -0.36, 1.0],
    [0.24, -0.92, -0.28, 0.92],
    [-0.48, 0.12, -0.86, 1.08],
  ];
  for (const [x, y, z, s] of rockDirs) {
    const dVec = new THREE.Vector3(x, y, z).normalize();
    const rockRadius = 0.052 * s;
    if (getRiverFactor(dVec) < 0.25 && !isBlockedPropSpot(dVec, rockRadius)) {
      const h = attachOnSurface(planetGroup, dVec, 0.01, random() * 6.28);
      h.add(createSculptedRock(s, mats.stone));
      worldObstacles.push({ dir: dVec.clone(), radius: rockRadius });
    }
  }

  // Instanced Grass Tufts
  {
    const tuftGeo = own(new THREE.ConeGeometry(0.025, 0.065, 4));
    tuftGeo.translate(0, 0.032, 0);
    const count = 140;
    const tufts = new THREE.InstancedMesh(tuftGeo, mats.leafA, count);
    const dummy = new THREE.Object3D();
    let placed = 0;
    for (let i = 0; i < 360 && placed < count; i++) {
      const dVec = new THREE.Vector3(Math.sin(i * 1.73), Math.cos(i * 2.31), Math.sin(i * 3.17 + 1.2)).normalize();
      const inRiver = getTerrainHeight(dVec) < WORLD_CONFIG.waterRadius + 0.02;
      const inDesert = getDesertMask(dVec) > 0.25;
      const onPath = getPathFactor(dVec) > 0.35;
      if (inRiver || inDesert || onPath) continue;

      const pos = dVec.clone().multiplyScalar(getTerrainHeight(dVec));
      const up = getTerrainNormal(dVec);
      dummy.position.copy(pos);
      dummy.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
      dummy.rotateY(i * 1.1);
      dummy.scale.setScalar(0.75 + hash3(dVec.x, dVec.y, dVec.z) * 0.6);
      dummy.updateMatrix();
      tufts.setMatrixAt(placed++, dummy.matrix);
    }
    tufts.count = placed;
    tufts.instanceMatrix.needsUpdate = true;
    tufts.computeBoundingSphere();
    planetGroup.add(tufts);
  }

  // Sculpted faceted alpine mountain range seated cleanly on the snowy highland
  {
    const rockDarkMat = own(new THREE.MeshStandardMaterial({ color: '#6b727d', roughness: 0.92, flatShading: true }));
    const rockLightMat = own(new THREE.MeshStandardMaterial({ color: '#838b96', roughness: 0.9, flatShading: true }));
    const snowCapMat = own(new THREE.MeshStandardMaterial({ color: '#f3f7fc', roughness: 0.82, flatShading: true }));

    const buildFacetedPeak = (radius: number, height: number, sides: number, snowRatio: number, rockMat: THREE.Material) => {
      const peakGroup = new THREE.Group();
      const baseGeo = own(new THREE.ConeGeometry(radius, height, sides, 2));
      const bPos = baseGeo.attributes.position;
      for (let i = 0; i < bPos.count; i++) {
        const vx = bPos.getX(i);
        const vy = bPos.getY(i);
        const vz = bPos.getZ(i);
        const normY = (vy + height * 0.5) / height;
        if (normY > 0.05 && normY < 0.95) {
          const jitter = 0.84 + 0.32 * Math.abs(Math.sin(vx * 17.3 + vz * 13.7 + normY * 5.1));
          bPos.setXYZ(i, vx * jitter, vy, vz * jitter);
        }
      }
      baseGeo.computeVertexNormals();
      const baseMesh = new THREE.Mesh(baseGeo, rockMat);
      baseMesh.position.y = height * 0.5 - 0.03;
      baseMesh.castShadow = true;
      baseMesh.receiveShadow = true;
      peakGroup.add(baseMesh);

      const capH = height * snowRatio;
      const capR = radius * snowRatio * 1.04;
      const capGeo = own(new THREE.ConeGeometry(capR, capH, sides, 1));
      const cPos = capGeo.attributes.position;
      for (let i = 0; i < cPos.count; i++) {
        const vx = cPos.getX(i);
        const vy = cPos.getY(i);
        const vz = cPos.getZ(i);
        if (vy < 0) {
          const skirt = 0.88 + 0.24 * Math.abs(Math.sin(vx * 19.1 + vz * 11.3));
          cPos.setXYZ(i, vx * skirt, vy - Math.abs(Math.sin(vx * 14 + vz * 9)) * 0.035, vz * skirt);
        }
      }
      capGeo.computeVertexNormals();
      const capMesh = new THREE.Mesh(capGeo, snowCapMat);
      capMesh.position.y = height - capH * 0.5 - 0.025;
      capMesh.castShadow = true;
      capMesh.receiveShadow = true;
      peakGroup.add(capMesh);

      return peakGroup;
    };

    const alpinePeaks: { dir: THREE.Vector3; r: number; h: number; sides: number; snow: number; yaw: number; dark: boolean }[] = [
      { dir: ALPINE_PEAK_A, r: 0.32, h: 0.56, sides: 7, snow: 0.48, yaw: 0.4, dark: true },
      { dir: ALPINE_PEAK_B, r: 0.27, h: 0.46, sides: 6, snow: 0.45, yaw: 1.5, dark: false },
      { dir: ALPINE_PEAK_C, r: 0.25, h: 0.40, sides: 6, snow: 0.44, yaw: 2.3, dark: true },
      { dir: new THREE.Vector3(-0.16, 0.74, -0.65).normalize(), r: 0.20, h: 0.30, sides: 5, snow: 0.38, yaw: 0.9, dark: false },
      { dir: new THREE.Vector3(-0.34, 0.82, -0.46).normalize(), r: 0.22, h: 0.34, sides: 6, snow: 0.42, yaw: 2.8, dark: false },
    ];

    for (const p of alpinePeaks) {
      const holder = attachOnSurface(planetGroup, p.dir, -0.02, p.yaw);
      holder.add(buildFacetedPeak(p.r, p.h, p.sides, p.snow, p.dark ? rockDarkMat : rockLightMat));
      worldObstacles.push({ dir: p.dir.clone(), radius: p.r * 0.65 });
    }
  }

  // Stylized desert saguaro cacti in the desert biome (well-proportioned with rounded caps & bent arms)
  const cactusMat = own(new THREE.MeshStandardMaterial({ color: '#477a42', roughness: 0.84 }));
  const cactusDirs: [number, number, number, number][] = [
    [0.58, -0.44, -0.68, 1.15],
    [0.74, -0.32, -0.59, 0.98],
    [0.16, -0.62, -0.77, 1.08],
    [0.84, 0.12, -0.52, 1.02],
    [0.44, -0.56, -0.70, 0.88],
    [0.68, -0.18, -0.71, 0.95],
  ];
  for (const [cx, cy, cz, cs] of cactusDirs) {
    const cDir = new THREE.Vector3(cx, cy, cz).normalize();
    const cHolder = attachOnSurface(planetGroup, cDir, -0.015, random() * 6.28);
    const trunkR = 0.038 * cs;
    const trunkH = 0.40 * cs;
    const trunk = new THREE.Mesh(own(new THREE.CylinderGeometry(trunkR * 0.92, trunkR * 1.08, trunkH, 9)), cactusMat);
    trunk.position.y = trunkH * 0.5;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    cHolder.add(trunk);

    const trunkCap = new THREE.Mesh(own(new THREE.SphereGeometry(trunkR * 0.92, 9, 7)), cactusMat);
    trunkCap.position.y = trunkH;
    trunkCap.castShadow = true;
    cHolder.add(trunkCap);

    // Left saguaro arm (elbow + vertical rise + rounded cap)
    const armLR = 0.026 * cs;
    const armLElbow = new THREE.Mesh(own(new THREE.CylinderGeometry(armLR, armLR, 0.085 * cs, 7)), cactusMat);
    armLElbow.position.set(-0.052 * cs, 0.21 * cs, 0);
    armLElbow.rotation.z = Math.PI * 0.5;
    armLElbow.castShadow = true;
    cHolder.add(armLElbow);

    const armLVert = new THREE.Mesh(own(new THREE.CylinderGeometry(armLR * 0.92, armLR, 0.145 * cs, 7)), cactusMat);
    armLVert.position.set(-0.088 * cs, 0.28 * cs, 0);
    armLVert.castShadow = true;
    cHolder.add(armLVert);

    const armLCap = new THREE.Mesh(own(new THREE.SphereGeometry(armLR * 0.92, 7, 6)), cactusMat);
    armLCap.position.set(-0.088 * cs, 0.352 * cs, 0);
    armLCap.castShadow = true;
    cHolder.add(armLCap);

    // Right saguaro arm
    const armRR = 0.024 * cs;
    const armRElbow = new THREE.Mesh(own(new THREE.CylinderGeometry(armRR, armRR, 0.075 * cs, 7)), cactusMat);
    armRElbow.position.set(0.048 * cs, 0.16 * cs, 0);
    armRElbow.rotation.z = Math.PI * 0.5;
    armRElbow.castShadow = true;
    cHolder.add(armRElbow);

    const armRVert = new THREE.Mesh(own(new THREE.CylinderGeometry(armRR * 0.92, armRR, 0.125 * cs, 7)), cactusMat);
    armRVert.position.set(0.080 * cs, 0.22 * cs, 0);
    armRVert.castShadow = true;
    cHolder.add(armRVert);

    const armRCap = new THREE.Mesh(own(new THREE.SphereGeometry(armRR * 0.92, 7, 6)), cactusMat);
    armRCap.position.set(0.080 * cs, 0.282 * cs, 0);
    armRCap.castShadow = true;
    cHolder.add(armRCap);

    worldObstacles.push({ dir: cDir.clone(), radius: 0.065 * cs });
  }

  const minkGeo = createMinkGeometry();
  const shadowTex = createContactShadowTexture();
  const sleepZTex = createSleepZTexture();

  const makeAgent = (id: string, name: string, role: string, homeDir: THREE.Vector3, scale = 1.0) =>
    new MinkAgent({ random, id, name, role, homeDir, sharedGeo: minkGeo, sharedMat: minkMat, shadowTex, sleepZTex, planetGroup, scale });

  const agents: AgentGroups = {
    tea: [
      makeAgent('pip', 'Pip', 'tea', WORLD_CONFIG.landmarks.tea.dir, 1.04),
      makeAgent('milo', 'Milo', 'tea', WORLD_CONFIG.landmarks.tea.dir, 0.98),
    ],
    meadow: [
      // Smaller, playful puppy-sized minks chasing each other in the meadow
      makeAgent('bramble', 'Bramble', 'meadow', WORLD_CONFIG.landmarks.meadow.dir, 0.76),
      makeAgent('clover', 'Clover', 'meadow', WORLD_CONFIG.landmarks.meadow.dir, 0.72),
      makeAgent('juniper', 'Juniper', 'meadow', WORLD_CONFIG.landmarks.meadow.dir, 0.78),
    ],
    rose: [makeAgent('sable', 'Sable', 'rose', WORLD_CONFIG.landmarks.rose.dir, 0.94)],
    // Fern starts small and grows big when a Mario Super Mushroom lands on them!
    mystery: [makeAgent('fern', 'Fern', 'mystery', WORLD_CONFIG.landmarks.mystery.dir, 0.72)],
    astro: [makeAgent('oriel', 'Oriel', 'astro', WORLD_CONFIG.landmarks.astro.dir, 1.12)],
    ball: [makeAgent('maple', 'Maple', 'ball', WORLD_CONFIG.landmarks.ball.dir, 0.92)],
    derrick: [makeAgent('daniel', 'Daniel', 'derrick', WORLD_CONFIG.landmarks.derrick.dir, 1.1)],
    monolith: [
      makeAgent('dave', 'Dave', 'monolith', WORLD_CONFIG.landmarks.monolith.dir, 1.0),
      makeAgent('moonwatcher', 'Moonwatcher', 'monolith', WORLD_CONFIG.landmarks.monolith.dir, 0.96),
    ],
    sixhand: [makeAgent('latent', 'Latent', 'sixhand', WORLD_CONFIG.landmarks.sixhand.dir, 0.96)],
    david: [
      makeAgent('pippin', 'Pippin', 'david', WORLD_CONFIG.landmarks.david.dir, 0.58),
      makeAgent('fig', 'Fig', 'david', WORLD_CONFIG.landmarks.david.dir, 0.54),
    ],
    painter: [makeAgent('sienna', 'Sienna', 'painter', WORLD_CONFIG.landmarks.painter.dir, 1.0)],
    tinkerer: [makeAgent('cora', 'Cora', 'tinkerer', WORLD_CONFIG.landmarks.tinkerer.dir, 0.96)],
    keeper: [makeAgent('lark', 'Lark', 'keeper', WORLD_CONFIG.landmarks.keeper.dir, 0.98)],
    helping: [
      makeAgent('rowan', 'Rowan', 'helping', WORLD_CONFIG.landmarks.helping.dir, 0.96),
      makeAgent('reed', 'Reed', 'helping', WORLD_CONFIG.landmarks.helping.dir, 0.92),
    ],
    wanderers: [
      makeAgent('wren', 'Wren', 'wanderer', new THREE.Vector3(-0.18, 0.52, 0.83).normalize(), 0.86),
      makeAgent('moss', 'Moss', 'wanderer', new THREE.Vector3(0.24, 0.68, 0.69).normalize(), 1.06),
      makeAgent('dot', 'Dot', 'wanderer', new THREE.Vector3(-0.42, -0.58, 0.69).normalize(), 0.82),
      makeAgent('tansy', 'Tansy', 'wanderer', new THREE.Vector3(0.35, 0.76, -0.54).normalize(), 0.96),
      makeAgent('alder', 'Alder', 'wanderer', new THREE.Vector3(-0.18, -0.82, -0.54).normalize(), 1.08),
    ],
  };

  const allAgents = [
    ...agents.tea,
    ...agents.meadow,
    ...agents.rose,
    ...agents.mystery,
    ...agents.astro,
    ...agents.ball,
    ...agents.derrick,
    ...agents.monolith,
    ...agents.sixhand,
    ...agents.david,
    ...agents.painter,
    ...agents.tinkerer,
    ...agents.keeper,
    ...agents.helping,
    ...agents.wanderers,
  ];

  const { controllers, interactiveProps } = createSceneControllers(planetGroup, agents, mats, camera, random, engineNow, scheduleTimeout);

  // CARL FREDRICKSEN'S HOUSE FROM "UP" FLOATING UNDER BALLOONS (1.5x larger scale + cute clapboard, shutters, flower boxes, porch rails, mailbox!)
  const balloonGroup = new THREE.Group();

  const upHouseGroup = new THREE.Group();
  const upWallMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#e6c86c', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const upClapboardMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#d7b556', roughness: 0.93, flatShading: true })), 0.34, 5.0);
  const upSageTrimMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#7ea18a', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const upRoofMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#475669', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const upCoralMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#d96254', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const upBrickMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#a3543d', roughness: 0.94, flatShading: true })), 0.34, 5.0);
  const upPorchMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#f2ece0', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const upCedarMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#8f5d38', roughness: 0.94, flatShading: true })), 0.34, 5.0);
  const upBrassMat = own(new THREE.MeshStandardMaterial({ color: '#e6b84c', roughness: 0.4, metalness: 0.45 }));
  const upWinMat = own(new THREE.MeshStandardMaterial({
    color: '#ffe8a8',
    emissive: '#eba342',
    emissiveIntensity: 0.48,
    roughness: 0.55,
  }));

  // Main storybook clapboard body + stone foundation base + corner pilasters & siding bands
  const houseFound = new THREE.Mesh(own(new THREE.BoxGeometry(0.175, 0.018, 0.195)), mats.stone);
  houseFound.position.y = 0.009;
  const houseMain = new THREE.Mesh(own(new THREE.BoxGeometry(0.16, 0.115, 0.165)), upWallMat);
  houseMain.position.set(0, 0.075, -0.01);
  houseMain.castShadow = true;
  houseMain.receiveShadow = true;

  for (const bandY of [0.036, 0.064, 0.092, 0.118]) {
    const band = new THREE.Mesh(own(new THREE.BoxGeometry(0.164, 0.005, 0.169)), upClapboardMat);
    band.position.set(0, bandY, -0.01);
    upHouseGroup.add(band);
  }
  const eaveFrieze = new THREE.Mesh(own(new THREE.BoxGeometry(0.168, 0.009, 0.173)), upPorchMat);
  eaveFrieze.position.set(0, 0.131, -0.01);
  upHouseGroup.add(eaveFrieze);
  for (const cx of [-0.079, 0.079]) {
    for (const cz of [-0.091, 0.071]) {
      const pilaster = new THREE.Mesh(own(new THREE.BoxGeometry(0.01, 0.118, 0.01)), upPorchMat);
      pilaster.position.set(cx, 0.076, cz);
      upHouseGroup.add(pilaster);
    }
  }

  // Front bay turret / porch extension with sage gables, white porch posts, balusters & steps
  const bayExt = new THREE.Mesh(own(new THREE.BoxGeometry(0.088, 0.105, 0.055)), upSageTrimMat);
  bayExt.position.set(-0.025, 0.07, 0.082);
  bayExt.castShadow = true;
  const bayTrimTop = new THREE.Mesh(own(new THREE.BoxGeometry(0.094, 0.007, 0.061)), upPorchMat);
  bayTrimTop.position.set(-0.025, 0.123, 0.082);
  const porchDeck = new THREE.Mesh(own(new THREE.BoxGeometry(0.084, 0.014, 0.056)), upPorchMat);
  porchDeck.position.set(0.042, 0.024, 0.086);
  const porchStep1 = new THREE.Mesh(own(new THREE.BoxGeometry(0.042, 0.01, 0.02)), upPorchMat);
  porchStep1.position.set(0.044, 0.015, 0.118);
  const porchStep2 = new THREE.Mesh(own(new THREE.BoxGeometry(0.042, 0.007, 0.016)), upPorchMat);
  porchStep2.position.set(0.044, 0.006, 0.131);
  const porchRoof = new THREE.Mesh(own(new THREE.BoxGeometry(0.09, 0.012, 0.064)), upRoofMat);
  porchRoof.position.set(0.042, 0.088, 0.088);
  porchRoof.rotation.x = 0.18;
  const porchFascia = new THREE.Mesh(own(new THREE.BoxGeometry(0.094, 0.005, 0.008)), upPorchMat);
  porchFascia.position.set(0.042, 0.082, 0.119);
  for (const px of [0.008, 0.076]) {
    const post = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0042, 0.0042, 0.058, 5)), upPorchMat);
    post.position.set(px, 0.056, 0.108);
    upHouseGroup.add(post);
  }
  // Cute left-side porch railing + 3 balusters (leaving stairs open)
  const porchRailTop = new THREE.Mesh(own(new THREE.BoxGeometry(0.026, 0.0045, 0.005)), upPorchMat);
  porchRailTop.position.set(0.017, 0.046, 0.108);
  upHouseGroup.add(porchRailTop);
  for (const bx of [0.011, 0.018, 0.025]) {
    const bal = new THREE.Mesh(own(new THREE.BoxGeometry(0.003, 0.017, 0.003)), upPorchMat);
    bal.position.set(bx, 0.036, 0.108);
    upHouseGroup.add(bal);
  }
  // Hanging glowing porch lantern beside the door
  const porchLantern = new THREE.Mesh(own(new THREE.BoxGeometry(0.008, 0.011, 0.008)), upWinMat);
  porchLantern.position.set(0.068, 0.074, 0.095);

  // Steep pitched slate roof + cream roof rim + front dormer peak with glowing round attic window
  const roofEaveRim = new THREE.Mesh(own(new THREE.CylinderGeometry(0.132, 0.132, 0.007, 4)), upPorchMat);
  roofEaveRim.position.set(0, 0.134, -0.01);
  roofEaveRim.rotation.y = Math.PI * 0.25;
  const mainRoof = new THREE.Mesh(own(new THREE.ConeGeometry(0.128, 0.096, 4)), upRoofMat);
  mainRoof.position.set(0, 0.178, -0.01);
  mainRoof.rotation.y = Math.PI * 0.25;
  mainRoof.castShadow = true;
  const dormer = new THREE.Mesh(own(new THREE.ConeGeometry(0.054, 0.06, 4)), upSageTrimMat);
  dormer.position.set(-0.025, 0.153, 0.076);
  dormer.rotation.y = Math.PI * 0.25;
  dormer.castShadow = true;
  const atticWinFrame = new THREE.Mesh(own(new THREE.CylinderGeometry(0.013, 0.013, 0.008, 10)), upPorchMat);
  atticWinFrame.rotation.x = Math.PI * 0.5;
  atticWinFrame.position.set(-0.025, 0.145, 0.098);
  const atticWinGlass = new THREE.Mesh(own(new THREE.CylinderGeometry(0.009, 0.009, 0.01, 10)), upWinMat);
  atticWinGlass.rotation.x = Math.PI * 0.5;
  atticWinGlass.position.set(-0.025, 0.145, 0.099);

  // Front bay window with cream frame, cross mullions, coral shutters & cedar flower box!
  const winFrontFrame = new THREE.Mesh(own(new THREE.BoxGeometry(0.047, 0.043, 0.008)), upPorchMat);
  winFrontFrame.position.set(-0.025, 0.076, 0.107);
  const winFront = new THREE.Mesh(own(new THREE.BoxGeometry(0.039, 0.035, 0.01)), upWinMat);
  winFront.position.set(-0.025, 0.076, 0.108);
  const winFrontMullV = new THREE.Mesh(own(new THREE.BoxGeometry(0.0035, 0.036, 0.012)), upPorchMat);
  winFrontMullV.position.set(-0.025, 0.076, 0.109);
  const winFrontMullH = new THREE.Mesh(own(new THREE.BoxGeometry(0.04, 0.0035, 0.012)), upPorchMat);
  winFrontMullH.position.set(-0.025, 0.076, 0.109);
  for (const sSide of [-1, 1]) {
    const shutter = new THREE.Mesh(own(new THREE.BoxGeometry(0.011, 0.04, 0.005)), upCoralMat);
    shutter.position.set(-0.025 + sSide * 0.03, 0.076, 0.11);
    upHouseGroup.add(shutter);
  }
  const frontFlowerBox = new THREE.Mesh(own(new THREE.BoxGeometry(0.048, 0.01, 0.013)), upCedarMat);
  frontFlowerBox.position.set(-0.025, 0.049, 0.114);
  for (const [fx, fc] of [[-0.039, '#e85a6b'], [-0.025, '#f5c242'], [-0.011, '#f2f0e8']] as [number, string][]) {
    const fl = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.006, 0)), own(new THREE.MeshStandardMaterial({ color: fc, roughness: 0.78 })));
    fl.position.set(fx, 0.057, 0.115);
    upHouseGroup.add(fl);
  }

  // Front door with cream frame, glowing transom pane, and tiny brass doorknob
  const doorFrame = new THREE.Mesh(own(new THREE.BoxGeometry(0.032, 0.049, 0.008)), upPorchMat);
  doorFrame.position.set(0.042, 0.052, 0.072);
  const winDoor = new THREE.Mesh(own(new THREE.BoxGeometry(0.025, 0.044, 0.01)), upCedarMat);
  winDoor.position.set(0.042, 0.052, 0.074);
  const doorGlass = new THREE.Mesh(own(new THREE.BoxGeometry(0.015, 0.013, 0.012)), upWinMat);
  doorGlass.position.set(0.042, 0.062, 0.075);
  const doorKnob = new THREE.Mesh(own(new THREE.SphereGeometry(0.0024, 6, 5)), upBrassMat);
  doorKnob.position.set(0.05, 0.048, 0.08);

  // Cozy side windows with frames, mullions, coral shutters & flower boxes
  for (const side of [-1, 1]) {
    const sideFrame = new THREE.Mesh(own(new THREE.BoxGeometry(0.007, 0.042, 0.048)), upPorchMat);
    sideFrame.position.set(side * 0.08, 0.078, -0.01);
    const sideWin = new THREE.Mesh(own(new THREE.BoxGeometry(0.009, 0.035, 0.04)), upWinMat);
    sideWin.position.set(side * 0.081, 0.078, -0.01);
    const sideMullV = new THREE.Mesh(own(new THREE.BoxGeometry(0.011, 0.036, 0.0035)), upPorchMat);
    sideMullV.position.set(side * 0.081, 0.078, -0.01);
    const sideMullH = new THREE.Mesh(own(new THREE.BoxGeometry(0.011, 0.0035, 0.04)), upPorchMat);
    sideMullH.position.set(side * 0.081, 0.078, -0.01);
    const sideFlowerBox = new THREE.Mesh(own(new THREE.BoxGeometry(0.013, 0.01, 0.046)), upCedarMat);
    sideFlowerBox.position.set(side * 0.084, 0.052, -0.01);
    for (const sOff of [-0.03, 0.03]) {
      const shut = new THREE.Mesh(own(new THREE.BoxGeometry(0.005, 0.04, 0.011)), upCoralMat);
      shut.position.set(side * 0.082, 0.078, -0.01 + sOff);
      upHouseGroup.add(shut);
    }
    for (const [fz, fc] of [[-0.023, '#e85a6b'], [-0.01, '#f5c242'], [0.003, '#f2f0e8']] as [number, string][]) {
      const fl = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.0055, 0)), own(new THREE.MeshStandardMaterial({ color: fc, roughness: 0.78 })));
      fl.position.set(side * 0.085, 0.06, fz);
      upHouseGroup.add(fl);
    }
    upHouseGroup.add(sideFrame, sideWin, sideMullV, sideMullH, sideFlowerBox);
  }

  // Iconic tiny rounded "Up" mailbox with red flag beside the front porch steps
  const mailboxPost = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0025, 0.0028, 0.034, 5)), upCedarMat);
  mailboxPost.position.set(0.095, 0.017, 0.124);
  const mailboxBody = new THREE.Mesh(own(new THREE.CylinderGeometry(0.007, 0.007, 0.018, 8)), upPorchMat);
  mailboxBody.rotation.x = Math.PI * 0.5;
  mailboxBody.position.set(0.095, 0.035, 0.124);
  const mailboxFlag = new THREE.Mesh(own(new THREE.BoxGeometry(0.002, 0.01, 0.004)), upCoralMat);
  mailboxFlag.position.set(0.102, 0.04, 0.122);

  // Tall terracotta brick chimney with cream crown cap + twin clay chimney pots!
  const upChimneyTop = new THREE.Vector3(0.079, 0.545, -0.063);
  const upChimney = new THREE.Mesh(own(new THREE.BoxGeometry(0.028, 0.092, 0.028)), upBrickMat);
  upChimney.position.set(0.035, 0.188, -0.028);
  upChimney.castShadow = true;
  const upChimneyCrown = new THREE.Mesh(own(new THREE.BoxGeometry(0.035, 0.009, 0.035)), upPorchMat);
  upChimneyCrown.position.set(0.035, 0.236, -0.028);
  for (const px of [0.028, 0.042]) {
    const pot = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0045, 0.0055, 0.012, 6)), upBrickMat);
    pot.position.set(px, 0.244, -0.028);
    upHouseGroup.add(pot);
  }

  const upChimneySmoke: THREE.Mesh[] = [];
  const upSmokeMat = own(new THREE.MeshStandardMaterial({ color: '#ece8df', transparent: true, opacity: 0.42, roughness: 1.0 }));
  for (let s = 0; s < 3; s++) {
    const puff = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.018, 1)), own(upSmokeMat.clone()));
    puff.visible = false;
    upHouseGroup.add(puff);
    upChimneySmoke.push(puff);
  }

  upHouseGroup.add(
    houseFound,
    houseMain,
    bayExt,
    bayTrimTop,
    porchDeck,
    porchStep1,
    porchStep2,
    porchRoof,
    porchFascia,
    porchLantern,
    roofEaveRim,
    mainRoof,
    dormer,
    atticWinFrame,
    atticWinGlass,
    winFrontFrame,
    winFront,
    winFrontMullV,
    winFrontMullH,
    frontFlowerBox,
    doorFrame,
    winDoor,
    doorGlass,
    doorKnob,
    mailboxPost,
    mailboxBody,
    mailboxFlag,
    upChimney,
    upChimneyCrown
  );
  upHouseGroup.scale.setScalar(2.25);
  balloonGroup.add(upHouseGroup);

  const balloonColors = [
    '#e84a3c', '#f5b82e', '#3ca6d8', '#76c45b', '#e876a8', '#f27a30', '#9c6ade',
    '#ff6b6b', '#4ecdc4', '#ffe66d', '#5c7cfa', '#ff922b', '#a9e34b',
  ];
  const balloonOffsets: [number, number, number][] = [
    [0.07, 1.13, -0.06],
    [0.19, 1.06, 0.01],
    [-0.06, 1.07, 0.02],
    [0.14, 1.03, -0.16],
    [-0.01, 1.05, -0.15],
    [0.25, 0.95, -0.05],
    [-0.13, 0.96, -0.06],
    [0.08, 0.98, 0.11],
    [0.07, 0.97, -0.21],
    [0.19, 0.88, 0.09],
    [-0.06, 0.89, 0.09],
    [0.18, 0.86, -0.17],
    [-0.05, 0.88, -0.17],
    [0.07, 0.82, 0.02],
    [0.27, 0.84, -0.06],
    [-0.15, 0.85, -0.04],
    [0.08, 0.80, -0.14],
  ];
  const stringMat = own(new THREE.MeshBasicMaterial({ color: '#e6dfd3' }));
  interface BalloonItem {
    mesh: THREE.Mesh;
    str: THREE.Mesh;
    popped: boolean;
    color: string;
  }
  const balloonItems: BalloonItem[] = [];
  const balloonPopBursts: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; vel: THREE.Vector3; life: number }[] = [];

  const spawnBalloonPopBurst = (worldMesh: THREE.Mesh, color: string) => {
    const originLocal = new THREE.Vector3();
    worldMesh.getWorldPosition(originLocal);
    planetGroup.worldToLocal(originLocal);
    for (let k = 0; k < 5; k++) {
      const mat = own(new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 }));
      const shard = new THREE.Mesh(own(new THREE.OctahedronGeometry(0.024, 0)), mat);
      shard.position.copy(originLocal);
      planetGroup.add(shard);
      const vel = new THREE.Vector3(random() - 0.5, random() * 0.7 + 0.15, random() - 0.5)
        .normalize()
        .multiplyScalar(0.55 + random() * 0.45);
      balloonPopBursts.push({ mesh: shard, mat, vel, life: 0.42 });
    }
  };

  let balloonTime = 0;
  let balloonPopCount = 0;
  let balloonMode: 'floating' | 'falling' | 'landed' = 'floating';
  let balloonAltDrop = 0;
  let balloonTargetDrop = 0;
  let balloonCurrentAlt = WORLD_CONFIG.planetRadius + 1.44;
  let balloonFallVel = 0;
  let cascadePopTimer = 0;
  let upHouseGlowBoost = 0;
  const balloonCurDir = new THREE.Vector3(0, 0.1, 0.995).normalize();

  const popBalloonItem = (item: BalloonItem) => {
    if (item.popped) return;
    item.popped = true;
    spawnBalloonPopBurst(item.mesh, item.color);
    item.mesh.visible = false;
    item.str.visible = false;
    const propIdx = interactiveProps.findIndex((p) => p.mesh === item.mesh);
    if (propIdx >= 0) interactiveProps.splice(propIdx, 1);
  };

  balloonOffsets.forEach(([bx, by, bz], idx) => {
    const col = balloonColors[idx % balloonColors.length];
    const bMat = own(new THREE.MeshStandardMaterial({
      color: col,
      roughness: 0.26,
      metalness: 0.06,
    }));
    const bMesh = new THREE.Mesh(own(new THREE.SphereGeometry(0.078, 12, 10)), bMat);
    bMesh.scale.set(0.92, 1.14, 0.92);
    bMesh.position.set(bx, by, bz);
    bMesh.castShadow = true;
    balloonGroup.add(bMesh);

    const end = new THREE.Vector3(bx, by - 0.074, bz);
    const diff = end.clone().sub(upChimneyTop);
    const strLen = diff.length();
    const str = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0026, 0.0026, strLen, 4)), stringMat);
    str.position.copy(upChimneyTop).addScaledVector(diff, 0.5);
    str.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), diff.clone().normalize());
    balloonGroup.add(str);

    const item: BalloonItem = { mesh: bMesh, str, popped: false, color: col };
    balloonItems.push(item);

    interactiveProps.push({
      mesh: bMesh,
      onTap: () => {
        if (balloonMode !== 'floating' || item.popped) return;
        popBalloonItem(item);
        balloonPopCount += 1;
        if (balloonPopCount === 1) {
          balloonTargetDrop = 0.38;
        } else {
          balloonMode = 'falling';
          balloonFallVel = 0.18;
          cascadePopTimer = 0.09;
        }
      },
    });
  });

  interactiveProps.push({
    mesh: upHouseGroup,
    onTap: () => {
      if (balloonMode === 'floating') {
        const nextUnpopped = balloonItems.find((it) => !it.popped);
        if (nextUnpopped) {
          popBalloonItem(nextUnpopped);
          balloonPopCount += 1;
          if (balloonPopCount === 1) {
            balloonTargetDrop = 0.38;
          } else {
            balloonMode = 'falling';
            balloonFallVel = 0.18;
            cascadePopTimer = 0.09;
          }
        }
      } else if (balloonMode === 'landed') {
        upHouseGlowBoost = 2.0;
      }
    },
  });
  planetGroup.add(balloonGroup);

  // HOWL'S MOVING CASTLE (Bulbous riveted iron hull, turret "eye" balconies, Calcifer furnace "maw", crooked Tudor cottages & chimneys, 4 striding avian legs)
  const castleGroup = new THREE.Group();
  castleGroup.scale.setScalar(1.06);

  const howlIronMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#3b4048', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const howlBronzeMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#78624d', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const howlPlasterMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#cfc4ae', roughness: 0.94, flatShading: true })), 0.34, 5.0);
  const howlRoofSlateMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#465866', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const howlRoofWarmMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#8a523b', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const howlEyeGlowMat = own(new THREE.MeshStandardMaterial({
    color: '#ffe0a3',
    emissive: '#e69b45',
    emissiveIntensity: 0.42,
    roughness: 0.6,
  }));
  const calciferMat = own(new THREE.MeshStandardMaterial({
    color: '#ff9233',
    emissive: '#e85d1a',
    emissiveIntensity: 0.72,
    roughness: 0.4,
  }));
  const cloudMat = own(new THREE.MeshStandardMaterial({
    color: '#fbf8f2',
    roughness: 0.95,
    transparent: true,
    opacity: 0.82,
    flatShading: true,
  }));

  // 1. Massive bulbous asymmetrical riveted iron boiler hull (tapers at bottom, swells in upper belly)
  const mainBoiler = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.175, 1)), howlIronMat);
  mainBoiler.scale.set(1.08, 1.18, 1.12);
  mainBoiler.position.set(0, 0.075, 0);
  mainBoiler.castShadow = true;
  castleGroup.add(mainBoiler);

  const upperCrownBoiler = new THREE.Mesh(own(new THREE.SphereGeometry(0.135, 10, 8)), howlBronzeMat);
  upperCrownBoiler.scale.set(1.0, 0.95, 0.96);
  upperCrownBoiler.position.set(-0.02, 0.215, -0.02);
  upperCrownBoiler.castShadow = true;
  castleGroup.add(upperCrownBoiler);

  const bellyApron = new THREE.Mesh(own(new THREE.CylinderGeometry(0.145, 0.085, 0.11, 9)), howlIronMat);
  bellyApron.position.set(0, -0.09, 0.01);
  bellyApron.castShadow = true;
  castleGroup.add(bellyApron);

  // 2. Anthropomorphic Front "Face" (+Z): two circular balcony turrets ("eyes") + jaw furnace maw ("Calcifer mouth")
  for (const side of [-1, 1]) {
    const turret = new THREE.Mesh(own(new THREE.CylinderGeometry(0.044, 0.048, 0.095, 8)), howlIronMat);
    turret.position.set(side * 0.095, 0.145, 0.145);
    turret.rotation.x = 0.14;
    turret.rotation.z = -side * 0.12;
    turret.castShadow = true;
    castleGroup.add(turret);

    const eyeCap = new THREE.Mesh(own(new THREE.ConeGeometry(0.056, 0.068, 8)), howlRoofSlateMat);
    eyeCap.position.set(side * 0.095, 0.222, 0.148);
    eyeCap.rotation.x = 0.14;
    eyeCap.castShadow = true;
    castleGroup.add(eyeCap);

    const eyeRim = new THREE.Mesh(own(new THREE.TorusGeometry(0.032, 0.007, 6, 12)), mats.brass);
    eyeRim.position.set(side * 0.095, 0.148, 0.192);
    castleGroup.add(eyeRim);

    const eyeGlass = new THREE.Mesh(own(new THREE.CircleGeometry(0.028, 10)), howlEyeGlowMat);
    eyeGlass.position.set(side * 0.095, 0.148, 0.194);
    castleGroup.add(eyeGlass);
  }

  // Protruding snout/furnace jaw ("The Maw") low on front facade
  const snoutJaw = new THREE.Mesh(own(new THREE.BoxGeometry(0.145, 0.072, 0.105)), howlIronMat);
  snoutJaw.position.set(0, 0.008, 0.165);
  snoutJaw.rotation.x = 0.18;
  snoutJaw.castShadow = true;
  castleGroup.add(snoutJaw);

  const mawCore = new THREE.Mesh(own(new THREE.BoxGeometry(0.092, 0.038, 0.04)), calciferMat);
  mawCore.position.set(0, 0.012, 0.205);
  castleGroup.add(mawCore);

  for (let t = -2; t <= 2; t++) {
    const slat = new THREE.Mesh(own(new THREE.BoxGeometry(0.009, 0.046, 0.012)), howlBronzeMat);
    slat.position.set(t * 0.022, 0.012, 0.224);
    castleGroup.add(slat);
  }
  const castleGlow = new THREE.PointLight('#ff8f33', 0.45, 1.3, 2);
  castleGlow.position.set(0, 0.015, 0.25);
  castleGroup.add(castleGlow);

  // 3. Grafted crooked half-timbered Tudor cottages perched on shoulders & upper back
  const cottageSpecs: { x: number; y: number; z: number; sx: number; sy: number; sz: number; rx: number; rz: number; ry: number; warmRoof: boolean }[] = [
    { x: -0.165, y: 0.135, z: -0.02, sx: 0.11, sy: 0.088, sz: 0.095, rx: 0.08, rz: 0.22, ry: -0.35, warmRoof: true },
    { x: 0.165, y: 0.115, z: -0.03, sx: 0.10, sy: 0.082, sz: 0.092, rx: -0.06, rz: -0.24, ry: 0.4, warmRoof: false },
    { x: 0.015, y: 0.285, z: -0.03, sx: 0.115, sy: 0.092, sz: 0.105, rx: 0.05, rz: -0.08, ry: 0.15, warmRoof: true },
    { x: -0.085, y: 0.235, z: -0.145, sx: 0.088, sy: 0.075, sz: 0.085, rx: -0.14, rz: 0.14, ry: 0.5, warmRoof: false },
  ];
  for (const c of cottageSpecs) {
    const cg = new THREE.Group();
    cg.position.set(c.x, c.y, c.z);
    cg.rotation.set(c.rx, c.ry, c.rz);
    const body = new THREE.Mesh(own(new THREE.BoxGeometry(c.sx, c.sy, c.sz)), howlPlasterMat);
    body.castShadow = true;
    cg.add(body);
    const trim = new THREE.Mesh(own(new THREE.BoxGeometry(c.sx * 1.04, 0.014, c.sz * 1.04)), mats.wood);
    trim.position.y = c.sy * 0.42;
    cg.add(trim);
    const roof = new THREE.Mesh(own(new THREE.ConeGeometry(Math.max(c.sx, c.sz) * 0.85, c.sy * 0.88, 4)), c.warmRoof ? howlRoofWarmMat : howlRoofSlateMat);
    roof.rotation.y = Math.PI * 0.25;
    roof.position.y = c.sy * 0.5 + c.sy * 0.42;
    roof.castShadow = true;
    cg.add(roof);
    castleGroup.add(cg);
  }

  // 4. Crooked towering smokestacks jutting asymmetrically from crown + drifting steam puffs
  const stackSpecs: [number, number, number, number, number, number][] = [
    [-0.085, 0.31, 0.02, 0.16, 0.12, -0.14],
    [0.095, 0.29, -0.05, 0.19, -0.16, 0.1],
    [0.025, 0.34, -0.11, 0.14, 0.08, 0.16],
  ];
  const castleSmoke: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; base: THREE.Vector3; phase: number }[] = [];
  for (let s = 0; s < stackSpecs.length; s++) {
    const [sx, sy, sz, sh, rx, rz] = stackSpecs[s];
    const pipe = new THREE.Mesh(own(new THREE.CylinderGeometry(0.016, 0.024, sh, 7)), howlIronMat);
    pipe.position.set(sx, sy, sz);
    pipe.rotation.set(rx, 0, rz);
    pipe.castShadow = true;
    castleGroup.add(pipe);

    const lip = new THREE.Mesh(own(new THREE.CylinderGeometry(0.024, 0.018, 0.02, 7)), howlBronzeMat);
    lip.position.set(sx - Math.sin(rz) * sh * 0.48, sy + sh * 0.48, sz + Math.sin(rx) * sh * 0.48);
    castleGroup.add(lip);

    for (let p = 0; p < 2; p++) {
      const pMat = own(new THREE.MeshStandardMaterial({ color: '#edeae2', transparent: true, opacity: 0.44, roughness: 1.0 }));
      const puff = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.024, 1)), pMat);
      castleGroup.add(puff);
      castleSmoke.push({ mesh: puff, mat: pMat, base: lip.position.clone(), phase: s * 0.33 + p * 0.5 });
    }
  }

  // 5. Flapping canvas side flight wings/vanes (Howl's flying castle wings!)
  const castleWings: { group: THREE.Group; side: number }[] = [];
  const wingSailMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#d8cfb8', roughness: 0.9, side: THREE.DoubleSide })), 0.34, 5.0);
  for (const side of [-1, 1]) {
    const wg = new THREE.Group();
    wg.position.set(side * 0.19, 0.15, -0.01);
    const spar = new THREE.Mesh(own(new THREE.CylinderGeometry(0.008, 0.01, 0.22, 5)), mats.wood);
    spar.rotation.z = Math.PI * 0.5;
    spar.position.x = side * 0.11;
    wg.add(spar);
    const sail = new THREE.Mesh(own(new THREE.BoxGeometry(0.18, 0.008, 0.095)), wingSailMat);
    sail.position.set(side * 0.11, 0, -0.02);
    sail.rotation.x = 0.18;
    sail.castShadow = true;
    wg.add(sail);
    castleGroup.add(wg);
    castleWings.push({ group: wg, side });
  }

  // 6. Four Articulated Mechanical Avian Striding Legs below the belly
  interface CastleLeg {
    hip: THREE.Group;
    knee: THREE.Group;
    phase: number;
  }
  const castleLegs: CastleLeg[] = [];
  const legSpecs: { x: number; z: number; yaw: number; phase: number }[] = [
    { x: -0.085, z: 0.065, yaw: 0.22, phase: 0 },
    { x: 0.085, z: 0.065, yaw: -0.22, phase: Math.PI },
    { x: -0.095, z: -0.075, yaw: -0.25, phase: Math.PI * 0.85 },
    { x: 0.095, z: -0.075, yaw: 0.25, phase: Math.PI * 1.85 },
  ];
  for (const ls of legSpecs) {
    const hip = new THREE.Group();
    hip.position.set(ls.x, -0.11, ls.z);
    hip.rotation.y = ls.yaw;

    const thigh = new THREE.Mesh(own(new THREE.CylinderGeometry(0.018, 0.014, 0.115, 6)), howlBronzeMat);
    thigh.position.set(0, -0.048, -0.022);
    thigh.rotation.x = 0.45;
    thigh.castShadow = true;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.set(0, -0.096, -0.045);
    const shin = new THREE.Mesh(own(new THREE.CylinderGeometry(0.013, 0.01, 0.125, 6)), howlIronMat);
    shin.position.set(0, -0.056, 0.028);
    shin.rotation.x = -0.45;
    shin.castShadow = true;
    knee.add(shin);

    // 3-toed mechanical bird claw foot
    for (const toeAng of [-0.45, 0, 0.45]) {
      const toe = new THREE.Mesh(own(new THREE.ConeGeometry(0.008, 0.042, 4)), howlBronzeMat);
      toe.rotation.x = Math.PI * 0.5;
      toe.rotation.z = toeAng;
      toe.position.set(Math.sin(toeAng) * 0.016, -0.116, 0.058 + Math.cos(toeAng) * 0.014);
      knee.add(toe);
    }

    hip.add(knee);
    castleGroup.add(hip);
    castleLegs.push({ hip, knee, phase: ls.phase });
  }

  // Soft wispy clouds drifting lightly beneath the moving legs
  const cloudPuffs: [number, number, number, number][] = [
    [-0.18, -0.22, 0.09, 0.068],
    [0.19, -0.21, -0.08, 0.065],
    [0.02, -0.26, 0.14, 0.058],
  ];
  for (const [clx, cly, clz, clr] of cloudPuffs) {
    const puff = new THREE.Mesh(own(new THREE.SphereGeometry(clr, 8, 6)), cloudMat);
    puff.scale.set(1.5, 0.58, 1.25);
    puff.position.set(clx, cly, clz);
    castleGroup.add(puff);
  }

  planetGroup.add(castleGroup);
  let castleTime = 0;
  let castleTapBoost = 0;
  let castleLegPhase = 0;
  let castleWingPhase = 0;
  let castleSmokePhase = 0;
  {
    const initCDir = new THREE.Vector3(
      Math.cos(0.38) * Math.sin(2.45),
      Math.sin(0.38),
      Math.cos(0.38) * Math.cos(2.45)
    ).normalize();
    castleGroup.position.copy(initCDir).multiplyScalar(WORLD_CONFIG.planetRadius + 1.66);
    castleGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), initCDir);
  }

  interactiveProps.push({
    mesh: castleGroup,
    onTap: () => {
      castleTapBoost = 2.6;
    },
  });

  // THE LITTLE PRINCE HOLDING ONTO A STRING OF MIGRATING BIRDS (Orbiting gracefully in clear sky!)
  const princeGroup = new THREE.Group();
  princeGroup.scale.setScalar(0.98);

  const princeHairMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#efc14d', roughness: 0.88, flatShading: true })), 0.34, 5.0);
  const princeSkinMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#f5d8bc', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const princeTunicMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#4d7a47', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const princeScarfMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#f2ca52', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const princeBootMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#3b2e26', roughness: 0.92, flatShading: true })), 0.34, 5.0);
  const birdBodyMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#f4f0e6', roughness: 0.86, flatShading: true })), 0.34, 5.0);
  const birdWingMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#d8d4ca', roughness: 0.88, flatShading: true })), 0.34, 5.0);
  const birdBeakMat = own(new THREE.MeshStandardMaterial({ color: '#e08234', roughness: 0.7 }));
  const cordMat = own(new THREE.MeshBasicMaterial({ color: '#ede7da' }));

  const princeFig = new THREE.Group();
  princeFig.position.set(0, -0.02, -0.06);
  princeFig.rotation.x = 0.24; // slight trailing wind lean as birds pull him forward (+Z)

  const princeTorso = new THREE.Mesh(own(new THREE.CylinderGeometry(0.024, 0.032, 0.075, 7)), princeTunicMat);
  princeTorso.position.y = 0.038;
  princeTorso.castShadow = true;
  const princeBelt = new THREE.Mesh(own(new THREE.CylinderGeometry(0.03, 0.031, 0.012, 7)), princeScarfMat);
  princeBelt.position.y = 0.024;
  princeFig.add(princeTorso, princeBelt);

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(own(new THREE.CylinderGeometry(0.009, 0.008, 0.048, 5)), princeTunicMat);
    leg.position.set(side * 0.012, -0.02, -0.005);
    leg.rotation.x = side * 0.14;
    const boot = new THREE.Mesh(own(new THREE.BoxGeometry(0.014, 0.014, 0.022)), princeBootMat);
    boot.position.set(side * 0.012, -0.045, -0.002);
    const arm = new THREE.Mesh(own(new THREE.CylinderGeometry(0.008, 0.007, 0.056, 5)), princeTunicMat);
    arm.position.set(side * 0.024, 0.088, 0.008);
    arm.rotation.z = side * 0.26;
    arm.rotation.x = 0.18;
    const hand = new THREE.Mesh(own(new THREE.SphereGeometry(0.008, 6, 5)), princeSkinMat);
    hand.position.set(side * 0.016, 0.114, 0.014);
    princeFig.add(leg, boot, arm, hand);
  }

  const princeHead = new THREE.Group();
  princeHead.position.set(0, 0.095, 0.004);
  const headSphere = new THREE.Mesh(own(new THREE.DodecahedronGeometry(0.022, 0)), princeSkinMat);
  headSphere.castShadow = true;
  const hairBase = new THREE.Mesh(own(new THREE.SphereGeometry(0.023, 8, 6)), princeHairMat);
  hairBase.position.set(0, 0.006, -0.002);
  princeHead.add(headSphere, hairBase);
  for (const [hx, hy, hz, r] of [
    [-0.014, 0.018, 0.01, -0.4],
    [0.014, 0.018, 0.01, 0.4],
    [0, 0.024, 0.004, 0.15],
  ]) {
    const lock = new THREE.Mesh(own(new THREE.ConeGeometry(0.008, 0.022, 4)), princeHairMat);
    lock.position.set(hx, hy, hz);
    lock.rotation.z = r;
    princeHead.add(lock);
  }
  princeFig.add(princeHead);

  // Flowing billowing yellow scarf trailing in flight (-Z)
  const scarfCollar = new THREE.Mesh(own(new THREE.TorusGeometry(0.022, 0.008, 5, 10)), princeScarfMat);
  scarfCollar.rotation.x = Math.PI * 0.5;
  scarfCollar.position.set(0, 0.072, 0.002);
  princeFig.add(scarfCollar);

  const princeScarfSegs: THREE.Mesh[] = [];
  for (let s = 0; s < 4; s++) {
    const seg = new THREE.Mesh(own(new THREE.BoxGeometry(0.016, 0.006, 0.036)), princeScarfMat);
    seg.position.set(0, 0.072 + s * 0.005, -0.024 - s * 0.031);
    princeFig.add(seg);
    princeScarfSegs.push(seg);
  }
  princeGroup.add(princeFig);

  // V-Formation Flock of 7 Migrating Wild Birds & Taut Cords to the Prince's Raised Hands
  interface PrinceBird {
    group: THREE.Group;
    wingL: THREE.Group;
    wingR: THREE.Group;
    phase: number;
    baseY: number;
  }
  const princeBirds: PrinceBird[] = [];
  const gripPoint = new THREE.Vector3(0, 0.118, 0.024).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.24).add(princeFig.position);
  const birdOffsets: [number, number, number][] = [
    [0, 0.30, 0.24],
    [-0.08, 0.28, 0.17],
    [0.08, 0.28, 0.17],
    [-0.15, 0.26, 0.10],
    [0.15, 0.26, 0.10],
    [-0.22, 0.24, 0.02],
    [0.22, 0.24, 0.02],
  ];

  birdOffsets.forEach(([bx, by, bz], idx) => {
    const bg = new THREE.Group();
    bg.position.set(bx, by, bz);

    const bBody = new THREE.Mesh(own(new THREE.ConeGeometry(0.014, 0.055, 6)), birdBodyMat);
    bBody.rotation.x = Math.PI * 0.5;
    bBody.castShadow = true;
    const bBeak = new THREE.Mesh(own(new THREE.ConeGeometry(0.005, 0.016, 4)), birdBeakMat);
    bBeak.rotation.x = Math.PI * 0.5;
    bBeak.position.set(0, 0, 0.034);
    bg.add(bBody, bBeak);

    const wingL = new THREE.Group();
    const wingLMesh = new THREE.Mesh(own(new THREE.BoxGeometry(0.044, 0.004, 0.018)), birdWingMat);
    wingLMesh.position.x = -0.022;
    wingL.add(wingLMesh);
    bg.add(wingL);

    const wingR = new THREE.Group();
    const wingRMesh = new THREE.Mesh(own(new THREE.BoxGeometry(0.044, 0.004, 0.018)), birdWingMat);
    wingRMesh.position.x = 0.022;
    wingR.add(wingRMesh);
    bg.add(wingR);

    princeGroup.add(bg);
    princeBirds.push({ group: bg, wingL, wingR, phase: idx * 0.85, baseY: by });

    // Taut string from bird chest back down to the Prince's raised hands
    const end = new THREE.Vector3(bx, by - 0.006, bz);
    const diff = end.clone().sub(gripPoint);
    const len = diff.length();
    const cord = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0018, 0.0018, len, 4)), cordMat);
    cord.position.copy(gripPoint).addScaledVector(diff, 0.5);
    cord.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), diff.normalize());
    princeGroup.add(cord);
  });

  planetGroup.add(princeGroup);
  let princeTime = 0;
  let princeWingPhase = 0;
  let princeTapBoost = 0;
  const princeHit = new THREE.Mesh(
    own(new THREE.SphereGeometry(0.28, 8, 6)),
    own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
  );
  princeHit.position.set(0, 0.14, 0.06);
  princeGroup.add(princeHit);
  interactiveProps.push(
    { mesh: princeGroup, onTap: () => { princeTapBoost = 2.2; } },
    { mesh: princeHit, onTap: () => { princeTapBoost = 2.2; } }
  );

  // WRIGHT BROTHERS 1903 FLYER BIPLANE (2.2x larger, unmistakable +Z nose & fluttering scarf streaming -Z, wobbly early aviation!)
  const wrightGroup = new THREE.Group();
  wrightGroup.scale.setScalar(2.22);

  const wrightCanvasMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#ede3cb', roughness: 0.94, flatShading: true })), 0.34, 5.0);
  const wrightWoodMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#785234', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const wrightMetalMat = own(new THREE.MeshStandardMaterial({ color: '#33363c', roughness: 0.58, metalness: 0.42, flatShading: true }));
  const wrightPilotFurMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#d46a2e', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const wrightScarfMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#c94a38', roughness: 0.9, flatShading: true })), 0.34, 5.0);
  const wrightGoggleMat = own(new THREE.MeshStandardMaterial({ color: '#2b241f', roughness: 0.35, metalness: 0.3 }));

  // Main upper & lower cambered muslin wings (+X span, +Z forward nose)
  for (const wy of [0, 0.058]) {
    const wing = new THREE.Mesh(own(new THREE.BoxGeometry(0.44, 0.0065, 0.082)), wrightCanvasMat);
    wing.position.set(0, wy, 0);
    wing.castShadow = true;
    wing.receiveShadow = true;
    wrightGroup.add(wing);
  }
  // Spruce interplane struts
  for (const sx of [-0.19, -0.115, -0.04, 0.04, 0.115, 0.19]) {
    for (const sz of [-0.03, 0.03]) {
      const strut = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0024, 0.0024, 0.058, 5)), wrightWoodMat);
      strut.position.set(sx, 0.029, sz);
      wrightGroup.add(strut);
    }
  }
  // Signature Wright Flyer forward-curved wooden sled skids (+Z front sleigh tips)
  for (const side of [-0.036, 0.036]) {
    const skid = new THREE.Mesh(own(new THREE.BoxGeometry(0.006, 0.006, 0.2)), wrightWoodMat);
    skid.position.set(side, -0.024, 0.046);
    skid.rotation.x = -0.04;
    const skidTip = new THREE.Mesh(own(new THREE.BoxGeometry(0.006, 0.006, 0.045)), wrightWoodMat);
    skidTip.position.set(side, -0.006, 0.155);
    skidTip.rotation.x = -0.68;
    const postF = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0024, 0.0024, 0.034, 4)), wrightWoodMat);
    postF.position.set(side, -0.01, 0.026);
    const postR = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0024, 0.0024, 0.026, 4)), wrightWoodMat);
    postR.position.set(side, -0.012, -0.022);
    wrightGroup.add(skid, skidTip, postF, postR);
  }

  // Forward Canard Biplane Elevator (+Z nose)
  for (const side of [-0.036, 0.036]) {
    const boom = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0022, 0.0022, 0.115, 4)), wrightWoodMat);
    boom.rotation.x = Math.PI * 0.5;
    boom.position.set(side, 0.014, 0.09);
    wrightGroup.add(boom);
  }
  const canardGroup = new THREE.Group();
  canardGroup.position.set(0, 0.016, 0.145);
  for (const cy of [-0.012, 0.014]) {
    const cPlane = new THREE.Mesh(own(new THREE.BoxGeometry(0.118, 0.0045, 0.03)), wrightCanvasMat);
    cPlane.position.y = cy;
    cPlane.castShadow = true;
    canardGroup.add(cPlane);
  }
  wrightGroup.add(canardGroup);

  // Rear Twin Vertical Rudder Vanes on trailing outriggers (-Z tail)
  for (const side of [-0.034, 0.034]) {
    const rBoom = new THREE.Mesh(own(new THREE.CylinderGeometry(0.0022, 0.0022, 0.11, 4)), wrightWoodMat);
    rBoom.rotation.x = Math.PI * 0.5;
    rBoom.position.set(side, 0.026, -0.09);
    wrightGroup.add(rBoom);
  }
  const rudderGroup = new THREE.Group();
  rudderGroup.position.set(0, 0.028, -0.142);
  for (const rx of [-0.016, 0.016]) {
    const vane = new THREE.Mesh(own(new THREE.BoxGeometry(0.0045, 0.06, 0.038)), wrightCanvasMat);
    vane.position.x = rx;
    vane.castShadow = true;
    rudderGroup.add(vane);
  }
  wrightGroup.add(rudderGroup);

  // Engine block & unmistakable forward-facing (+Z) aviator mink pilot with goggles + trailing crimson scarf (-Z)
  const engineBlock = new THREE.Mesh(own(new THREE.BoxGeometry(0.028, 0.026, 0.036)), wrightMetalMat);
  engineBlock.position.set(0.032, 0.018, 0.004);
  const fuelCan = new THREE.Mesh(own(new THREE.CylinderGeometry(0.007, 0.007, 0.03, 6)), mats.brass);
  fuelCan.position.set(0.048, 0.036, 0.012);
  wrightGroup.add(engineBlock, fuelCan);

  const aviatorBody = new THREE.Mesh(own(new THREE.CylinderGeometry(0.011, 0.013, 0.048, 6)), wrightPilotFurMat);
  aviatorBody.rotation.x = Math.PI * 0.5;
  aviatorBody.position.set(-0.014, 0.014, 0.002);
  const aviatorHead = new THREE.Mesh(own(new THREE.SphereGeometry(0.0115, 7, 5)), wrightPilotFurMat);
  aviatorHead.position.set(-0.014, 0.02, 0.03);
  const aviatorCap = new THREE.Mesh(own(new THREE.SphereGeometry(0.0122, 7, 5, 0, Math.PI * 2, 0, Math.PI * 0.58)), wrightWoodMat);
  aviatorCap.position.set(-0.014, 0.021, 0.029);
  const aviatorSnout = new THREE.Mesh(own(new THREE.ConeGeometry(0.0055, 0.013, 5)), wrightPilotFurMat);
  aviatorSnout.rotation.x = Math.PI * 0.5;
  aviatorSnout.position.set(-0.014, 0.018, 0.043);
  const aviatorGoggles = new THREE.Mesh(own(new THREE.BoxGeometry(0.016, 0.006, 0.005)), wrightGoggleMat);
  aviatorGoggles.position.set(-0.014, 0.023, 0.04);
  const aviatorTail = new THREE.Mesh(own(new THREE.ConeGeometry(0.0065, 0.026, 5)), wrightPilotFurMat);
  aviatorTail.rotation.x = -Math.PI * 0.45;
  aviatorTail.position.set(-0.014, 0.015, -0.028);
  wrightGroup.add(aviatorBody, aviatorHead, aviatorCap, aviatorSnout, aviatorGoggles, aviatorTail);

  const wrightScarfSegs: THREE.Mesh[] = [];
  for (let sc = 0; sc < 4; sc++) {
    const seg = new THREE.Mesh(own(new THREE.BoxGeometry(0.009, 0.0035, 0.022)), wrightScarfMat);
    seg.position.set(-0.014, 0.024 + sc * 0.002, 0.014 - sc * 0.02);
    wrightGroup.add(seg);
    wrightScarfSegs.push(seg);
  }

  // Twin rear-mounted pusher wooden propellers (-Z)
  const wrightProps: THREE.Group[] = [];
  for (const side of [-0.066, 0.066]) {
    const pHub = new THREE.Group();
    pHub.position.set(side, 0.03, -0.048);
    const bladeA = new THREE.Mesh(own(new THREE.BoxGeometry(0.074, 0.008, 0.0035)), wrightWoodMat);
    const bladeB = new THREE.Mesh(own(new THREE.BoxGeometry(0.008, 0.074, 0.0035)), wrightWoodMat);
    const cap = new THREE.Mesh(own(new THREE.SphereGeometry(0.0065, 6, 5)), mats.brass);
    pHub.add(bladeA, bladeB, cap);
    wrightGroup.add(pHub);
    wrightProps.push(pHub);
  }

  // Sputtering little exhaust smoke puffs trailing behind engine (-Z)
  const wrightSmoke: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; phase: number }[] = [];
  for (let s = 0; s < 3; s++) {
    const pMat = own(new THREE.MeshStandardMaterial({ color: '#ece8df', transparent: true, opacity: 0.36, roughness: 1.0 }));
    const puff = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.012, 0)), pMat);
    wrightGroup.add(puff);
    wrightSmoke.push({ mesh: puff, mat: pMat, phase: s * 0.33 });
  }

  planetGroup.add(wrightGroup);
  let wrightTime = 0;
  let wrightPropPhase = 0;
  let wrightTapBoost = 0;
  const wrightHit = new THREE.Mesh(
    own(new THREE.SphereGeometry(0.24, 8, 6)),
    own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
  );
  wrightHit.position.set(0, 0.025, 0.01);
  wrightGroup.add(wrightHit);
  interactiveProps.push(
    { mesh: wrightGroup, onTap: () => { wrightTapBoost = 2.4; } },
    { mesh: wrightHit, onTap: () => { wrightTapBoost = 2.4; } }
  );

  // GIANT BANZAI BILL (Super Mario Galaxy homage: sculpted matte obsidian shell, ferocious slanted eyes & shark grin, white-gloved fists, flared thruster & rocket smoke)
  const bulletGroup = new THREE.Group();
  bulletGroup.scale.setScalar(1.06);

  const bulletShellMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#1b1f27', roughness: 0.82, flatShading: true })), 0.34, 5.0);
  const bulletTrimMat = own(new THREE.MeshStandardMaterial({ color: '#39404d', roughness: 0.45, metalness: 0.48, flatShading: true }));
  const bulletWhiteMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#f4f0e4', roughness: 0.88, flatShading: true })), 0.34, 5.0);
  const bulletDarkMat = own(new THREE.MeshStandardMaterial({ color: '#0d0e12', roughness: 0.72 }));
  const bulletGloveMat = applyPaintedClayFinish(own(new THREE.MeshStandardMaterial({ color: '#f7f4ec', roughness: 0.86, flatShading: true })), 0.34, 5.0);
  const bulletEmberMat = own(new THREE.MeshStandardMaterial({
    color: '#ff9636',
    emissive: '#ff5514',
    emissiveIntensity: 0.9,
    roughness: 0.35,
  }));

  // Main barrel fuselage (+Z nose forward) + hemispherical warhead nose + steel belt & flared tail skirt (-Z)
  const bulletBarrel = new THREE.Mesh(own(new THREE.CylinderGeometry(0.142, 0.142, 0.25, 16)), bulletShellMat);
  bulletBarrel.rotation.x = Math.PI * 0.5;
  bulletBarrel.position.set(0, 0, -0.015);
  bulletBarrel.castShadow = true;
  bulletBarrel.receiveShadow = true;

  const bulletNose = new THREE.Mesh(own(new THREE.SphereGeometry(0.142, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.55)), bulletShellMat);
  bulletNose.rotation.x = Math.PI * 0.5;
  bulletNose.scale.y = 1.24;
  bulletNose.position.set(0, 0, 0.105);
  bulletNose.castShadow = true;

  const bulletBelt = new THREE.Mesh(own(new THREE.CylinderGeometry(0.146, 0.146, 0.022, 16)), bulletTrimMat);
  bulletBelt.rotation.x = Math.PI * 0.5;
  bulletBelt.position.set(0, 0, -0.105);

  const bulletCollar = new THREE.Mesh(own(new THREE.CylinderGeometry(0.124, 0.156, 0.092, 16)), bulletShellMat);
  bulletCollar.rotation.x = Math.PI * 0.5;
  bulletCollar.position.set(0, 0, -0.165);
  bulletCollar.castShadow = true;

  const bulletNozzle = new THREE.Mesh(own(new THREE.CylinderGeometry(0.094, 0.118, 0.036, 14)), bulletTrimMat);
  bulletNozzle.rotation.x = Math.PI * 0.5;
  bulletNozzle.position.set(0, 0, -0.205);

  const bulletCoreGlow = new THREE.Mesh(own(new THREE.SphereGeometry(0.082, 10, 8)), bulletEmberMat);
  bulletCoreGlow.scale.set(1, 1, 0.5);
  bulletCoreGlow.position.set(0, 0, -0.212);

  bulletGroup.add(bulletBarrel, bulletNose, bulletBelt, bulletCollar, bulletNozzle, bulletCoreGlow);

  // Fierce slanted eyes, brow ridges & shark grin on the upper/front +Z sides (unmistakable Banzai Bill face!)
  for (const side of [-1, 1]) {
    const eyeGroup = new THREE.Group();
    eyeGroup.position.set(side * 0.072, 0.044, 0.172);
    eyeGroup.rotation.y = side * 0.34;
    eyeGroup.rotation.z = -side * 0.28;

    const sclera = new THREE.Mesh(own(new THREE.SphereGeometry(0.036, 10, 8)), bulletWhiteMat);
    sclera.scale.set(1.18, 0.68, 0.42);
    const pupil = new THREE.Mesh(own(new THREE.SphereGeometry(0.016, 8, 6)), bulletDarkMat);
    pupil.scale.set(0.82, 1.05, 0.5);
    pupil.position.set(-side * 0.01, -0.002, 0.013);
    const brow = new THREE.Mesh(own(new THREE.BoxGeometry(0.078, 0.018, 0.026)), bulletShellMat);
    brow.position.set(0, 0.022, 0.006);
    brow.rotation.z = -side * 0.14;

    eyeGroup.add(sclera, pupil, brow);
    bulletGroup.add(eyeGroup);
  }

  // Iconic giant scowling toothed shark grin across the lower +Z nose
  const mouthCavity = new THREE.Mesh(own(new THREE.BoxGeometry(0.165, 0.044, 0.045)), bulletDarkMat);
  mouthCavity.position.set(0, -0.038, 0.188);
  mouthCavity.rotation.x = 0.24;
  bulletGroup.add(mouthCavity);

  for (let ti = -3; ti <= 3; ti++) {
    const u = ti / 3;
    const tx = ti * 0.023;
    const tz = 0.21 - u * u * 0.024;
    const ty = -0.036 + u * u * 0.012;
    const tooth = new THREE.Mesh(own(new THREE.BoxGeometry(0.017, 0.022, 0.014)), bulletWhiteMat);
    tooth.position.set(tx, ty, tz);
    tooth.rotation.y = ti * 0.14;
    tooth.rotation.x = 0.2;
    bulletGroup.add(tooth);
  }

  // Classic Bullet/Banzai Bill stubby arms + chunky white boxing-glove fists on flanks
  const bulletArms: { group: THREE.Group; side: number }[] = [];
  for (const side of [-1, 1]) {
    const ag = new THREE.Group();
    ag.position.set(side * 0.136, -0.015, -0.01);
    const sleeve = new THREE.Mesh(own(new THREE.CylinderGeometry(0.022, 0.026, 0.056, 7)), bulletShellMat);
    sleeve.rotation.z = -side * 1.15;
    sleeve.position.set(side * 0.026, -0.008, 0.008);
    const cuff = new THREE.Mesh(own(new THREE.CylinderGeometry(0.029, 0.029, 0.018, 8)), bulletGloveMat);
    cuff.rotation.z = -side * 1.15;
    cuff.position.set(side * 0.05, -0.016, 0.014);
    const fist = new THREE.Mesh(own(new THREE.SphereGeometry(0.038, 9, 7)), bulletGloveMat);
    fist.scale.set(1.05, 0.96, 1.12);
    fist.position.set(side * 0.074, -0.02, 0.022);
    fist.castShadow = true;
    ag.add(sleeve, cuff, fist);
    bulletGroup.add(ag);
    bulletArms.push({ group: ag, side });
  }

  // Billowing exhaust smoke trail streaming out of the rear nozzle (-Z)
  const bulletSmoke: { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; phase: number }[] = [];
  for (let s = 0; s < 5; s++) {
    const pMat = own(new THREE.MeshStandardMaterial({ color: '#f0ece2', transparent: true, opacity: 0.44, roughness: 0.96, flatShading: true }));
    const puff = new THREE.Mesh(own(new THREE.IcosahedronGeometry(0.048, 0)), pMat);
    bulletGroup.add(puff);
    bulletSmoke.push({ mesh: puff, mat: pMat, phase: s * 0.2 });
  }

  planetGroup.add(bulletGroup);
  let bulletTime = 0;
  let bulletTapBoost = 0;
  const bulletHit = new THREE.Mesh(
    own(new THREE.SphereGeometry(0.24, 8, 6)),
    own(new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }))
  );
  bulletHit.position.set(0, 0, 0.02);
  bulletGroup.add(bulletHit);
  interactiveProps.push(
    { mesh: bulletGroup, onTap: () => { bulletTapBoost = 2.4; } },
    { mesh: bulletHit, onTap: () => { bulletTapBoost = 2.4; } }
  );

  // Intentional first view: windmill, wooden bridge, helping hand ridge, painter studio, and minks visible right away
  planetGroup.rotation.set(0.18, -0.32, 0.0);

  let usePixelFilter = false;
  let isPaused = false;
  let reducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const pixelRT = own(new THREE.WebGLRenderTarget(260, 260, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
  }));
  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(
    own(new THREE.PlaneGeometry(2, 2)),
    own(new THREE.MeshBasicMaterial({ map: pixelRT.texture, transparent: true }))
  );
  postScene.add(postQuad);

  const turnaroundGroup = new THREE.Group();
  turnaroundGroup.visible = false;
  scene.add(turnaroundGroup);
  const turnaroundMink = createMinkRig(minkGeo, minkMat);
  turnaroundMink.group.scale.setScalar(2.8);
  turnaroundMink.group.position.set(0, -0.35, 0);
  turnaroundGroup.add(turnaroundMink.group);
  let turnaroundYaw = 0.55;

  const raycaster = new THREE.Raycaster();
  const pointerNDC = new THREE.Vector2();
  let isDragging = false;
  let dragDist = 0;
  let prevX = 0, prevY = 0;
  let velYaw = 0, velPitch = 0;
  let idleTimer = 0;
  let targetQuat: THREE.Quaternion | null = null;
  let rippleIdx = 0;

  const updatePointerNDC = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  };

  const activePointers = new Set<number>();
  let primaryPointerId: number | null = null;

  const onPointerDown = (e: PointerEvent) => {
    activePointers.add(e.pointerId);
    // Cancel dragging if a second finger touches down (prevents wild multi-touch spin)
    if (activePointers.size > 1) {
      isDragging = false;
      primaryPointerId = null;
      velYaw = 0;
      velPitch = 0;
      return;
    }
    primaryPointerId = e.pointerId;
    isDragging = true;
    dragDist = 0;
    prevX = e.clientX;
    prevY = e.clientY;
    targetQuat = null;
    idleTimer = WORLD_CONFIG.idleResumeDelay;
    canvas.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent) => {
    updatePointerNDC(e.clientX, e.clientY);

    if (isDragging) {
      if (e.pointerId !== primaryPointerId || activePointers.size > 1) return;
      const dx = THREE.MathUtils.clamp(e.clientX - prevX, -40, 40);
      const dy = THREE.MathUtils.clamp(e.clientY - prevY, -40, 40);
      dragDist += Math.hypot(dx, dy);
      prevX = e.clientX;
      prevY = e.clientY;
      idleTimer = WORLD_CONFIG.idleResumeDelay;

      if (turnaroundGroup.visible) {
        turnaroundYaw += dx * 0.01;
        return;
      }

      const stepYaw = THREE.MathUtils.clamp(dx * 0.006, -0.055, 0.055);
      const stepPitch = THREE.MathUtils.clamp(dy * 0.006, -0.055, 0.055);
      const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), stepYaw);
      const qPitch = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), stepPitch);
      planetGroup.quaternion.premultiply(qYaw).premultiply(qPitch).normalize();
      velYaw = stepYaw;
      velPitch = stepPitch;
    } else if (!turnaroundGroup.visible) {
      raycaster.setFromCamera(pointerNDC, camera);
      const hits = raycaster.intersectObject(planetMesh, false);
      if (hits.length > 0) {
        const localDir = planetGroup.worldToLocal(hits[0].point.clone()).normalize();
        for (const a of allAgents) {
          if (a.dir.angleTo(localDir) < 0.24 && !a.interrupted) {
            a.setGlanceToward(localDir);
          }
        }
      }
    }
  };

  const handleWorldTap = (clientX: number, clientY: number) => {
    updatePointerNDC(clientX, clientY);
    raycaster.setFromCamera(pointerNDC, camera);

    const minkHits = raycaster.intersectObjects(
      allAgents.map((a) => a.rig.mesh),
      false
    );
    if (minkHits.length > 0) {
      const agent = minkHits[0].object.userData.minkAgent as MinkAgent | undefined;
      if (agent) {
        agent.poke();
        if (agent.role === 'tea') agent.poseState = 'tea_offer';
        agent.onTap?.();
        return;
      }
    }

    const propMeshes = interactiveProps.map((p) => p.mesh);
    const propHits = raycaster.intersectObjects(propMeshes, true);
    if (propHits.length > 0) {
      let obj: THREE.Object3D | null = propHits[0].object;
      while (obj) {
        const entry = interactiveProps.find((p) => p.mesh === obj);
        if (entry) {
          entry.onTap();
          return;
        }
        obj = obj.parent;
      }
    }

    const waterHits = raycaster.intersectObject(waterMesh, false);
    const groundHits = raycaster.intersectObject(planetMesh, false);

    if (waterHits.length > 0 && (!groundHits.length || waterHits[0].distance <= groundHits[0].distance + 0.02)) {
      const localDir = planetGroup.worldToLocal(waterHits[0].point.clone()).normalize();
      if (getTerrainHeight(localDir) < WORLD_CONFIG.waterRadius) {
        waterUniforms.uRipples.value[rippleIdx].set(localDir.x, localDir.y, localDir.z, 0);
        rippleIdx = (rippleIdx + 1) % 4;
        for (const a of allAgents) {
          if (a.dir.angleTo(localDir) < 0.45) a.setGlanceToward(localDir);
        }
        return;
      }
    }

    if (groundHits.length > 0) {
      const localDir = planetGroup.worldToLocal(groundHits[0].point.clone()).normalize();
      if (localDir.angleTo(WORLD_CONFIG.landmarks.rose.dir) < 0.35) {
        agents.rose[0].poke(localDir);
        return;
      }
      if (localDir.angleTo(WORLD_CONFIG.landmarks.astro.dir) < 0.35) {
        agents.astro[0].poke(localDir);
        return;
      }
      let best: MinkAgent | null = null;
      let bestAng = 1.1;
      for (const w of agents.wanderers) {
        const ang = w.dir.angleTo(localDir);
        if (ang < bestAng && localDir.angleTo(WORLD_CONFIG.landmarks.rose.dir) > 0.65) {
          bestAng = ang;
          best = w;
        }
      }
      if (best) {
        best.targetDir = localDir;
        best.wanderPhase = 'walk';
        best.wanderTimer = 4.5;
        best.setGlanceToward(localDir);
      }
    }
  };

  const onPointerUp = (e: PointerEvent) => {
    activePointers.delete(e.pointerId);
    if (e.pointerId !== primaryPointerId) return;
    primaryPointerId = null;
    if (!isDragging) return;
    isDragging = false;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
    if (dragDist < 7 && !turnaroundGroup.visible) {
      handleWorldTap(e.clientX, e.clientY);
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);

  let planetZoom = 1.83;
  let idleMotionClock = 0;

  const updateCameraProjection = () => {
    const stage = canvas.parentElement;
    if (!stage) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w <= 0 || h <= 0) return;
    const heroH = stage.parentElement?.clientHeight || h;
    const aspect = w / h;
    const heroAspect = w / heroH;
    camera.aspect = aspect;
    const dist = 12.6;
    const minHalfH = Math.max(5.05, 5.1 / Math.max(0.48, heroAspect));
    const halfWorldAtZoom1 = minHalfH * (h / heroH);
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(halfWorldAtZoom1 / dist));
    const responsiveZoom = w < 640 ? planetZoom * 0.72 : planetZoom;
    camera.zoom = turnaroundGroup.visible ? 1.0 : responsiveZoom;
    // Biased to occupy right half, shifted cleanly upward so top of globe clips above hero top and lower half shows behind transparent sections below
    const offsetX = w >= 1024 ? -w * 0.23 : 0;
    const targetShiftFrac = turnaroundGroup.visible ? 0 : w >= 1024 ? -0.055 : 0.05;
    const offsetY = h * 0.5 - heroH * (0.5 + targetShiftFrac);
    camera.setViewOffset(w, h, offsetX, offsetY, w, h);
    camera.updateProjectionMatrix();
  };

  const resize = () => {
    const stage = canvas.parentElement;
    if (!stage) return;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w <= 0 || h <= 0) return;
    renderer.setSize(w, h, false);
    updateCameraProjection();

    const rtH = 260;
    const rtW = Math.max(160, Math.round(rtH * (w / h)));
    pixelRT.setSize(rtW, rtH);
  };
  let frameId = 0;
  const onContextLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(frameId);
    timeoutIds.forEach((id) => window.clearTimeout(id));
    timeoutIds.clear();
    const gl = renderer.getContext() as WebGL2RenderingContext;
    pendingSyncs.forEach((sync) => {
      try { gl.deleteSync(sync); } catch { /* Context is already lost. */ }
    });
    pendingSyncs.clear();
  };
  const onContextRestored = () => {
    if (disposed) return;
    lastPerf = engineNow();
    frameId = requestAnimationFrame(animate);
  };
  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);
  window.addEventListener('resize', resize);
  resize();

  let isVisible = true;
  let lastPerf = engineNow();
  const onVisibilityChange = () => {
    isVisible = document.visibilityState === 'visible';
    lastPerf = engineNow();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  let firstFrameRendered = false;

  const afterDraw = (cb: () => void) => {
    const gl = renderer.getContext() as WebGL2RenderingContext;
    let sync: WebGLSync | null = null;
    try {
      sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      if (sync) pendingSyncs.add(sync);
      gl.flush();
    } catch {
      // A lost or unavailable context cannot provide a GPU fence; continue with guarded scheduling.
    }
    const poll = () => {
      if (disposed) {
        if (sync) {
          try { gl.deleteSync(sync); } catch { /* Context may already be lost. */ }
          pendingSyncs.delete(sync);
        }
        return;
      }
      let state: number | null = null;
      try { state = sync ? gl.getSyncParameter(sync, gl.SYNC_STATUS) as number : null; } catch { /* Context loss: finish without polling. */ }
      if (state === gl.UNSIGNALED) {
        frameId = scheduleTimeout(poll, 5);
      } else {
        if (sync) {
          try { gl.deleteSync(sync); } catch { /* Context may already be lost. */ }
          pendingSyncs.delete(sync);
        }
        frameId = scheduleTimeout(cb, 80);
      }
    };
    frameId = scheduleTimeout(poll, 5);
  };

  const animate = (frameTime: number) => {
    const now = options.fixedPose ? 0 : frameTime;
    if (disposed) return;
    if (!isVisible) {
      frameId = requestAnimationFrame(animate);
      return;
    }

    const rawDt = (now - lastPerf) / 1000;
    lastPerf = now;
    const dt = Math.min(rawDt, 0.05) * (isPaused ? 0 : reducedMotion ? 0.35 : 1.0);

    waterUniforms.uTime.value += dt;
    for (const r of waterUniforms.uRipples.value) {
      if (r.w < 5.0) r.w += dt;
    }

    if (turnaroundGroup.visible) {
      turnaroundMink.group.rotation.y = THREE.MathUtils.lerp(turnaroundMink.group.rotation.y, turnaroundYaw, 0.12);
      applyMinkPose(turnaroundMink, { state: 'idle', time: now * 0.001, seed: 1 }, Math.max(0.016, dt));
    } else {
      if (targetQuat) {
        planetGroup.quaternion.slerp(targetQuat, 1 - Math.exp(-5.0 * Math.max(0.016, rawDt)));
        if (planetGroup.quaternion.angleTo(targetQuat) < 0.005) targetQuat = null;
      } else if (!isDragging) {
        if (Math.abs(velYaw) > 0.0001 || Math.abs(velPitch) > 0.0001) {
          const qY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), velYaw);
          const qX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), velPitch);
          planetGroup.quaternion.premultiply(qY).premultiply(qX).normalize();
          velYaw *= 0.91;
          velPitch *= 0.91;
        } else if (idleTimer > 0) {
          idleTimer -= rawDt;
        } else if (!isPaused && !reducedMotion && window.innerWidth >= 768) {
          idleMotionClock += dt;
          // Almost imperceptible dual-axis diorama rotation (mobile & reduced-motion stay as composed still)
          const dYaw = Math.cos(idleMotionClock * 0.22) * 0.012 * dt;
          const dPitch = Math.sin(idleMotionClock * 0.15) * 0.006 * dt;
          const qIdleY = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dYaw);
          const qIdleX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dPitch);
          planetGroup.quaternion.premultiply(qIdleY).premultiply(qIdleX).normalize();
        }
      }

      if (dt > 0) {
        // Subtle flicker on the lived-in campfire (brighter & warmer at night) + rising smoke puffs
        const flicker = 0.92 + Math.sin(now * 0.014) * 0.12 + Math.cos(now * 0.023) * 0.08;
        const fireScale = 0.85 + currentNightFactor * 0.45;
        campfireFlame.scale.set(fireScale, flicker * fireScale, fireScale);
        campfireFlame.rotation.y = Math.sin(now * 0.008) * 0.35;
        campfireLight.intensity = currentNightFactor * (0.9 + flicker * 0.3);
        campfireSmoke.forEach((puff, idx) => {
          const cycle = ((now * 0.00035 + idx * 0.25) % 1);
          puff.position.set(
            Math.sin(cycle * 5.0 + idx) * 0.022 * cycle,
            0.11 + cycle * 0.28,
            Math.cos(cycle * 4.2 + idx) * 0.018 * cycle
          );
          puff.scale.setScalar(0.6 + cycle * 1.35);
          (puff.material as THREE.MeshStandardMaterial).opacity = (1 - cycle) * 0.42;
        });
        windmillRotor.rotation.z -= 0.75 * dt;

        // Balloon pop burst confetti shards fade out cleanly
        for (let bi = balloonPopBursts.length - 1; bi >= 0; bi--) {
          const b = balloonPopBursts[bi];
          b.life -= dt;
          if (b.life <= 0) {
            planetGroup.remove(b.mesh);
            b.mesh.geometry.dispose();
            b.mat.dispose();
            balloonPopBursts.splice(bi, 1);
          } else {
            b.mesh.position.addScaledVector(b.vel, dt);
            b.vel.multiplyScalar(0.95);
            b.mat.opacity = Math.max(0, (b.life / 0.42) * 0.92);
          }
        }

        // Carl Fredricksen's "Up" house: pop 1 -> dips lower; pop 2 -> cascade pops while falling & lands upright on dry grass!
        balloonTime += dt;
        if (upHouseGlowBoost > 0) upHouseGlowBoost = Math.max(0, upHouseGlowBoost - dt);
        upWinMat.emissiveIntensity = 0.35 + currentNightFactor * 0.55 + (upHouseGlowBoost / 2.0) * 0.55;

        if (balloonMode === 'floating') {
          balloonAltDrop = THREE.MathUtils.lerp(balloonAltDrop, balloonTargetDrop, 1 - Math.exp(-5.0 * dt));
          const bLon = balloonTime * 0.055 + Math.sin(balloonTime * 0.09) * 0.55;
          const bLat = Math.sin(balloonTime * 0.075) * 0.72 + Math.cos(balloonTime * 0.045) * 0.22;
          balloonCurDir
            .set(Math.cos(bLat) * Math.sin(bLon), Math.sin(bLat), Math.cos(bLat) * Math.cos(bLon))
            .normalize();
          balloonCurrentAlt =
            WORLD_CONFIG.planetRadius + 1.44 - balloonAltDrop + Math.sin(balloonTime * 0.45) * 0.13;
          balloonGroup.position.copy(balloonCurDir).multiplyScalar(balloonCurrentAlt);
          balloonGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), balloonCurDir);
          balloonGroup.rotateY(balloonTime * 0.16);
          const swayAmp = balloonPopCount > 0 ? 0.24 : 0.14;
          balloonGroup.rotateZ(Math.sin(balloonTime * (balloonPopCount > 0 ? 1.4 : 0.65)) * swayAmp);
        } else if (balloonMode === 'falling') {
          cascadePopTimer -= dt;
          if (cascadePopTimer <= 0) {
            const nextUnpopped = balloonItems.find((it) => !it.popped);
            if (nextUnpopped) popBalloonItem(nextUnpopped);
            cascadePopTimer = 0.095;
          }
          // Gently steer clear of lakes/rivers and obstacle landmarks so the Up house lands cleanly on dry grass
          const nearObst = worldObstacles.find((o) => balloonCurDir.angleTo(o.dir) < o.radius + 0.26);
          if (nearObst) {
            const away = balloonCurDir.clone().sub(nearObst.dir).addScaledVector(balloonCurDir, -0.1).normalize();
            balloonCurDir.addScaledVector(away, 0.55 * dt).normalize();
          } else if (getRiverFactor(balloonCurDir) > 0.18 || getWalkableSurface(balloonCurDir).height < WORLD_CONFIG.waterRadius + 0.02) {
            const dryPush = new THREE.Vector3(0.25, 0.4, 0.2).addScaledVector(balloonCurDir, -0.2);
            balloonCurDir.addScaledVector(dryPush, 0.5 * dt).normalize();
          }
          balloonFallVel += 2.6 * dt;
          balloonCurrentAlt -= balloonFallVel * dt;
          const surf = getWalkableSurface(balloonCurDir);
          if (balloonCurrentAlt <= surf.height) {
            for (const it of balloonItems) popBalloonItem(it);
            balloonMode = 'landed';
            balloonCurrentAlt = surf.height;
            balloonGroup.position.copy(balloonCurDir).multiplyScalar(surf.height - 0.004);
            balloonGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), surf.normal);
            balloonGroup.rotateY(balloonTime * 0.25);
            worldObstacles.push({ dir: balloonCurDir.clone(), radius: 0.26 });
          } else {
            balloonGroup.position.copy(balloonCurDir).multiplyScalar(balloonCurrentAlt);
            balloonGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), balloonCurDir);
            balloonGroup.rotateY(balloonTime * 0.9);
            balloonGroup.rotateZ(Math.sin(balloonTime * 6.5) * 0.16);
          }
        } else {
          // Safely landed Carl Fredricksen's house resting cozily on dry ground with rising chimney smoke!
          upChimneySmoke.forEach((p, idx) => {
            p.visible = true;
            const cycle = ((balloonTime * 0.36 + idx * 0.33) % 1);
            p.position.set(
              0.035 + Math.sin(cycle * 5 + idx) * 0.014,
              0.256 + cycle * 0.16,
              -0.028 + cycle * 0.025
            );
            p.scale.setScalar(0.55 + cycle * 1.15);
            (p.material as THREE.MeshStandardMaterial).opacity = (1 - cycle) * 0.42;
          });
        }

        // Orbit Howl's Moving Castle smoothly (monotonic phase accumulators eliminate vibration/jitter on tap!)
        castleTime += dt;
        if (castleTapBoost > 0) castleTapBoost = Math.max(0, castleTapBoost - dt);
        const cLon = 2.45 + castleTime * 0.028;
        const cLat = 0.38 + Math.sin(castleTime * 0.045) * 0.28;
        const cDir = new THREE.Vector3(
          Math.cos(cLat) * Math.sin(cLon),
          Math.sin(cLat),
          Math.cos(cLat) * Math.cos(cLon)
        ).normalize();
        const boostNorm = castleTapBoost / 2.6;
        const cAlt = WORLD_CONFIG.planetRadius + 1.66 + Math.sin(castleTime * 0.55) * 0.06 + Math.sin(boostNorm * Math.PI) * 0.12;
        castleGroup.position.copy(cDir).multiplyScalar(cAlt);
        castleGroup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), cDir);
        castleGroup.rotateY(cLon * 0.35 + 0.6);

        // Monotonic phase accumulation avoids changing sin(t * speed) frequency across frames
        castleLegPhase += (2.8 + boostNorm * 2.0) * dt;
        castleWingPhase += (4.0 + boostNorm * 2.4) * dt;
        castleSmokePhase += (0.44 + boostNorm * 0.32) * dt;
        for (const leg of castleLegs) {
          const ph = castleLegPhase + leg.phase;
          leg.hip.rotation.x = Math.sin(ph) * 0.32;
          leg.knee.rotation.x = -0.25 + Math.cos(ph) * 0.28;
        }
        for (const w of castleWings) {
          w.group.rotation.z = w.side * Math.sin(castleWingPhase) * 0.22;
        }
        for (const sp of castleSmoke) {
          const cycle = (castleSmokePhase + sp.phase) % 1;
          sp.mesh.position.set(
            sp.base.x + Math.sin(cycle * 5.0 + sp.phase * 6) * 0.025,
            sp.base.y + 0.02 + cycle * 0.16,
            sp.base.z - cycle * 0.06
          );
          sp.mesh.scale.setScalar(0.55 + cycle * 1.35);
          sp.mat.opacity = (1 - cycle) * (0.38 + boostNorm * 0.22);
        }
        calciferMat.emissiveIntensity = 0.65 + Math.sin(castleTime * 7.5) * 0.15 + boostNorm * 0.75;
        castleGlow.intensity = 0.38 + boostNorm * 0.55;

        // Orbit The Little Prince holding onto his V-flock of migrating wild birds
        princeTime += dt;
        if (princeTapBoost > 0) princeTapBoost = Math.max(0, princeTapBoost - dt);
        const pBoost = princeTapBoost / 2.2;
        princeWingPhase += (6.5 + pBoost * 4.5) * dt;
        const evalPrinceDir = (tVal: number) => {
          const pLon = -1.75 + tVal * 0.052;
          const pLat = -0.35 + Math.sin(tVal * 0.11) * 0.48;
          return new THREE.Vector3(
            Math.cos(pLat) * Math.sin(pLon),
            Math.sin(pLat),
            Math.cos(pLat) * Math.cos(pLon)
          ).normalize();
        };
        const pDir = evalPrinceDir(princeTime);
        const pNextDir = evalPrinceDir(princeTime + 0.06);
        const pAlt = WORLD_CONFIG.planetRadius + 1.44 + Math.sin(princeTime * 0.75) * 0.08 + Math.sin(pBoost * Math.PI) * 0.14;
        princeGroup.position.copy(pDir).multiplyScalar(pAlt);
        const pUp = pDir.clone();
        const pFwd = pNextDir.sub(pDir).addScaledVector(pUp, -pNextDir.dot(pUp)).normalize();
        const pRight = new THREE.Vector3().crossVectors(pUp, pFwd).normalize();
        princeGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(pRight, pUp, pFwd));
        princeGroup.rotateZ(Math.sin(princeTime * 0.9) * 0.12);

        for (const bd of princeBirds) {
          const flap = Math.sin(princeWingPhase + bd.phase);
          bd.wingL.rotation.z = flap * 0.52;
          bd.wingR.rotation.z = -flap * 0.52;
          bd.group.position.y = bd.baseY + Math.cos(princeWingPhase + bd.phase) * 0.008;
        }
        princeScarfSegs.forEach((seg, idx) => {
          const wave = Math.sin(princeWingPhase * 0.9 - idx * 0.85);
          seg.position.x = wave * (0.004 + idx * 0.005);
          seg.position.y = 0.072 + idx * 0.005 + Math.cos(princeWingPhase * 0.7 - idx * 0.7) * 0.006;
          seg.rotation.y = wave * 0.25;
        });

        // Wright Flyer biplane: chugging, wavering, barely-staying-aloft early aviation path!
        wrightTime += dt;
        if (wrightTapBoost > 0) wrightTapBoost = Math.max(0, wrightTapBoost - dt);
        const wBoost = wrightTapBoost / 2.4;
        const evalWrightDir = (tVal: number) => {
          const wLon = 0.85 + tVal * 0.115 + Math.sin(tVal * 0.52) * 0.12;
          const wLat = -0.14 + Math.sin(tVal * 0.19) * 0.42 + Math.cos(tVal * 0.43) * 0.08;
          return new THREE.Vector3(
            Math.cos(wLat) * Math.sin(wLon),
            Math.sin(wLat),
            Math.cos(wLat) * Math.cos(wLon)
          ).normalize();
        };
        const evalWrightAltOffset = (tVal: number) =>
          Math.sin(tVal * 2.15) * 0.088 +
          Math.sin(tVal * 3.85 + 0.9) * 0.036 +
          Math.cos(tVal * 1.15) * 0.044;
        const wDir = evalWrightDir(wrightTime);
        const wNextDir = evalWrightDir(wrightTime + 0.05);
        const altNow = evalWrightAltOffset(wrightTime);
        const altNext = evalWrightAltOffset(wrightTime + 0.05);
        const climbPitch = Math.atan2(altNext - altNow, 0.05 * 0.35);
        const wAlt = WORLD_CONFIG.planetRadius + 0.96 + altNow + Math.sin(wBoost * Math.PI) * 0.18;
        wrightGroup.position.copy(wDir).multiplyScalar(wAlt);
        const wUp = wDir.clone();
        const wFwd = wNextDir.sub(wDir).addScaledVector(wUp, -wNextDir.dot(wUp)).normalize();
        const wRight = new THREE.Vector3().crossVectors(wUp, wFwd).normalize();
        wrightGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(wRight, wUp, wFwd));
        // Pitch (+Z nose) matches climb/descent slope + wing-warping roll flutter + slight shaky yaw
        wrightGroup.rotateY(Math.sin(wrightTime * 1.9 + 0.5) * 0.09);
        wrightGroup.rotateX(-(THREE.MathUtils.clamp(climbPitch * 0.32, -0.26, 0.28) + Math.cos(wrightTime * 4.4) * 0.045 + wBoost * 0.22));
        wrightGroup.rotateZ(Math.sin(wrightTime * 2.65) * 0.24 + Math.sin(wrightTime * 5.2) * 0.085);

        wrightPropPhase += (24.0 + Math.sin(wrightTime * 7.2) * 4.5 + wBoost * 12.0) * dt;
        wrightProps[0].rotation.z = wrightPropPhase;
        wrightProps[1].rotation.z = -wrightPropPhase;
        canardGroup.rotation.x = Math.sin(wrightTime * 2.15 + 0.6) * 0.24;
        rudderGroup.rotation.y = Math.sin(wrightTime * 1.9) * 0.26;
        wrightScarfSegs.forEach((seg, idx) => {
          const wave = Math.sin(wrightTime * 14.0 - idx * 0.95);
          seg.position.x = -0.014 + wave * (0.002 + idx * 0.003);
          seg.position.y = 0.024 + idx * 0.002 + Math.cos(wrightTime * 11.0 - idx * 0.8) * 0.0025;
          seg.rotation.y = wave * 0.28;
        });
        wrightSmoke.forEach((sp) => {
          const cycle = (wrightTime * (1.35 + wBoost * 0.7) + sp.phase) % 1;
          sp.mesh.position.set(
            0.028 + Math.sin(cycle * 6.0 + sp.phase * 8.0) * 0.012,
            0.022 + cycle * 0.042,
            -0.028 - cycle * 0.15
          );
          sp.mesh.scale.setScalar(0.5 + cycle * 1.25);
          sp.mat.opacity = (1 - cycle) * (0.34 + wBoost * 0.24);
        });

        // Giant Banzai Bill (Super Mario Galaxy homage): heavy looming flight orbiting smoothly above planet
        if (bulletTapBoost > 0) bulletTapBoost = Math.max(0, bulletTapBoost - dt);
        const bbBoost = bulletTapBoost / 2.4;
        bulletTime += dt * (1.0 + bbBoost * 1.15);
        const evalBulletDir = (tVal: number) => {
          const bLon = -0.35 - tVal * 0.115;
          const bLat = 0.22 + Math.sin(tVal * 0.21) * 0.44;
          return new THREE.Vector3(
            Math.cos(bLat) * Math.sin(bLon),
            Math.sin(bLat),
            Math.cos(bLat) * Math.cos(bLon)
          ).normalize();
        };
        const bbDir = evalBulletDir(bulletTime);
        const bbNextDir = evalBulletDir(bulletTime + 0.05);
        const bbAlt = WORLD_CONFIG.planetRadius + 1.24 + Math.sin(bulletTime * 0.95) * 0.055 + Math.sin(bbBoost * Math.PI) * 0.12;
        bulletGroup.position.copy(bbDir).multiplyScalar(bbAlt);
        const bbUp = bbDir.clone();
        const bbFwd = bbNextDir.sub(bbDir).addScaledVector(bbUp, -bbNextDir.dot(bbUp)).normalize();
        const bbRight = new THREE.Vector3().crossVectors(bbUp, bbFwd).normalize();
        bulletGroup.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(bbRight, bbUp, bbFwd));
        bulletGroup.rotateZ(Math.sin(bulletTime * 1.8) * 0.08 + bbBoost * Math.sin(bulletTime * 14.0) * 0.12);
        bulletEmberMat.emissiveIntensity = 0.8 + Math.sin(bulletTime * 10.0) * 0.22 + bbBoost * 0.9;
        for (const ba of bulletArms) {
          ba.group.rotation.x = Math.sin(bulletTime * 3.8 + ba.side * 0.7) * 0.14;
        }
        bulletSmoke.forEach((sp) => {
          const cycle = (bulletTime * (1.1 + bbBoost * 0.8) + sp.phase) % 1;
          sp.mesh.position.set(
            Math.sin(cycle * 6.5 + sp.phase * 7.0) * 0.022,
            Math.cos(cycle * 5.0 + sp.phase * 5.0) * 0.018,
            -0.25 - cycle * 0.48
          );
          sp.mesh.scale.setScalar(0.6 + cycle * 1.45);
          sp.mat.opacity = (1 - cycle) * (0.42 + bbBoost * 0.25);
        });

        for (const c of controllers) c.update(dt, currentNightFactor);

        // Daytime wanderers (Moss, Dot, Tansy) sleep late at night — unless crossing the bridge, in which case they walk off first
        for (const w of agents.wanderers) {
          if (currentNightFactor > 0.72 && w.id !== 'wren' && w.id !== 'alder' && !w.interrupted) {
            if (isBridgeRestrictedSpot(w.dir) || getWalkableSurface(w.dir).onBridge || getTerrainHeight(w.dir) < WORLD_CONFIG.waterRadius + 0.012) {
              const along = w.dir.dot(BRIDGE_FWD);
              const exitSign = Math.abs(along) > 0.01 ? Math.sign(along) : (w.forward.dot(BRIDGE_FWD) >= 0 ? 1 : -1);
              const exitDir = WORLD_CONFIG.landmarks.bridge.dir.clone().addScaledVector(BRIDGE_FWD, exitSign * 0.16).normalize();
              w.faceTowardDir(exitDir, dt, 6.5);
              w.speed = 0.28;
              w.poseState = 'walk';
              w.moveAlongSphere(dt);
            } else {
              w.speed = 0;
              w.poseState = 'sleep';
            }
          }
        }

        // Smooth, 2-pass tangential spherical separation so mink glide cleanly around props & each other without oscillating
        const MINK_RADIUS = 0.042;
        const PAIR_MIN_DIST = MINK_RADIUS * 2.0;
        const _sep = new THREE.Vector3();
        const maxPush = 0.22 * dt;

        for (let sepPass = 0; sepPass < 2; sepPass++) {
          // 1) Mink vs Mink smooth separation (preserve choreographed close poses like Helping Hand ridge)
          for (let i = 0; i < allAgents.length; i++) {
            const a = allAgents[i];
            for (let j = i + 1; j < allAgents.length; j++) {
              const b = allAgents[j];
              if (a.speed <= 0.01 && b.speed <= 0.01 && a.role === b.role && a.role !== 'wanderer') continue;
              const dist = a.dir.angleTo(b.dir);
              if (dist < PAIR_MIN_DIST) {
                const pushAmt = Math.min(PAIR_MIN_DIST - dist, maxPush);
                _sep.copy(a.dir).sub(b.dir);
                if (_sep.lengthSq() < 1e-8) {
                  const ref = Math.abs(a.dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
                  _sep.crossVectors(ref, a.dir);
                }
                _sep.normalize();

                const aMoves = a.speed > 0.01;
                const bMoves = b.speed > 0.01;
                const aMeadowW = a.role === 'meadow' && b.role === 'wanderer';
                const bMeadowW = b.role === 'meadow' && a.role === 'wanderer';
                const weightA = aMeadowW ? 0.0 : bMeadowW ? 1.0 : aMoves && !bMoves ? 1.0 : !aMoves && bMoves ? 0.0 : 0.5;
                const weightB = 1.0 - weightA;

                if (weightA > 0) {
                  const pushA = _sep.clone().addScaledVector(a.dir, -_sep.dot(a.dir));
                  if (pushA.lengthSq() > 1e-8) {
                    pushA.normalize();
                    a.dir.addScaledVector(pushA, pushAmt * weightA).normalize();
                    if (aMoves) {
                      const fIn = a.forward.dot(pushA);
                      if (fIn < 0) a.forward.addScaledVector(pushA, -fIn * 1.15);
                    }
                    a.forward.addScaledVector(a.dir, -a.forward.dot(a.dir)).normalize();
                  }
                }
                if (weightB > 0) {
                  const pushB = _sep.clone().negate().addScaledVector(b.dir, _sep.dot(b.dir));
                  if (pushB.lengthSq() > 1e-8) {
                    pushB.normalize();
                    b.dir.addScaledVector(pushB, pushAmt * weightB).normalize();
                    if (bMoves) {
                      const fIn = b.forward.dot(pushB);
                      if (fIn < 0) b.forward.addScaledVector(pushB, -fIn * 1.15);
                    }
                    b.forward.addScaledVector(b.dir, -b.forward.dot(b.dir)).normalize();
                  }
                }
              }
            }
          }

          // 2) Mink vs solid props/trees/rocks/hobbit hole (runs second so obstacle boundaries always win cleanly!)
          for (const a of allAgents) {
            for (const obs of worldObstacles) {
              if (a.role !== 'wanderer' && a.homeDir.angleTo(obs.dir) < 0.26) continue;
              const minDist = obs.radius + MINK_RADIUS;
              const dist = a.dir.angleTo(obs.dir);
              if (dist < minDist) {
                const overlap = minDist - dist;
                _sep.copy(a.dir).sub(obs.dir);
                _sep.addScaledVector(a.dir, -_sep.dot(a.dir));
                if (_sep.lengthSq() < 1e-8) {
                  const ref = Math.abs(a.dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
                  _sep.crossVectors(ref, a.dir);
                }
                _sep.normalize();
                a.dir.addScaledVector(_sep, Math.min(overlap, maxPush)).normalize();
                if (a.speed > 0.01) {
                  const fIn = a.forward.dot(_sep);
                  if (fIn < 0) a.forward.addScaledVector(_sep, -fIn * 1.15);
                }
                a.forward.addScaledVector(a.dir, -a.forward.dot(a.dir)).normalize();
              }
            }
          }
        }

        for (const a of allAgents) {
          if (Math.abs(a.currentScale - a.targetScale) > 0.002) {
            a.currentScale = THREE.MathUtils.lerp(a.currentScale, a.targetScale, 1 - Math.exp(-5.5 * dt));
            a.rig.group.scale.setScalar(a.currentScale);
          }
          a.update(dt, true, worldObstacles);
        }
      }
    }

    if (usePixelFilter) {
      renderer.setRenderTarget(pixelRT);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.render(postScene, postCam);
    } else {
      renderer.render(scene, camera);
    }

    if (!firstFrameRendered) {
      firstFrameRendered = true;
      if (!disposed) callbacks.onReady();
    }

    if (options.fixedPose) return;
    if (isSoftwareGl) {
      afterDraw(() => animate(engineNow()));
    } else {
      frameId = requestAnimationFrame(animate);
    }
  };

  frameId = requestAnimationFrame(animate);

  // Storybook-at-Dusk calibrated lighting keyframes (warm legible evening light, broad soft shadows, zero neon)
  const lightKeys = [
    { h: 0.0, sunC: new THREE.Color('#a8c2f0'), sunI: 1.38, skyC: new THREE.Color('#5a72ad'), gndC: new THREE.Color('#303652'), hemiI: 0.68, rimC: new THREE.Color('#7f9fd4'), rimI: 0.48 },
    { h: 5.0, sunC: new THREE.Color('#a8c2f0'), sunI: 1.38, skyC: new THREE.Color('#5a72ad'), gndC: new THREE.Color('#303652'), hemiI: 0.68, rimC: new THREE.Color('#7f9fd4'), rimI: 0.48 },
    { h: 7.5, sunC: new THREE.Color('#ffcb99'), sunI: 1.85, skyC: new THREE.Color('#c8d4eb'), gndC: new THREE.Color('#5c525c'), hemiI: 0.88, rimC: new THREE.Color('#d9b08c'), rimI: 0.44 },
    { h: 12.0, sunC: new THREE.Color('#fff1dc'), sunI: 2.02, skyC: new THREE.Color('#c9dcf0'), gndC: new THREE.Color('#6b5b4e'), hemiI: 0.94, rimC: new THREE.Color('#e6d9c5'), rimI: 0.34 },
    { h: 16.0, sunC: new THREE.Color('#ffe5c4'), sunI: 1.98, skyC: new THREE.Color('#b8cbe8'), gndC: new THREE.Color('#584c57'), hemiI: 0.92, rimC: new THREE.Color('#c9b3a3'), rimI: 0.38 },
    { h: 18.6, sunC: new THREE.Color('#f4a26a'), sunI: 1.88, skyC: new THREE.Color('#8b9ec7'), gndC: new THREE.Color('#3b3c54'), hemiI: 1.12, rimC: new THREE.Color('#8da6d6'), rimI: 0.46 },
    { h: 21.0, sunC: new THREE.Color('#a8c2f0'), sunI: 1.38, skyC: new THREE.Color('#5a72ad'), gndC: new THREE.Color('#303652'), hemiI: 0.68, rimC: new THREE.Color('#7f9fd4'), rimI: 0.48 },
    { h: 24.0, sunC: new THREE.Color('#a8c2f0'), sunI: 1.38, skyC: new THREE.Color('#5a72ad'), gndC: new THREE.Color('#303652'), hemiI: 0.68, rimC: new THREE.Color('#7f9fd4'), rimI: 0.48 },
  ];

  let currentNightFactor = 0;

  const computeNightFactor = (hours: number) => {
    const h = ((hours % 24) + 24) % 24;
    if (h >= 20 || h < 5.5) return 1;
    if (h >= 18 && h < 20) return (h - 18) / 2;
    if (h >= 5.5 && h < 7.5) return 1 - (h - 5.5) / 2;
    return 0;
  };

  const applyLightingForTime = (hours: number) => {
    const h = ((hours % 24) + 24) % 24;
    currentNightFactor = computeNightFactor(h);

    // Continuous 24-hour light orbit — Dusk sits warmly angled on front-right to illuminate all tiny scenes
    const solarAngle = ((h - 6) / 24) * Math.PI * 2;
    sunLight.position.set(
      Math.cos(solarAngle) * 6.8 + 1.8,
      4.4 + Math.sin(solarAngle) * 2.2,
      5.2 + Math.sin(solarAngle) * 0.9
    );

    // Smoothly interpolate between surrounding keyframes
    let a = lightKeys[0];
    let b = lightKeys[1];
    for (let i = 0; i < lightKeys.length - 1; i++) {
      if (h >= lightKeys[i].h && h <= lightKeys[i + 1].h) {
        a = lightKeys[i];
        b = lightKeys[i + 1];
        break;
      }
    }
    const span = Math.max(0.001, b.h - a.h);
    const rawT = Math.max(0, Math.min(1, (h - a.h) / span));
    const t = rawT * rawT * (3 - 2 * rawT); // smoothstep for silky transitions

    sunLight.color.copy(a.sunC).lerp(b.sunC, t);
    sunLight.intensity = THREE.MathUtils.lerp(a.sunI, b.sunI, t);
    hemiLight.color.copy(a.skyC).lerp(b.skyC, t);
    hemiLight.groundColor.copy(a.gndC).lerp(b.gndC, t);
    hemiLight.intensity = THREE.MathUtils.lerp(a.hemiI, b.hemiI, t);
    rimLight.color.copy(a.rimC).lerp(b.rimC, t);
    rimLight.intensity = THREE.MathUtils.lerp(a.rimI, b.rimI, t);
  };

  applyLightingForTime(options.fixedPose ? 12 : 18.6);

  const applyTimeOfDay = (hours: number) => {
    const h = ((hours % 24) + 24) % 24;
    // Map 24h cycle keeping Dusk (18.6h) oriented smoothly on our front diorama hemisphere
    const phase = ((h - 18.6) / 24) * Math.PI * 2;
    const tiltX = 0.18 + Math.sin(phase) * 0.22;
    const yawY = -0.32 - phase;
    targetQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(tiltX, yawY, 0, 'YXZ'));
    idleTimer = WORLD_CONFIG.idleResumeDelay;
    applyLightingForTime(h);
    callbacks.onTimeChange?.(h);
  };

  return {
    rotateToLandmark(lmId: LandmarkId) {
      const lm = WORLD_CONFIG.landmarks[lmId];
      if (!lm) return;
      const from = lm.dir.clone().normalize();
      const camDir = new THREE.Vector3(0, 0.24, 0.97).normalize();
      targetQuat = new THREE.Quaternion().setFromUnitVectors(from, camDir);
      idleTimer = WORLD_CONFIG.idleResumeDelay;
    },
    setTimeOfDay: applyTimeOfDay,
    setPlanetScale(scale: number) {
      planetZoom = THREE.MathUtils.clamp(scale, 0.55, 2.5);
      updateCameraProjection();
    },
    setClayMode(enabled: boolean) {
      planetMesh.material = enabled ? clayMat : planetMat;
      allAgents.forEach((a) => {
        a.rig.mesh.material = enabled ? clayMat : minkMat;
      });
      turnaroundMink.mesh.material = enabled ? clayMat : minkMat;
    },
    setPixelFilter(enabled: boolean) {
      usePixelFilter = enabled;
    },
    setPaused(paused: boolean) {
      isPaused = paused;
    },
    setReducedMotion(reduced: boolean) {
      reducedMotion = reduced;
    },
    setTurnaroundVisible(visible: boolean) {
      turnaroundGroup.visible = visible;
      planetGroup.visible = !visible;
      updateCameraProjection();
    },
    setTurnaroundYaw(yaw: number) {
      turnaroundYaw = yaw;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(frameId);
      timeoutIds.forEach((id) => window.clearTimeout(id));
      timeoutIds.clear();
      const gl = renderer.getContext() as WebGL2RenderingContext;
      pendingSyncs.forEach((sync) => {
        try { gl.deleteSync(sync); } catch { /* Context may already be lost. */ }
      });
      pendingSyncs.clear();
      if (primaryPointerId !== null && canvas.hasPointerCapture(primaryPointerId)) {
        canvas.releasePointerCapture(primaryPointerId);
      }
      activePointers.clear();
      primaryPointerId = null;
      isDragging = false;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibilityChange);

      const disposedGeometries = new Set<THREE.BufferGeometry>();
      const disposedMaterials = new Set<THREE.Material>();
      const disposedTextures = new Set<THREE.Texture>();
      const disposedSkeletons = new Set<THREE.Skeleton>();
      const disposedRenderTargets = new Set<THREE.WebGLRenderTarget>();
      const disposeTextureReferences = (value: unknown, seen: Set<object>) => {
        if (!value || typeof value !== 'object') return;
        if (value instanceof THREE.Texture) {
          if (value !== pixelRT.texture && !disposedTextures.has(value)) {
            disposedTextures.add(value);
            value.dispose();
          }
          return;
        }
        if (seen.has(value)) return;
        seen.add(value);
        if (Array.isArray(value)) {
          value.forEach((entry) => disposeTextureReferences(entry, seen));
        } else {
          Object.values(value).forEach((entry) => disposeTextureReferences(entry, seen));
        }
      };
      const disposeMaterial = (material: THREE.Material) => {
        if (disposedMaterials.has(material)) return;
        disposedMaterials.add(material);
        disposeTextureReferences(material, new Set<object>());
        material.dispose();
      };
      const disposeObjectTree = (root: THREE.Object3D) => {
        root.traverse((object) => {
          const renderable = object as THREE.Object3D & {
            geometry?: THREE.BufferGeometry;
            material?: THREE.Material | THREE.Material[];
            skeleton?: THREE.Skeleton;
          };
          if (renderable.geometry && !disposedGeometries.has(renderable.geometry)) {
            disposedGeometries.add(renderable.geometry);
            renderable.geometry.dispose();
          }
          if (renderable.material) {
            (Array.isArray(renderable.material) ? renderable.material : [renderable.material]).forEach(disposeMaterial);
          }
          if (renderable.skeleton && !disposedSkeletons.has(renderable.skeleton)) {
            disposedSkeletons.add(renderable.skeleton);
            renderable.skeleton.dispose();
          }
        });
      };
      disposeObjectTree(scene);
      disposeObjectTree(postScene);
      // Alternate materials can be detached when clay mode is toggled.
      [clayMat, planetMat, minkMat].forEach(disposeMaterial);
      // Balloon burst shards are the only currently detached scene objects; their geometry/material
      // are disposed at removal time in animate(), so no detached live resources remain here.
      if (!disposedRenderTargets.has(pixelRT)) {
        disposedRenderTargets.add(pixelRT);
        pixelRT.dispose();
      }
      for (const resource of ownedResources) resource.dispose();
      renderer.dispose();
      options.onResourceAudit?.({ created, disposed: disposedCounts, peak, live });
    },
  };
}
