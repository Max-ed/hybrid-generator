import './style.css';
import p5 from 'p5';
import { Pane } from 'tweakpane';

type BLEND_MODE =
  | 'color-burn' | 'color-dodge' | 'copy' | 'darken' | 'destination-out'
  | 'difference' | 'exclusion' | 'hard-light' | 'lighten' | 'lighter'
  | 'multiply' | 'overlay' | 'screen' | 'soft-light' | 'source-over' | 'subtract';

const W = 700;
const H = 990;

// No longer slider-controlled; kept as fixed behavior.
const FIXED_DENSITY = 0.5;
const FIXED_ARTIFACT_AMOUNT = 0.7;

// Uploaded typo SVGs are rasterized at this multiple of their native size so
// they stay crisp when the Scale slider goes above 100% or when exporting at
// high resolution — otherwise the bitmap only has as much detail as its
// original size.
const TYPO_RASTER_SCALE = 8;

// Uploaded Image 1/2/3 are resized to this multiple of canvas dimensions
// (instead of 1:1) so the block textures / fragments still have detail left
// to sample at high export resolutions.
const IMAGE_RASTER_SCALE = 2;

// Draw-order insertion points for typo boxes, from back to front. A Z value
// of N means "render after this many of the abstract layers have drawn."
const TYPO_Z_LAYER_COUNT = 6;

const PALETTE = [
  '#000000', '#ffffff', '#ff00aa', '#003cff',
  '#00ff66', '#ff5a00', '#00eaff', '#8a8a8a',
];

type MotionStyle = 'drift' | 'zoom';

const IMAGE_BLEND_MODES: { label: string; value: BLEND_MODE }[] = [
  { label: 'Normal', value: 'source-over' },
  { label: 'Multiply', value: 'multiply' },
  { label: 'Screen', value: 'screen' },
  { label: 'Overlay', value: 'overlay' },
  { label: 'Darken', value: 'darken' },
  { label: 'Lighten', value: 'lighten' },
  { label: 'Difference', value: 'difference' },
  { label: 'Exclusion', value: 'exclusion' },
  { label: 'Hard Light', value: 'hard-light' },
  { label: 'Soft Light', value: 'soft-light' },
  { label: 'Color Dodge', value: 'color-dodge' },
  { label: 'Color Burn', value: 'color-burn' },
];

interface Params {
  mutation: number;
  baseSpeed: number;
  speedVariance: number;
  blockTextureScale: number;
  imageBlendMode: BLEND_MODE;
  motionStyle: MotionStyle;
  typoDrift: boolean;
  typoScale1: number;
  typoZ1: number;
  typoY1: number;
  typoScale2: number;
  typoZ2: number;
  typoY2: number;
}

const params: Params = {
  mutation: 62,
  baseSpeed: 12,
  speedVariance: 45,
  blockTextureScale: 100,
  imageBlendMode: 'difference',
  motionStyle: 'drift',
  typoDrift: false,
  typoScale1: 20,
  typoZ1: TYPO_Z_LAYER_COUNT,
  typoY1: 45,
  typoScale2: 20,
  typoZ2: TYPO_Z_LAYER_COUNT,
  typoY2: 54,
};

// Order matters: this is the byte layout used by encodeSettings/decodeSettings.
const HASH_PARAM_KEYS: Exclude<keyof Params, 'motionStyle' | 'imageBlendMode' | 'typoDrift'>[] = [
  'mutation', 'baseSpeed', 'speedVariance',
  'blockTextureScale',
  'typoScale1', 'typoZ1', 'typoY1', 'typoScale2', 'typoZ2', 'typoY2',
];

function encodeSettings(seedValue: number): string {
  const bytes = HASH_PARAM_KEYS.map((key) => Math.max(0, Math.min(255, Math.round(params[key]))));
  bytes.push(params.motionStyle === 'zoom' ? 1 : 0);
  const blendIndex = IMAGE_BLEND_MODES.findIndex((o) => o.value === params.imageBlendMode);
  bytes.push(blendIndex >= 0 ? blendIndex : 0);
  bytes.push(params.typoDrift ? 1 : 0);
  const s = Math.max(0, Math.min(0xffffff, Math.round(seedValue)));
  bytes.push((s >> 16) & 0xff, (s >> 8) & 0xff, s & 0xff);
  const binary = bytes.map((b) => String.fromCharCode(b)).join('');
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeSettings(hash: string): { params: Partial<Params>; seed: number } | null {
  try {
    const normalized = hash.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const bytes = Array.from(binary, (ch) => ch.charCodeAt(0));
    if (bytes.length !== HASH_PARAM_KEYS.length + 3 + 3) return null;

    const decoded: Partial<Params> = {};
    HASH_PARAM_KEYS.forEach((key, i) => {
      decoded[key] = bytes[i];
    });
    decoded.motionStyle = bytes[HASH_PARAM_KEYS.length] === 1 ? 'zoom' : 'drift';
    decoded.imageBlendMode = IMAGE_BLEND_MODES[bytes[HASH_PARAM_KEYS.length + 1]]?.value ?? 'source-over';
    decoded.typoDrift = bytes[HASH_PARAM_KEYS.length + 2] === 1;

    const seedBytes = bytes.slice(HASH_PARAM_KEYS.length + 3);
    const seed = (seedBytes[0] << 16) | (seedBytes[1] << 8) | seedBytes[2];

    return { params: decoded, seed };
  } catch {
    return null;
  }
}

interface RectItem {
  x: number;
  y: number;
  w: number;
  h: number;
  c: p5.Color;
  mode: BLEND_MODE;
  id: number;
}

interface SliceItem {
  x: number;
  y: number;
  w: number;
  h: number;
  id: number;
}

interface Systems {
  structures: RectItem[];
  clusters: RectItem[];
  micro: RectItem[];
  hero: RectItem[];
  imageSlices: SliceItem[];
}

interface PosterSketch extends p5 {
  generatePoster: () => void;
  togglePause: () => void;
  resetImages: () => void;
  setUploadedImage: (slot: 1 | 2 | 3, file: File) => void;
  setTypoBox: (slot: 1 | 2, file: File) => void;
  saveJPG: () => void;
  savePNG: () => void;
  saveHighResPNG: (multiplier?: number) => Promise<void>;
  getSeed: () => number;
  setSeed: (seed: number) => void;
}

function fractional(x: number): number {
  return x - Math.floor(x);
}

const sketch = (p: p5) => {
  let paused = false;
  let seed = 12345;

  let imgA: p5.Image | null = null;
  let imgB: p5.Image | null = null;
  let imgC: p5.Image | null = null;
  let typoA: p5.Image | null = null;
  let typoB: p5.Image | null = null;
  let typoIdA = 0;
  let typoIdB = 0;

  let systems: Systems = {
    structures: [],
    clusters: [],
    micro: [],
    hero: [],
    imageSlices: [],
  };

  function pickColor(): p5.Color {
    return p.color(p.random(PALETTE));
  }

  function easeInOut(x: number): number {
    return x * x * (3 - 2 * x);
  }

  function elementSpeed(id: number): number {
    const variance = params.speedVariance / 100;
    const base = 0.35;
    const spread = p.map(p.noise(id * 0.019, seed), 0, 1, 0.25, 2.8);
    return p.lerp(base, spread, variance);
  }

  function lifecycle(id: number, t: number) {
    const spd = elementSpeed(id);
    const start = p.noise(id * 0.071, seed);
    const phase = fractional(start + t * spd);

    const appear = easeInOut(p.constrain(phase * 5, 0, 1));
    const disappear = 1 - easeInOut(p.constrain((phase - 0.78) * 5, 0, 1));
    const life = appear * disappear;

    return { phase, life, travel: phase, speed: spd };
  }

  function safeCount(arr: unknown[], amount: number): number {
    return p.constrain(Math.floor(amount), 0, arr.length);
  }

  // 'drift' is the original left-to-right scroll. 'zoom' interpolates each
  // element from the canvas center out toward its assigned (x, y), growing
  // from a small dot to full size as it travels — a flying-toward-camera feel.
  function applyMotion(baseX: number, baseY: number, travel: number, m: number, reach: number) {
    if (params.motionStyle === 'zoom') {
      const cx = p.width / 2;
      const cy = p.height / 2;
      const spread = 0.3 + m * 2.2;
      const k = travel * spread;
      const scaleMul = p.constrain(travel * 2.2, 0.08, 1);
      return { x: p.lerp(cx, baseX, k), y: p.lerp(cy, baseY, k), scaleMul };
    }
    return { x: baseX + travel * p.width * reach * m, y: baseY, scaleMul: 1 };
  }

  function texturedBlock(img: p5.Image | null, x: number, y: number, w: number, h: number, id: number) {
    if (!img) {
      p.rect(x, y, w, h);
      return;
    }

    // Sample-window math stays in canvas-space (img is IMAGE_RASTER_SCALE×
    // denser than the canvas, see setUploadedImage) so the crop's logical
    // position/size is unchanged — only multiply by the raster scale right
    // at the p.image() call, where it picks up the extra source detail.
    const logicalW = img.width / IMAGE_RASTER_SCALE;
    const logicalH = img.height / IMAGE_RASTER_SCALE;

    const textureScale = params.blockTextureScale / 100;
    const sampleW = p.constrain(w / textureScale, 4, logicalW);
    const sampleH = p.constrain(h / textureScale, 4, logicalH);

    let sx = Math.floor(p.noise(id * 0.01, seed) * Math.max(1, logicalW - sampleW));
    let sy = Math.floor(p.noise(id * 0.02, seed) * Math.max(1, logicalH - sampleH));

    sx = p.constrain(sx, 0, logicalW - sampleW);
    sy = p.constrain(sy, 0, logicalH - sampleH);

    p.blendMode(params.imageBlendMode);
    p.smooth();
    p.image(img, x, y, w, h, sx * IMAGE_RASTER_SCALE, sy * IMAGE_RASTER_SCALE, sampleW * IMAGE_RASTER_SCALE, sampleH * IMAGE_RASTER_SCALE);
    p.noSmooth();
  }

  function buildStructures() {
    for (let i = 0; i < 34; i++) {
      systems.structures.push({
        x: p.random(-p.width * 0.35, p.width * 1.05),
        y: p.random(p.height),
        w: p.random(40, 280),
        h: p.random(12, 240),
        c: pickColor(),
        mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.SCREEN, p.HARD_LIGHT]),
        id: p.random(9999),
      });
    }
  }

  function buildClusters() {
    for (let i = 0; i < 90; i++) {
      systems.clusters.push({
        x: p.random(-p.width * 0.45, p.width * 1.05),
        y: p.random(p.height),
        w: p.random(8, 130),
        h: p.random(4, 80),
        c: pickColor(),
        mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.HARD_LIGHT]),
        id: p.random(9999),
      });
    }
  }

  function buildMicro() {
    for (let i = 0; i < 420; i++) {
      systems.micro.push({
        x: p.random(-p.width * 0.6, p.width * 1.05),
        y: p.random(p.height),
        w: p.random(2, 34),
        h: p.random(2, 28),
        c: pickColor(),
        mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.SCREEN]),
        id: p.random(9999),
      });
    }
  }

  function buildHero() {
    const cx = p.width * p.random(0.22, 0.52);
    const cy = p.height * p.random(0.35, 0.62);

    for (let i = 0; i < 22; i++) {
      systems.hero.push({
        x: cx + p.random(-140, 120),
        y: cy + p.random(-240, 240),
        w: p.random(70, 260),
        h: p.random(18, 120),
        c: pickColor(),
        mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.HARD_LIGHT]),
        id: p.random(9999),
      });
    }
  }

  function buildImageSlices() {
    for (let i = 0; i < 120; i++) {
      systems.imageSlices.push({
        x: p.random(-p.width * 0.45, p.width * 0.95),
        y: p.random(p.height),
        w: p.random(p.width * 0.18, p.width * 1.05),
        h: p.random(6, 60),
        id: p.random(9999),
      });
    }
  }

  function drawStructuralLayer(t: number, m: number, d: number) {
    const count = safeCount(systems.structures, systems.structures.length * d);

    for (let i = 0; i < count; i++) {
      const s = systems.structures[i];
      const l = lifecycle(s.id, t);

      if (l.life < 0.05) continue;

      p.blendMode(s.mode);
      p.noStroke();

      const motion = applyMotion(s.x, s.y, l.travel, m, 0.8);
      const x = motion.x;
      const y = motion.y;
      const sw = s.w * motion.scaleMul;
      const sh = s.h * motion.scaleMul;

      p.fill(s.c);

      if (imgC && i % 3 !== 0) {
        texturedBlock(imgC, x, y, sw, sh, s.id);
      } else {
        p.rect(x, y, sw, sh);
      }

      p.blendMode(p.DIFFERENCE);

      for (let k = 0; k < 3; k++) {
        p.fill(k % 2 === 0 ? 255 : 0);
        p.rect(
          x + p.noise(s.id + k) * sw,
          y + p.noise(s.id + k + 10) * sh,
          sw * p.noise(s.id + k + 20),
          Math.max(2, sh * 0.05),
        );
      }
    }
  }

  function drawHeroLayer(t: number, m: number) {
    for (let i = 0; i < systems.hero.length; i++) {
      const h = systems.hero[i];
      const l = lifecycle(h.id, t * 0.75);

      if (l.life < 0.04) continue;

      p.blendMode(h.mode);
      p.noStroke();
      p.fill(h.c);

      const motion = applyMotion(h.x, h.y, l.travel, m, 0.55);
      const w = h.w * motion.scaleMul;
      const hh = h.h * motion.scaleMul;
      const x = motion.x;
      const y = motion.y;

      if (imgC && i % 4 !== 0) {
        texturedBlock(imgC, x, y, w, hh, h.id);
      } else {
        p.rect(x, y, w, hh);
      }

      p.blendMode(p.DIFFERENCE);
      p.fill(255);

      p.rect(
        x + w * 0.15,
        y + hh * 0.42,
        w * 0.65,
        Math.max(3, hh * 0.08),
      );
    }
  }

  function drawArtifactLayer(t: number, m: number, a: number) {
    const count = safeCount(systems.clusters, systems.clusters.length * a);

    for (let i = 0; i < count; i++) {
      const c = systems.clusters[i];
      const l = lifecycle(c.id, t * 1.2);

      if (l.life < 0.08) continue;

      p.blendMode(c.mode);
      p.noStroke();

      const motion = applyMotion(c.x, c.y, l.travel, m, 1.05);
      const cw = c.w * motion.scaleMul;
      const ch = c.h * motion.scaleMul;
      const x = motion.x;
      const y = params.motionStyle === 'zoom' ? motion.y : motion.y + p.noise(c.id, seed) * 22 * m;

      p.fill(c.c);

      if (imgC && i % 5 === 0) {
        texturedBlock(imgC, x, y, cw, ch, c.id);
      } else {
        p.rect(x, y, cw, ch);
      }

      p.blendMode(p.DIFFERENCE);
      p.fill(255);

      p.rect(x, y + ch * 0.5, cw * 1.5, Math.max(2, ch * 0.08));
    }
  }

  function drawMicroLayer(t: number, m: number, d: number) {
    const count = safeCount(systems.micro, systems.micro.length * d);

    for (let i = 0; i < count; i++) {
      const pt = systems.micro[i];
      const l = lifecycle(pt.id, t * 1.8);

      if (l.life < 0.1) continue;

      p.blendMode(pt.mode);
      p.noStroke();

      const motion = applyMotion(pt.x, pt.y, l.travel, m, 1.2);

      p.fill(pt.c);
      p.rect(motion.x, motion.y, pt.w * motion.scaleMul, pt.h * motion.scaleMul);
    }
  }

  function drawImageFragments(img: p5.Image | null, t: number, m: number, offset: number) {
    if (!img) return;

    for (let i = 0; i < systems.imageSlices.length; i++) {
      const s = systems.imageSlices[i];
      const l = lifecycle(s.id + offset, t * 0.9);

      if (l.life < 0.05) continue;

      // 100% native resolution: sample area matches the slice's own
      // width/height 1:1, so proportions stay correct, no zoom. Sample math
      // stays in canvas-space (img is IMAGE_RASTER_SCALE× denser, see
      // setUploadedImage); only multiply by the raster scale at p.image().
      const logicalW = img.width / IMAGE_RASTER_SCALE;
      const logicalH = img.height / IMAGE_RASTER_SCALE;

      const sampleH = p.constrain(s.h, 4, logicalH);
      const sampleW = p.constrain(s.w, 4, logicalW);

      const sy = Math.floor(p.map(p.noise(s.id + offset, seed), 0, 1, 0, logicalH - sampleH));
      const sx = Math.floor(p.map(p.noise(s.id + offset + 90, seed), 0, 1, 0, logicalW - sampleW));

      const motion = applyMotion(s.x, s.y, l.travel, m, 0.95);

      p.blendMode(params.imageBlendMode);
      p.smooth();
      p.image(
        img,
        motion.x,
        motion.y,
        s.w * motion.scaleMul,
        s.h * motion.scaleMul,
        sx * IMAGE_RASTER_SCALE,
        sy * IMAGE_RASTER_SCALE,
        sampleW * IMAGE_RASTER_SCALE,
        sampleH * IMAGE_RASTER_SCALE,
      );
      p.noSmooth();
    }
  }

  // Typo boxes always ignore Image Opacity/Blend Mode. When Typo Drift is on
  // they reuse the same applyMotion + appear/disappear lifecycle as the
  // abstract layers, anchored at their own Y Position; when off they're
  // always-visible and static, but still placed at that same Y Position —
  // only the drift animation toggles off, not the Y/Z controls.
  function drawTypoBox(img: p5.Image | null, id: number, t: number, m: number, scalePct: number, centerYFrac: number) {
    if (!img) return;

    let x: number;
    let y: number;

    if (params.typoDrift) {
      const l = lifecycle(id, t);
      if (l.life < 0.05) return;
      const motion = applyMotion(p.width / 2, p.height * centerYFrac, l.travel, m, 0.5);
      x = motion.x;
      y = motion.y;
    } else {
      x = p.width / 2;
      y = p.height * centerYFrac;
    }

    // Scale is driven by height (as a % of canvas height), not by the SVG's
    // own native pixel size — so two uploads with different native
    // dimensions still land at the same visual size for the same slider
    // value. Width follows automatically to preserve aspect ratio.
    const aspect = img.width / img.height;
    const h = p.height * (scalePct / 100);
    const w = h * aspect;

    p.blendMode(p.BLEND);
    p.noTint();
    p.smooth();
    p.imageMode(p.CENTER);
    p.image(img, x, y, w, h);
    p.imageMode(p.CORNER);
    p.noSmooth();
  }

  function generatePoster(forcedSeed?: number) {
    seed = forcedSeed !== undefined ? forcedSeed : Math.floor(p.random(9999999));
    p.randomSeed(seed);
    p.noiseSeed(seed);

    systems = {
      structures: [],
      clusters: [],
      micro: [],
      hero: [],
      imageSlices: [],
    };

    buildStructures();
    buildClusters();
    buildMicro();
    buildHero();
    buildImageSlices();

    typoIdA = p.random(9999);
    typoIdB = p.random(9999);
  }

  p.setup = () => {
    p.createCanvas(W, H);
    p.pixelDensity(1);
    p.noSmooth();
    generatePoster();
  };

  p.draw = () => {
    if (paused) return;

    p.randomSeed(seed);
    p.noiseSeed(seed);

    p.background(0);

    const t = p.frameCount * p.map(params.baseSpeed, 0, 100, 0.0002, 0.012);
    const m = params.mutation / 100;

    // Build the abstract layers back-to-front, then splice the typo boxes
    // in at the draw-order position given by their Pos Z slider (0 = behind
    // everything, TYPO_Z_LAYER_COUNT = topmost).
    const layers: Array<() => void> = [
      () => drawImageFragments(imgA, t, m, 0),
      () => drawImageFragments(imgB, t, m, 1000),
      () => drawStructuralLayer(t, m, FIXED_DENSITY),
      () => drawHeroLayer(t, m),
      () => drawArtifactLayer(t, m, FIXED_ARTIFACT_AMOUNT),
      () => drawMicroLayer(t, m, FIXED_DENSITY),
    ];

    const typoInserts = [
      { z: p.constrain(Math.round(params.typoZ1), 0, TYPO_Z_LAYER_COUNT), fn: () => drawTypoBox(typoA, typoIdA, t, m, params.typoScale1, params.typoY1 / 100) },
      { z: p.constrain(Math.round(params.typoZ2), 0, TYPO_Z_LAYER_COUNT), fn: () => drawTypoBox(typoB, typoIdB, t, m, params.typoScale2, params.typoY2 / 100) },
    ].sort((insertA, insertB) => insertB.z - insertA.z);

    typoInserts.forEach(({ z, fn }) => layers.splice(z, 0, fn));

    layers.forEach((draw) => draw());

    p.blendMode(p.BLEND);
  };

  const exposed = p as PosterSketch;

  exposed.generatePoster = generatePoster;
  exposed.togglePause = () => {
    paused = !paused;
  };
  exposed.resetImages = () => {
    imgA = null;
    imgB = null;
    imgC = null;
    typoA = null;
    typoB = null;
  };
  exposed.setUploadedImage = (slot, file) => {
    const url = URL.createObjectURL(file);
    p.loadImage(url, (img) => {
      // Resized to IMAGE_RASTER_SCALE× canvas size (not 1:1) so block
      // textures/fragments still have detail left to sample at high export
      // resolutions — texturedBlock/drawImageFragments divide this back out.
      img.resize(W * IMAGE_RASTER_SCALE, H * IMAGE_RASTER_SCALE);
      if (slot === 1) imgA = img;
      if (slot === 2) imgB = img;
      if (slot === 3) imgC = img;
      URL.revokeObjectURL(url);
    });
  };
  exposed.setTypoBox = (slot, file) => {
    // Rasterized at TYPO_RASTER_SCALE× the SVG's native size so the source
    // bitmap has enough detail left to stay sharp once drawTypoBox stretches
    // it to the slider-driven height, or during a high-res export.
    //
    // p5's loadImage() can throw "the source image could not be decoded"
    // when handed an SVG directly — it tries to copy the <img> onto its own
    // backing canvas right as the browser's 'load' event fires, which for
    // vector sources can race ahead of the browser's own decode. Rasterizing
    // the SVG to a PNG ourselves first (using a plain <img> + canvas, which
    // has no such race) sidesteps the problem before p5 ever sees it.
    const reader = new FileReader();
    reader.onload = () => {
      const svgImg = new Image();
      svgImg.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = svgImg.naturalWidth * TYPO_RASTER_SCALE;
        canvas.height = svgImg.naturalHeight * TYPO_RASTER_SCALE;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(svgImg, 0, 0, canvas.width, canvas.height);
        p.loadImage(canvas.toDataURL('image/png'), (img) => {
          if (slot === 1) typoA = img;
          if (slot === 2) typoB = img;
        });
      };
      svgImg.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };
  exposed.saveJPG = () => p.saveCanvas('ai-glitch-poster', 'jpg');
  exposed.savePNG = () => p.saveCanvas('ai-glitch-poster', 'png');
  exposed.saveHighResPNG = async (multiplier = 8) => {
    const prevDensity = p.pixelDensity();
    p.pixelDensity(multiplier);
    // redraw() is async in p5 — must await it, otherwise saveCanvas() below
    // captures the canvas mid-clear (right after the pixelDensity resize)
    // instead of the freshly repainted frame, producing a blank PNG.
    await p.redraw();
    p.saveCanvas(`ai-glitch-poster-${multiplier}x`, 'png');
    p.pixelDensity(prevDensity);
    await p.redraw();
  };
  exposed.getSeed = () => seed;
  exposed.setSeed = (newSeed) => generatePoster(newSeed);
};

// Tweakpane's published .d.ts files import from '@tweakpane/core', which is
// never installed as a real dependency, so the real Pane type loses its
// inherited methods. Cast through this local shape instead of fighting it.
interface ButtonHandle {
  on(eventName: 'click', handler: () => void): void;
}

interface FolderHandle {
  addInput(target: object, key: string, opts?: Record<string, unknown>): void;
  addButton(opts: { title: string }): ButtonHandle;
  refresh(): void;
}

interface PaneHandle extends FolderHandle {
  addFolder(opts: { title: string }): FolderHandle;
}

const canvasHolder = document.getElementById('canvas-holder')!;
const myp5 = new p5(sketch, canvasHolder) as PosterSketch;

const pane = new Pane({
  container: document.getElementById('pane-holder')!,
  title: 'Hybrid Generator',
}) as unknown as PaneHandle;

pane.addInput(params, 'mutation', { min: 0, max: 100, step: 1, label: 'Mutation' });
pane.addInput(params, 'baseSpeed', { min: 0, max: 100, step: 1, label: 'Base Speed' });
pane.addInput(params, 'speedVariance', { min: 0, max: 100, step: 1, label: 'Speed Variability' });
pane.addInput(params, 'blockTextureScale', { min: 20, max: 220, step: 1, label: 'Image 3 Block Texture Scale' });
pane.addInput(params, 'imageBlendMode', {
  label: 'Image Blend Mode',
  options: Object.fromEntries(IMAGE_BLEND_MODES.map((o) => [o.label, o.value])),
});
pane.addInput(params, 'motionStyle', {
  label: 'Motion Style',
  options: { Drift: 'drift', 'Zoom In': 'zoom' },
});

const typoFolder = pane.addFolder({ title: 'Typo Boxes' });
typoFolder.addInput(params, 'typoDrift', { label: 'Typo Drift' });
typoFolder.addInput(params, 'typoScale1', { min: 5, max: 60, step: 1, label: 'Typo 1 Height %' });
typoFolder.addInput(params, 'typoZ1', { min: 0, max: TYPO_Z_LAYER_COUNT, step: 1, label: 'Typo 1 Pos Z' });
typoFolder.addInput(params, 'typoY1', { min: 0, max: 100, step: 0.5, label: 'Typo 1 Y Position' });
typoFolder.addInput(params, 'typoScale2', { min: 5, max: 60, step: 1, label: 'Typo 2 Height %' });
typoFolder.addInput(params, 'typoZ2', { min: 0, max: TYPO_Z_LAYER_COUNT, step: 1, label: 'Typo 2 Pos Z' });
typoFolder.addInput(params, 'typoY2', { min: 0, max: 100, step: 0.5, label: 'Typo 2 Y Position' });

const actions = pane.addFolder({ title: 'Actions' });
actions.addButton({ title: 'Generate' }).on('click', () => myp5.generatePoster());
actions.addButton({ title: 'Animate / Pause' }).on('click', () => myp5.togglePause());
actions.addButton({ title: 'Reset Images' }).on('click', () => myp5.resetImages());
actions.addButton({ title: 'Save JPG' }).on('click', () => myp5.saveJPG());
actions.addButton({ title: 'Save PNG' }).on('click', () => myp5.savePNG());
actions.addButton({ title: 'Save PNG (8x)' }).on('click', () => myp5.saveHighResPNG(8));

const hashState = { value: '' };
const hashFolder = pane.addFolder({ title: 'Hash' });
hashFolder.addInput(hashState, 'value', { label: 'Hash' });
hashFolder.addButton({ title: 'Copy Current Hash' }).on('click', () => {
  const hash = encodeSettings(myp5.getSeed());
  hashState.value = hash;
  pane.refresh();
  navigator.clipboard?.writeText(hash).catch(() => {});
});
hashFolder.addButton({ title: 'Apply Hash' }).on('click', () => {
  const decoded = decodeSettings(hashState.value.trim());
  if (!decoded) {
    window.alert('Invalid hash');
    return;
  }
  Object.assign(params, decoded.params);
  myp5.setSeed(decoded.seed);
  pane.refresh();
});

function wireUpload(inputId: string, slot: 1 | 2 | 3) {
  const input = document.getElementById(inputId) as HTMLInputElement;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) myp5.setUploadedImage(slot, file);
  });
}

function wireTypoUpload(inputId: string, slot: 1 | 2) {
  const input = document.getElementById(inputId) as HTMLInputElement;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) myp5.setTypoBox(slot, file);
  });
}

wireUpload('upload-1', 1);
wireUpload('upload-2', 2);
wireUpload('upload-3', 3);
wireTypoUpload('upload-typo-1', 1);
wireTypoUpload('upload-typo-2', 2);
