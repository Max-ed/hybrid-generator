import './style.css';
import p5 from 'p5';
import { Pane } from 'tweakpane';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BLEND_MODE =
  | 'color-burn' | 'color-dodge' | 'copy' | 'darken' | 'destination-out'
  | 'difference' | 'exclusion' | 'hard-light' | 'lighten' | 'lighter'
  | 'multiply' | 'overlay' | 'screen' | 'soft-light' | 'source-over' | 'subtract';

type Format = 'poster' | 'landscape' | 'social' | 'social45';

// Position keyframe for typo box animation
interface PosKeyframe { time: number; x: number; y: number; }

interface TypoBox {
  id: number;
  name: string;
  img: p5.Image | null;
  imgDataURL: string | null;  // PNG data URL of rasterised image (for project save)
  scale: number;          // % of canvas height
  x: number;             // 0..1 static position (used when posKfs is empty)
  y: number;
  z: number;             // 0..TYPO_Z_LAYER_COUNT draw order
  visStart: number;      // seconds — when box appears in timeline
  visEnd: number;        // seconds — when box disappears
  posKfs: PosKeyframe[]; // sorted by time; empty = use x/y above
}

interface Keyframe { time: number; value: number; }

interface Params {
  baseSpeed: number;
  speedVariance: number;
  density: number;
  format: Format;
}

interface RectItem {
  x: number; y: number; w: number; h: number;
  c: p5.Color; mode: BLEND_MODE; id: number;
}

interface SliceItem { x: number; y: number; w: number; h: number; id: number; }

interface Systems {
  structures: RectItem[];
  clusters: RectItem[];
  micro: RectItem[];
  hero: RectItem[];
  imageSlices: SliceItem[];
}

interface PosterSketch extends p5 {
  generatePoster: (seed?: number) => void;
  resetImages: () => void;
  setUploadedImage: (slot: 1, file: File) => void;
  rasterizeTypoBox: (file: File, callback: (img: p5.Image, dataURL: string) => void) => void;
  loadImageDataURL: (dataURL: string, callback: (img: p5.Image) => void) => void;
  saveJPG: () => void;
  savePNG: () => void;
  saveHighResPNG: (multiplier?: number) => Promise<void>;
  setFormat: (fmt: Format) => void;
  getSeed: () => number;
  setSeed: (s: number) => void;
}

// Selected keyframe for delete / highlight
type SelectedKf =
  | { kind: 'density'; idx: number }
  | { kind: 'speed'; idx: number }
  | { kind: 'typo-pos'; boxId: number; idx: number }
  | null;

// Tweakpane v3 local interface (avoids @tweakpane/core missing dep)
interface ButtonHandle { on(event: 'click', fn: () => void): void; hidden: boolean; title: string; }
interface FolderHandle {
  addInput(target: object, key: string, opts?: Record<string, unknown>): void;
  addButton(opts: { title: string }): ButtonHandle;
  addFolder(opts: { title: string; expanded?: boolean }): FolderHandle;
  refresh(): void;
  hidden: boolean;
}
interface PaneHandle extends FolderHandle {}

// Timeline drag targets
type TlDragTarget =
  | { kind: 'playhead' }
  | { kind: 'kf'; arr: Keyframe[]; idx: number }
  | { kind: 'typo-start'; id: number }
  | { kind: 'typo-end'; id: number }
  | { kind: 'typo-body'; id: number; initStart: number; initEnd: number; initMt: number }
  | { kind: 'typo-pos-kf'; box: TypoBox; idx: number }
  | { kind: 'audio-start'; initBarStart: number; initTrimStart: number; initMt: number }
  | { kind: 'audio-end'; initTrimEnd: number; initMt: number }
  | { kind: 'audio-body'; initBarStart: number; initMt: number }
  | null;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POSTER_W = 700;
const POSTER_H = 990;
const LANDSCAPE_W = 1920;
const LANDSCAPE_H = 1080;
const SOCIAL_W = 1080;
const SOCIAL_H = 1920;
const SOCIAL45_W = 1080;
const SOCIAL45_H = 1350;
const FIXED_MUTATION = 62;
const IMAGE_RASTER_SCALE = 2;
const TYPO_RASTER_SCALE = 8;
const TYPO_Z_LAYER_COUNT = 6;
const IMAGE_BLEND_MODE: BLEND_MODE = 'difference';

const PALETTE = [
  '#000000', '#ffffff', '#ff00aa', '#003cff',
  '#00ff66', '#ff5a00', '#00eaff', '#8a8a8a',
];

// Dark-to-light ramp drawn from PALETTE, used for the camera gradient map.
const GRADIENT_STOPS = ['#000000', '#003cff', '#ff00aa', '#ff5a00', '#ffffff'];

function installGradientMapFilter(): void {
  const toRgb = (hex: string) => [
    parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16),
  ];
  const stops = GRADIENT_STOPS.map(toRgb);
  const N = 32;
  const ch: string[][] = [[], [], []];
  for (let i = 0; i < N; i++) {
    const t = (i / (N - 1)) * (stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t));
    const f = t - k;
    for (let c = 0; c < 3; c++) {
      ch[c].push(((stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f) / 255).toFixed(4));
    }
  }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
  svg.style.cssText = 'position:absolute;width:0;height:0';
  svg.innerHTML = `<filter id="gradmap" color-interpolation-filters="sRGB">
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer>
      <feFuncR type="table" tableValues="${ch[0].join(' ')}"/>
      <feFuncG type="table" tableValues="${ch[1].join(' ')}"/>
      <feFuncB type="table" tableValues="${ch[2].join(' ')}"/>
    </feComponentTransfer>
  </filter>`;
  document.body.appendChild(svg);
}

const BOX_COLORS = ['#ff00aa', '#003cff', '#00ff66', '#ff5a00', '#00eaff', '#8a8a8a', '#ffee00', '#cc00ff'];

// ---------------------------------------------------------------------------
// Shared mutable state
// ---------------------------------------------------------------------------

const params: Params = {
  baseSpeed: 12,
  speedVariance: 45,
  density: 0.7,
  format: 'poster',
};

let canvasW = POSTER_W;
let canvasH = POSTER_H;

// Typo boxes
let typoBoxes: TypoBox[] = [];
let nextTypoId = 1;
// Hit areas written each draw frame, read by canvas mouse handlers
const typoHitBoxes = new Map<number, { cx: number; cy: number; w: number; h: number }>();

// Hover state for canvas cursor feedback (drag-and-drop removed)
let hoveredTypoId: number | null = null;

// Selected keyframe (shown with white outline; deleted with Delete key)
let selectedKf: SelectedKf = null;

// Project save/load — data URLs stored at load time for serialisation
let imgADataURL: string | null = null;

// Timeline
let tlDuration = 8;
let tlTime = 0;
let tlPlaying = false;
let densityKfs: Keyframe[] = [];
let speedKfs: Keyframe[] = [];

// Accumulated animation phase — integrated frame-by-frame so speed keyframes
// produce smooth acceleration instead of instant position jumps.
let animT = 0;

// ---------------------------------------------------------------------------
// Video export state
// ---------------------------------------------------------------------------

let mediaRecorder: MediaRecorder | null = null;
let recordedChunks: Blob[] = [];
let isRecording = false;

// ---------------------------------------------------------------------------
// Camera / live mode state
// ---------------------------------------------------------------------------

// App mode: 'record' = timeline/keyframes/export, 'live' = camera-driven, same visual controls.
type AppMode = 'record' | 'live';
let appMode: AppMode = 'record';
let isFullscreen = false;

let cameraStream: MediaStream | null = null;
let cameraVideo: HTMLVideoElement | null = null;
let cameraAnalysisCanvas: HTMLCanvasElement | null = null;
let cameraAnalysisCtx: CanvasRenderingContext2D | null = null;
let poseLandmarker: PoseLandmarker | null = null;
let poseLoadPromise: Promise<void> | null = null;
let poseFrameId = 0;
let lastPoseTs = -1;

// Tracked people: 33 landmarks each, in canvas px, with smoothed velocity (px/s).
interface TrackedPose {
  pts: Float32Array;   // [x0,y0, x1,y1, ...] canvas px
  vel: Float32Array;   // [vx0,vy0, ...] px/s (EMA)
  vis: Float32Array;   // smoothed visibility 0..1
  act: Float32Array;   // per-landmark activation 0..1 — ramps with hysteresis, never pops
  dxf: Float32Array;   // One Euro filtered derivative (px/s) per coordinate
  scale: number;       // body scale in px — smoothing is normalised by this
  t: number;           // last time this person was actually detected (ms)
}
const ACT_ON = 0.55, ACT_OFF = 0.35;   // visibility hysteresis
const POSE_COAST_MS = 600;             // keep a lost person this long before dropping them
// One Euro filter: heavy smoothing when still, responsive when moving. Cutoffs are in Hz and
// the speed term is normalised by body size, so standing close to the camera (large pixel
// movements for the same real motion) filters exactly like standing far away.
const EURO_MIN_CUTOFF = 0.8;
const EURO_BETA = 1.4;
const EURO_D_CUTOFF = 1.0;
const euroAlpha = (rate: number, cutoff: number) => 1 / (1 + rate / (2 * Math.PI * cutoff));

// Robust body scale in px from whichever landmarks are trustworthy.
function bodyScale(P: Float32Array, act: Float32Array): number {
  let sc = 0;
  if (act[11] > 0.3 && act[12] > 0.3) sc = Math.max(sc, Math.hypot(P[22] - P[24], P[23] - P[25]));
  if (act[23] > 0.3 && act[24] > 0.3) sc = Math.max(sc, Math.hypot(P[46] - P[48], P[47] - P[49]));
  if (act[11] > 0.3 && act[23] > 0.3) sc = Math.max(sc, Math.hypot(P[22] - P[46], P[23] - P[47]) * 0.7);
  if (act[7] > 0.3 && act[8] > 0.3)   sc = Math.max(sc, Math.hypot(P[14] - P[16], P[15] - P[17]) * 2.2);
  return Math.max(60, sc);
}
let poses: TrackedPose[] = [];
let motionEnergy = 0;      // presence + movement  0..1 (drives global density/speed offsets)
let motionBias = 0;        // body centre x  -1..1 (drives typo box nudge)

// Presence field — coarse grid (FIELD_PX canvas px per cell) rasterised from the skeleton.
// Every poster element samples it in applyMotion() for displacement + scale.
const FIELD_PX = 40;
let fieldW = 0, fieldH = 0;
let fieldOcc: Float32Array | null = null;    // smoothed body coverage per cell 0..1
let fieldVelX: Float32Array | null = null;   // velocity of nearest limb per cell (px/s)
let fieldVelY: Float32Array | null = null;
let fieldDispX: Float32Array | null = null;  // final displacement per cell (canvas px)
let fieldDispY: Float32Array | null = null;
let fieldScale: Float32Array | null = null;  // scale multiplier per cell
let fieldGain = 0;                           // 0..1 ramp; off until a person is tracked
// Scratch for the nearest-cell distance transforms (attract / repel modes)
let dtNX: Int16Array | null = null, dtNY: Int16Array | null = null, dtD: Float32Array | null = null;
let dtNX2: Int16Array | null = null, dtNY2: Int16Array | null = null;

// Two-pass chamfer that propagates the coordinates of the nearest seed cell.
// Replaces an O(cells²) brute-force search with O(cells).
function nearestSeedTransform(seed: Uint8Array, w: number, h: number, nx: Int16Array, ny: Int16Array): void {
  const d = dtD!;
  for (let i = 0; i < w * h; i++) {
    if (seed[i]) { d[i] = 0; nx[i] = i % w; ny[i] = (i / w) | 0; }
    else { d[i] = Infinity; nx[i] = -1; ny[i] = -1; }
  }
  const relax = (i: number, j: number, cx: number, cy: number) => {
    const sx = nx[j];
    if (sx < 0) return;
    const sy = ny[j];
    const ddx = sx - cx, ddy = sy - cy;
    const dd = ddx * ddx + ddy * ddy;
    if (dd < d[i]) { d[i] = dd; nx[i] = sx; ny[i] = sy; }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x > 0) relax(i, i - 1, x, y);
      if (y > 0) relax(i, i - w, x, y);
      if (x > 0 && y > 0) relax(i, i - w - 1, x, y);
      if (x < w - 1 && y > 0) relax(i, i - w + 1, x, y);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (x < w - 1) relax(i, i + 1, x, y);
      if (y < h - 1) relax(i, i + w, x, y);
      if (x < w - 1 && y < h - 1) relax(i, i + w + 1, x, y);
      if (x > 0 && y < h - 1) relax(i, i + w - 1, x, y);
    }
  }
}
// Body shapes for Magnetic mode (canvas px). Segments for limbs, a disc for the head,
// a filled quad for the torso — squares cling to the whole area, not just outlines.
type MagShape = { w: number } & (
  | { kind: 'seg';  ax: number; ay: number; bx: number; by: number; dx: number; dy: number; len2: number;
      va: [number, number]; vb: [number, number] }
  | { kind: 'disc'; cx: number; cy: number; r: number; v: [number, number] }
  | { kind: 'quad'; x: number[]; y: number[]; ex: number[]; ey: number[]; elen2: number[];
      cx: number; cy: number; v: Array<[number, number]> });
let magShapes: MagShape[] = [];
let videoBuffer: p5.Graphics | null = null;   // live camera frame used as the fragment source
let videoBufferAt = 0;                        // last refresh (ms) — camera only yields ~30fps
// Person mask from the pose model's segmentation head (same inference, no extra model).
let maskCanvas: HTMLCanvasElement | null = null;
let maskCtx: CanvasRenderingContext2D | null = null;
let maskImage: ImageData | null = null;
let maskReady = false;
let segEnabled = false;
let segPending = false;
let maskWork: Uint8Array | null = null;     // combined mask, blurred in place
let maskTmp: Uint8Array | null = null;      // box-blur scratch
let ditherNoise: Uint8Array | null = null;  // fixed per-pixel thresholds — stable, so no boiling

// ---- Live mode fixed-duration recording ----
const liveRecord = { seconds: 15 };
let liveRecBtn: ButtonHandle | null = null;
let liveRecTimeout = 0;
let liveRecTicker = 0;
let liveRecEndsAt = 0;


// The few knobs a non-technical operator sees. Internals are derived in fieldInternals().
const liveConfig = {
  mode: 'magnetic' as 'attract' | 'repel' | 'magnetic',
  strength: 0.7,   // how far squares travel toward/away from the body and how much they grow
  sweep: 0.5,      // how much fast limb movement flings squares
  reaction: 0.5,   // how much presence/movement boosts overall density + speed
  videoAsImage: true,
  gradientMap: true,
  keyOut: true,
  dither: 0.45,
  showSkeleton: false,
  mirror: true,
  rotate: 0 as 0 | 90 | 270,
};

let FI = computeFieldInternals();
function refreshFieldInternals(): void { FI = computeFieldInternals(); }
function computeFieldInternals() {
  const s = liveConfig.strength;
  return {
    pull: s,
    maxPull: 500,
    overshoot: 1.5,
    scaleNear: 2.0 * s,
    scaleFar: 0.5 * s,
    scaleRadius: 160,
    fieldSmooth: 0.3,
    sweepSec: 0.25 * liveConfig.sweep,       // px/s × sec → px
    sweepRadius: 260,
    densityStrength: 0.6 * liveConfig.reaction,
    speedStrength: 50 * liveConfig.reaction,
    biasStrength: 0.3 * liveConfig.reaction,
  };
}

// ---------------------------------------------------------------------------
// Audio reactivity state
// ---------------------------------------------------------------------------

// Pre-analysed per-frame data (60 fps granularity) — populated on file load.
let audioEnergyData: Float32Array | null = null; // normalised overall RMS  0..1
let audioBassData: Float32Array | null = null;    // normalised bass RMS     0..1
let audioDuration = 0;   // length of the loaded audio file in seconds
let audioElement: HTMLAudioElement | null = null; // hidden <audio> for playback
let audioObjectURL: string | null = null;         // revoked on next load
let audioRawBase64: string | null = null;         // for project save
let audioMimeType: string | null = null;

// Audio bar position in the timeline
let audioBarStart = 0;   // where the bar starts (timeline seconds)
let audioTrimStart = 0;  // which point in the audio file the left edge maps to
let audioTrimEnd = 0;    // which point in the audio file the right edge maps to

// Smoothed values written each draw frame, consumed by offset calculation
let smoothEnergy = 0;
let smoothBass = 0;

// User-configurable react strengths (driven from Tweakpane)
const audioConfig = {
  densityStrength: 0.3,  // max offset added to density  (0..1)
  speedStrength: 20,     // max offset added to baseSpeed (0..100)
  smooth: 0.15,          // EMA alpha (lower = smoother but more lag)
};

// CSS scale applied to the canvas (may differ from 1 in landscape mode)
let currentCanvasScale = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.byteLength; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

function fractional(x: number): number { return x - Math.floor(x); }
function easeInOut(x: number): number { return x * x * (3 - 2 * x); }

function interpKf(kfs: Keyframe[], t: number): number {
  const s = [...kfs].sort((a, b) => a.time - b.time);
  if (t <= s[0].time) return s[0].value;
  if (t >= s[s.length - 1].time) return s[s.length - 1].value;
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].time && t <= s[i + 1].time) {
      const f = (t - s[i].time) / (s[i + 1].time - s[i].time);
      return s[i].value + f * (s[i + 1].value - s[i].value);
    }
  }
  return s[0].value;
}

// Convert baseSpeed (0–100) to an animT-per-second rate.
// Mirrors the former `p.map(params.baseSpeed, 0, 100, 0.0002, 0.012) * 60` formula
// but expressed as a pure function so it can be called outside p5.
function speedToAnimRate(speed: number): number {
  return (0.0002 + (speed / 100) * 0.0118) * 60;
}

// Numerically integrate animT from 0 to targetTime using 200 steps.
// Call this whenever the playhead is scrubbed (so animT stays consistent
// with what frame-by-frame accumulation would have produced).
function recomputeAnimT(targetTime: number): void {
  const STEPS = 200;
  const dt = targetTime / STEPS;
  let acc = 0;
  for (let i = 0; i < STEPS; i++) {
    const st = i * dt;
    const speed = speedKfs.length >= 2 ? interpKf(speedKfs, st) : params.baseSpeed;
    acc += dt * speedToAnimRate(speed);
  }
  animT = acc;
}

// ---------------------------------------------------------------------------
// Audio analysis
// ---------------------------------------------------------------------------

// Core audio analysis — accepts a decoded ArrayBuffer + MIME type.
// Sets up playback element and pre-computes 60-fps analysis arrays.
async function loadAudioFromBuffer(arrayBuf: ArrayBuffer, mimeType: string): Promise<void> {
  // Playback element setup
  if (audioObjectURL) URL.revokeObjectURL(audioObjectURL);
  const blob = new Blob([arrayBuf], { type: mimeType });
  audioObjectURL = URL.createObjectURL(blob);
  if (!audioElement) {
    audioElement = document.createElement('audio');
    audioElement.style.display = 'none';
    document.body.appendChild(audioElement);
  }
  audioElement.src = audioObjectURL;
  audioElement.load();

  const baseCtx = new AudioContext();
  const decoded = await baseCtx.decodeAudioData(arrayBuf.slice(0)); // slice — decodeAudioData transfers ownership
  await baseCtx.close();

  audioDuration = decoded.duration;
  audioBarStart = 0;
  audioTrimStart = 0;
  audioTrimEnd = audioDuration;

  const FPS = 60;
  const frameCount = Math.ceil(audioDuration * FPS);
  const samplesPerFrame = Math.floor(decoded.sampleRate / FPS);
  const rawL = decoded.getChannelData(0);
  const rawR = decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : null;
  const raw = new Float32Array(rawL.length);
  for (let i = 0; i < raw.length; i++) raw[i] = rawR ? (rawL[i] + rawR[i]) * 0.5 : rawL[i];

  const energyArr = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const s = f * samplesPerFrame;
    const e = Math.min(s + samplesPerFrame, raw.length);
    let sq = 0;
    for (let i = s; i < e; i++) sq += raw[i] * raw[i];
    energyArr[f] = Math.sqrt(sq / (e - s));
  }

  const offCtx = new OfflineAudioContext(1, decoded.length, decoded.sampleRate);
  const src = offCtx.createBufferSource();
  src.buffer = decoded;
  const lpf = offCtx.createBiquadFilter();
  lpf.type = 'lowpass'; lpf.frequency.value = 200;
  src.connect(lpf); lpf.connect(offCtx.destination); src.start(0);
  const rendered = await offCtx.startRendering();
  const bassRaw = rendered.getChannelData(0);

  const bassArr = new Float32Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    const s = f * samplesPerFrame;
    const e = Math.min(s + samplesPerFrame, bassRaw.length);
    let sq = 0;
    for (let i = s; i < e; i++) sq += bassRaw[i] * bassRaw[i];
    bassArr[f] = Math.sqrt(sq / (e - s));
  }

  const sortedE = [...energyArr].sort((a, b) => a - b);
  const sortedB = [...bassArr].sort((a, b) => a - b);
  const peakE = sortedE[Math.floor(sortedE.length * 0.95)] || 1;
  const peakB = sortedB[Math.floor(sortedB.length * 0.95)] || 1;
  for (let f = 0; f < frameCount; f++) {
    energyArr[f] = Math.min(energyArr[f] / peakE, 1);
    bassArr[f] = Math.min(bassArr[f] / peakB, 1);
  }

  audioEnergyData = energyArr;
  audioBassData = bassArr;
  smoothEnergy = 0;
  smoothBass = 0;
}

// Load audio from a File object — stores base64 for project save, then analyses.
async function loadAudioFile(file: File): Promise<void> {
  const arrayBuf = await file.arrayBuffer();
  audioRawBase64 = arrayBufferToBase64(arrayBuf);
  audioMimeType = file.type || 'audio/mpeg';
  await loadAudioFromBuffer(arrayBuf, audioMimeType);
}

// Seek the audio element to the position that matches a given tlTime.
// Called on scrub so playback resumes from the right spot after a pause.
function seekAudioToTlTime(tl: number): void {
  if (!audioElement || !audioEnergyData) return;
  const barDur = audioTrimEnd - audioTrimStart;
  if (barDur <= 0) return;
  const inBar = tl >= audioBarStart && tl <= audioBarStart + barDur;
  if (inBar) {
    audioElement.currentTime = audioTrimStart + (tl - audioBarStart);
  } else {
    audioElement.pause();
  }
}

// Return raw (un-smoothed) energy and bass for a given timeline position.
// Returns {0, 0} when the playhead is outside the audio bar.
function getRawAudio(tlT: number): { energy: number; bass: number } {
  if (!audioEnergyData || !audioBassData) return { energy: 0, bass: 0 };
  const barDur = audioTrimEnd - audioTrimStart;
  if (barDur <= 0 || tlT < audioBarStart || tlT > audioBarStart + barDur) return { energy: 0, bass: 0 };
  const audioT = audioTrimStart + (tlT - audioBarStart);
  const f = Math.max(0, Math.min(audioEnergyData.length - 1, Math.floor(audioT * 60)));
  return { energy: audioEnergyData[f], bass: audioBassData[f] };
}

function interpPosKf(kfs: PosKeyframe[], t: number): { x: number; y: number } {
  const s = [...kfs].sort((a, b) => a.time - b.time);
  if (t <= s[0].time) return { x: s[0].x, y: s[0].y };
  if (t >= s[s.length - 1].time) return { x: s[s.length - 1].x, y: s[s.length - 1].y };
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].time && t <= s[i + 1].time) {
      const f = (t - s[i].time) / (s[i + 1].time - s[i].time);
      return { x: s[i].x + f * (s[i + 1].x - s[i].x), y: s[i].y + f * (s[i + 1].y - s[i].y) };
    }
  }
  return { x: s[0].x, y: s[0].y };
}

// Returns the current canvas-space position (0..1) of a typo box.
// In live mode, motionBias nudges X toward where movement is detected.
function getTypoPos(box: TypoBox): { x: number; y: number } {
  const base = box.posKfs.length === 0 ? { x: box.x, y: box.y } : interpPosKf(box.posKfs, tlTime);
  if (appMode !== 'live') return base;
  return {
    x: Math.max(0, Math.min(1, base.x + motionBias * FI.biasStrength)),
    y: base.y,
  };
}

function isTypoVisible(box: TypoBox): boolean {
  return tlTime >= box.visStart && tlTime <= box.visEnd;
}

// ---------------------------------------------------------------------------
// p5 sketch — pure rendering, no mouse handling
// ---------------------------------------------------------------------------

const sketch = (p: p5) => {
  let seed = 12345;
  let imgA: p5.Image | null = null;
  let systems: Systems = { structures: [], clusters: [], micro: [], hero: [], imageSlices: [] };
  let refreshCountdown = 0;

  function pickColor(): p5.Color { return p.color(p.random(PALETTE)); }

  function elementSpeed(id: number): number {
    const variance = params.speedVariance / 100;
    const spread = p.map(p.noise(id * 0.019, seed), 0, 1, 0.25, 2.8);
    return p.lerp(0.35, spread, variance);
  }

  function lifecycle(id: number, t: number) {
    const spd = elementSpeed(id);
    const start = p.noise(id * 0.071, seed);
    const phase = fractional(start + t * spd);
    const appear = easeInOut(p.constrain(phase * 5, 0, 1));
    const disappear = 1 - easeInOut(p.constrain((phase - 0.78) * 5, 0, 1));
    return { phase, life: appear * disappear, travel: phase, speed: spd };
  }

  function safeCount(arr: unknown[], amount: number): number {
    return p.constrain(Math.floor(amount), 0, arr.length);
  }

  function applyMotion(baseX: number, baseY: number, travel: number, m: number, reach: number, w: number, h: number) {
    let x = baseX + travel * p.width * reach * m;
    let y = baseY;
    let scaleMul = 1;
    if (appMode === 'live' && fieldGain > 0.001) {
      if (liveConfig.mode === 'magnetic') {
        if (magShapes.length > 0) {
          const g = fieldGain;
          const snap = snapToBody(x + w / 2, y + h / 2, baseX, baseY);
          const pull = (0.6 + 0.4 * liveConfig.strength) * g;
          const sweep = FI.sweepSec * g;
          x += (snap.x - (x + w / 2)) * pull + snap.vx * sweep;
          y += (snap.y - (y + h / 2)) * pull + snap.vy * sweep;
          scaleMul = 1 - 0.3 * liveConfig.strength * g;
        }
      } else if (fieldDispX) {
        const f = sampleField(x + w / 2, y + h / 2);
        x += f.dx; y += f.dy; scaleMul = f.scale;
      }
      // scale around the element's centre, not its corner
      x -= (w * (scaleMul - 1)) / 2;
      y -= (h * (scaleMul - 1)) / 2;
    }
    return { x, y, scaleMul };
  }

  // ---------------------------------------------------------------------------
  // Build systems
  // ---------------------------------------------------------------------------

  function buildStructures() {
    for (let i = 0; i < 34; i++) {
      systems.structures.push({
        x: p.random(-p.width * 0.35, p.width * 1.05), y: p.random(p.height),
        w: p.random(40, 280), h: p.random(12, 240),
        c: pickColor(), mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.SCREEN, p.HARD_LIGHT]) as BLEND_MODE,
        id: p.random(9999),
      });
    }
  }

  function buildClusters() {
    for (let i = 0; i < 90; i++) {
      systems.clusters.push({
        x: p.random(-p.width * 0.45, p.width * 1.05), y: p.random(p.height),
        w: p.random(8, 130), h: p.random(4, 80),
        c: pickColor(), mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.HARD_LIGHT]) as BLEND_MODE,
        id: p.random(9999),
      });
    }
  }

  function buildMicro() {
    for (let i = 0; i < 420; i++) {
      systems.micro.push({
        x: p.random(-p.width * 0.6, p.width * 1.05), y: p.random(p.height),
        w: p.random(2, 34), h: p.random(2, 28),
        c: pickColor(), mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.SCREEN]) as BLEND_MODE,
        id: p.random(9999),
      });
    }
  }

  function buildHero() {
    const cx = p.width * p.random(0.22, 0.52);
    const cy = p.height * p.random(0.35, 0.62);
    for (let i = 0; i < 22; i++) {
      systems.hero.push({
        x: cx + p.random(-140, 120), y: cy + p.random(-240, 240),
        w: p.random(70, 260), h: p.random(18, 120),
        c: pickColor(), mode: p.random([p.DIFFERENCE, p.EXCLUSION, p.HARD_LIGHT]) as BLEND_MODE,
        id: p.random(9999),
      });
    }
  }

  function buildImageSlices() {
    for (let i = 0; i < 120; i++) {
      // Mix of proportions so the fragments read as a composition, not only wide bands.
      // Sizes are derived from an aspect ratio so nothing exceeds roughly 4:1 either way.
      const kind = p.random();
      let w: number, h: number;
      if (kind < 0.28) {                      // landscape bands
        w = p.random(p.width * 0.2, p.width * 0.6); h = w * p.random(0.25, 0.55);
      } else if (kind < 0.48) {               // portrait columns
        h = p.random(p.height * 0.1, p.height * 0.28); w = h * p.random(0.28, 0.6);
      } else if (kind < 0.74) {               // chunky blocks, near square
        const b = p.random(p.width * 0.1, p.width * 0.38);
        w = b * p.random(0.8, 1.25); h = b * p.random(0.8, 1.25);
      } else if (kind < 0.92) {               // small tiles
        const b = p.random(p.width * 0.05, p.width * 0.13);
        w = b * p.random(0.7, 1.4); h = b * p.random(0.7, 1.4);
      } else {                                // portrait panels
        w = p.random(p.width * 0.12, p.width * 0.26); h = w * p.random(1.3, 2.0);
      }
      systems.imageSlices.push({
        x: p.random(-p.width * 0.45, p.width * 0.95), y: p.random(p.height),
        w, h, id: p.random(9999),
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Draw layers
  // ---------------------------------------------------------------------------

  function drawStructuralLayer(t: number, m: number, d: number) {
    const count = safeCount(systems.structures, systems.structures.length * d);
    for (let i = 0; i < count; i++) {
      const s = systems.structures[i];
      const l = lifecycle(s.id, t);
      if (l.life < 0.05) continue;
      p.blendMode(s.mode); p.noStroke(); p.fill(s.c);
      const motion = applyMotion(s.x, s.y, l.travel, m, 0.8, s.w, s.h);
      const sw = s.w * motion.scaleMul, sh = s.h * motion.scaleMul;
      p.rect(motion.x, motion.y, sw, sh);
      p.blendMode(p.DIFFERENCE);
      for (let k = 0; k < 3; k++) {
        p.fill(k % 2 === 0 ? 255 : 0);
        p.rect(motion.x + p.noise(s.id + k) * sw, motion.y + p.noise(s.id + k + 10) * sh,
          sw * p.noise(s.id + k + 20), Math.max(2, sh * 0.05));
      }
    }
  }

  function drawHeroLayer(t: number, m: number, d: number) {
    const count = safeCount(systems.hero, systems.hero.length * d);
    for (let i = 0; i < count; i++) {
      const h = systems.hero[i];
      const l = lifecycle(h.id, t * 0.75);
      if (l.life < 0.04) continue;
      p.blendMode(h.mode); p.noStroke(); p.fill(h.c);
      const motion = applyMotion(h.x, h.y, l.travel, m, 0.55, h.w, h.h);
      const w = h.w * motion.scaleMul, hh = h.h * motion.scaleMul;
      p.rect(motion.x, motion.y, w, hh);
      p.blendMode(p.DIFFERENCE); p.fill(255);
      p.rect(motion.x + w * 0.15, motion.y + hh * 0.42, w * 0.65, Math.max(3, hh * 0.08));
    }
  }

  function drawArtifactLayer(t: number, m: number, d: number) {
    const count = safeCount(systems.clusters, systems.clusters.length * d);
    for (let i = 0; i < count; i++) {
      const c = systems.clusters[i];
      const l = lifecycle(c.id, t * 1.2);
      if (l.life < 0.08) continue;
      p.blendMode(c.mode); p.noStroke();
      const motion = applyMotion(c.x, c.y, l.travel, m, 1.05, c.w, c.h);
      const cw = c.w * motion.scaleMul, ch = c.h * motion.scaleMul;
      const y = motion.y + p.noise(c.id, seed) * 22 * m;
      p.fill(c.c); p.rect(motion.x, y, cw, ch);
      p.blendMode(p.DIFFERENCE); p.fill(255);
      p.rect(motion.x, y + ch * 0.5, cw * 1.5, Math.max(2, ch * 0.08));
    }
  }

  function drawMicroLayer(t: number, m: number, d: number) {
    const count = safeCount(systems.micro, systems.micro.length * d);
    for (let i = 0; i < count; i++) {
      const pt = systems.micro[i];
      const l = lifecycle(pt.id, t * 1.8);
      if (l.life < 0.1) continue;
      p.blendMode(pt.mode); p.noStroke(); p.fill(pt.c);
      const motion = applyMotion(pt.x, pt.y, l.travel, m, 1.2, pt.w, pt.h);
      p.rect(motion.x, motion.y, pt.w * motion.scaleMul, pt.h * motion.scaleMul);
    }
  }

  function drawImageFragments(img: p5.Image | p5.Graphics | null, t: number, m: number, offset: number, d: number, rasterScale = IMAGE_RASTER_SCALE) {
    if (!img) return;
    const count = safeCount(systems.imageSlices, systems.imageSlices.length * d);
    p.blendMode(IMAGE_BLEND_MODE); p.smooth();
    for (let i = 0; i < count; i++) {
      const s = systems.imageSlices[i];
      const l = lifecycle(s.id + offset, t * 0.9);
      if (l.life < 0.05) continue;
      const logicalW = img.width / rasterScale;
      const logicalH = img.height / rasterScale;
      const sampleH = p.constrain(s.h, 4, logicalH);
      const sampleW = p.constrain(s.w, 4, logicalW);
      const sy = Math.floor(p.map(p.noise(s.id + offset, seed), 0, 1, 0, logicalH - sampleH));
      const sx = Math.floor(p.map(p.noise(s.id + offset + 90, seed), 0, 1, 0, logicalW - sampleW));
      const motion = applyMotion(s.x, s.y, l.travel, m, 0.95, s.w, s.h);
      p.image(img, motion.x, motion.y, s.w * motion.scaleMul, s.h * motion.scaleMul,
        sx * rasterScale, sy * rasterScale,
        sampleW * rasterScale, sampleH * rasterScale);
    }
    p.noSmooth();
  }

  // Debug overlay: active field cells (green) + tracked skeletons (pink).
  function drawSkeletonDebug() {
    p.push();
    p.blendMode(p.BLEND);
    if (fieldOcc) {
      p.noFill(); p.stroke(0, 255, 120, 160); p.strokeWeight(1);
      for (let i = 0; i < fieldW * fieldH; i++) {
        if (fieldOcc[i] > 0.3) p.rect((i % fieldW) * FIELD_PX, ((i / fieldW) | 0) * FIELD_PX, FIELD_PX, FIELD_PX);
      }
    }
    // Body shapes used by Magnetic mode (head disc + torso fill)
    p.noStroke(); p.fill(255, 0, 170, 60);
    for (const sh of magShapes) {
      if (sh.kind === 'disc') p.circle(sh.cx, sh.cy, sh.r * 2);
      else if (sh.kind === 'quad') p.quad(sh.x[0], sh.y[0], sh.x[1], sh.y[1], sh.x[2], sh.y[2], sh.x[3], sh.y[3]);
    }
    p.stroke(255, 0, 170); p.strokeWeight(3);
    for (const pose of poses) {
      for (const [a, b] of BONES) {
        if (pose.act[a] < 0.5 || pose.act[b] < 0.5) continue;
        p.line(pose.pts[a * 2], pose.pts[a * 2 + 1], pose.pts[b * 2], pose.pts[b * 2 + 1]);
      }
      p.noStroke(); p.fill(255, 0, 170);
      for (let i = 0; i < 33; i++) {
        if (pose.act[i] >= 0.5) p.circle(pose.pts[i * 2], pose.pts[i * 2 + 1], 8);
      }
      p.stroke(255, 0, 170);
    }
    p.noStroke(); p.fill(255); p.textSize(18);
    p.text(`people:${poses.length}  energy:${motionEnergy.toFixed(2)}  gain:${fieldGain.toFixed(2)}`, 12, 26);
    p.pop();
  }

  function drawTypoBox(box: TypoBox) {
    if (!box.img || !isTypoVisible(box)) return;
    const pos = getTypoPos(box);
    const cx = pos.x * p.width;
    const cy = pos.y * p.height;
    const aspect = box.img.width / box.img.height;
    const h = p.height * (box.scale / 100);
    const w = h * aspect;
    // Write hit area so native canvas events can detect drag
    typoHitBoxes.set(box.id, { cx, cy, w, h });
    p.blendMode(p.BLEND); p.noTint(); p.smooth();
    p.imageMode(p.CENTER);
    p.image(box.img, cx, cy, w, h);
    p.imageMode(p.CORNER);
    p.noSmooth();
    // Hover outline
    if (hoveredTypoId === box.id) {
      p.blendMode(p.BLEND); p.noFill();
      p.stroke(255, 120); p.strokeWeight(1);
      p.rectMode(p.CENTER);
      p.rect(cx, cy, w, h);
      p.rectMode(p.CORNER);
      p.noStroke();
    }
  }

  // ---------------------------------------------------------------------------
  // Generate
  // ---------------------------------------------------------------------------

  function generatePoster(forcedSeed?: number) {
    seed = forcedSeed !== undefined ? forcedSeed : Math.floor(p.random(9999999));
    p.randomSeed(seed); p.noiseSeed(seed);
    systems = { structures: [], clusters: [], micro: [], hero: [], imageSlices: [] };
    buildStructures(); buildClusters(); buildMicro(); buildHero(); buildImageSlices();
  }

  // ---------------------------------------------------------------------------
  // p5 lifecycle — AE-style: t is driven by tlTime, not frameCount
  // ---------------------------------------------------------------------------

  p.setup = () => {
    p.createCanvas(canvasW, canvasH);
    p.pixelDensity(1);
    p.noSmooth();
    generatePoster();
  };

  p.draw = () => {
    const live = appMode === 'live';
    const dt = p.deltaTime / 1000;
    if (live) refreshFieldInternals();
    const fi = FI;

    if (live) {
      // ---- Live: free-running animation, sliders + camera only ----
      if (audioElement && !audioElement.paused) audioElement.pause();
      smoothEnergy = 0; smoothBass = 0;
      const effectiveSpeed = Math.max(0, Math.min(100, params.baseSpeed + motionEnergy * fi.speedStrength));
      animT += dt * speedToAnimRate(effectiveSpeed);
    } else {
      // ---- Audio EMA (runs every frame so scrubbing reacts too) ----
      const rawAudio = getRawAudio(tlTime);
      smoothEnergy = audioConfig.smooth * rawAudio.energy + (1 - audioConfig.smooth) * smoothEnergy;
      smoothBass   = audioConfig.smooth * rawAudio.bass   + (1 - audioConfig.smooth) * smoothBass;

      // ---- Audio playback sync ----
      if (audioElement && audioEnergyData) {
        const barDur = audioTrimEnd - audioTrimStart;
        const inBar = barDur > 0 && tlTime >= audioBarStart && tlTime <= audioBarStart + barDur;
        const targetTime = audioTrimStart + (tlTime - audioBarStart);
        if (tlPlaying && inBar) {
          if (audioElement.paused) {
            audioElement.currentTime = targetTime;
            audioElement.play().catch(() => {/* autoplay blocked — user must interact first */});
          }
          if (audioElement.currentTime > audioTrimEnd) audioElement.pause();
        } else {
          if (!audioElement.paused) audioElement.pause();
        }
      }

      // ---- Advance timeline ----
      if (tlPlaying) {
        const kfSpeed = speedKfs.length >= 2 ? interpKf(speedKfs, tlTime) : params.baseSpeed;
        const effectiveSpeed = Math.max(0, Math.min(100, kfSpeed + smoothBass * audioConfig.speedStrength));
        animT += dt * speedToAnimRate(effectiveSpeed);

        tlTime += dt;
        if (tlTime >= tlDuration) {
          if (isRecording) { stopRecording(); }
          tlTime = 0; animT = 0;
          if (audioElement) audioElement.pause();
        }

        if (densityKfs.length >= 2) params.density = interpKf(densityKfs, tlTime);
        if (speedKfs.length >= 2) params.baseSpeed = interpKf(speedKfs, tlTime);
        if (--refreshCountdown <= 0) { refreshCountdown = 6; pane.refresh(); }
      }
    }

    p.randomSeed(seed); p.noiseSeed(seed);
    p.background(0);

    // t is the accumulated animation phase — smooth even when speed is keyed.
    const t = animT;
    const m = FIXED_MUTATION / 100;
    const kfDensity = !live && densityKfs.length >= 2 ? interpKf(densityKfs, tlTime) : params.density;
    const d = Math.max(0, Math.min(1,
      kfDensity
      + smoothEnergy * audioConfig.densityStrength
      + (live ? motionEnergy * fi.densityStrength : 0)
    ));

    typoHitBoxes.clear();

    // Live camera as the image source for the fragment slices
    let fragSrc: p5.Image | p5.Graphics | null = imgA;
    let fragScale = IMAGE_RASTER_SCALE;
    if (live && liveConfig.videoAsImage && cameraVideo && cameraVideo.readyState >= 2) {
      // Half the canvas — same aspect as the analysis canvas, so the segmentation mask maps
      // straight on with no re-cropping, at 4× less fill than a full-size buffer.
      const vbW = Math.round(canvasW / 2), vbH = Math.round(canvasH / 2);
      if (!videoBuffer || videoBuffer.width !== vbW || videoBuffer.height !== vbH) {
        videoBuffer?.remove();
        videoBuffer = p.createGraphics(vbW, vbH);
        videoBuffer.pixelDensity(1);
        videoBufferAt = 0;
      }
      // The camera delivers ~30fps; refreshing at 60 just redraws identical frames.
      const nowMs = p.millis();
      if (nowMs - videoBufferAt > 30) {
        videoBufferAt = nowMs;
        const vctx = videoBuffer.drawingContext as CanvasRenderingContext2D;
        vctx.clearRect(0, 0, vbW, vbH);
        drawCameraInto(vctx, vbW, vbH, liveConfig.gradientMap ? 'url(#gradmap)' : undefined);
        if (liveConfig.keyOut && maskReady && maskCanvas) {
          // Keep only the pixels the person mask covers; the rest becomes transparent and
          // so contributes nothing when the fragments blend onto the poster.
          vctx.save();
          vctx.filter = 'none';
          vctx.globalCompositeOperation = 'destination-in';
          // Smoothing would average the dither back into a soft ramp, so turn it off.
          vctx.imageSmoothingEnabled = liveConfig.dither <= 0.001;
          vctx.drawImage(maskCanvas, 0, 0, vbW, vbH);
          vctx.restore();
        }
      }
      fragSrc = videoBuffer;
      fragScale = 1;
    }

    const layers: Array<() => void> = [
      () => drawImageFragments(fragSrc, t, m, 0, d, fragScale),
      () => drawStructuralLayer(t, m, d),
      () => drawHeroLayer(t, m, d),
      () => drawArtifactLayer(t, m, d),
      () => drawMicroLayer(t, m, d),
      () => {},
    ];

    const typoInserts = [...typoBoxes]
      .map((box) => ({ z: p.constrain(Math.round(box.z), 0, TYPO_Z_LAYER_COUNT), fn: () => drawTypoBox(box) }))
      .sort((a, b) => b.z - a.z);
    typoInserts.forEach(({ z, fn }) => layers.splice(z, 0, fn));
    layers.forEach((draw) => draw());

    p.blendMode(p.BLEND);
    if (live && liveConfig.showSkeleton) drawSkeletonDebug();
  };

  // ---------------------------------------------------------------------------
  // Exposed API
  // ---------------------------------------------------------------------------

  const exposed = p as PosterSketch;

  exposed.generatePoster = generatePoster;
  exposed.resetImages = () => { imgA = null; typoBoxes.forEach((b) => (b.img = null)); };

  exposed.setUploadedImage = (_slot, file) => {
    const reader = new FileReader();
    reader.onload = () => {
      imgADataURL = reader.result as string;
      p.loadImage(imgADataURL, (img) => {
        img.resize(POSTER_W * IMAGE_RASTER_SCALE, POSTER_H * IMAGE_RASTER_SCALE);
        imgA = img;
      });
    };
    reader.readAsDataURL(file);
  };

  exposed.rasterizeTypoBox = (file, callback) => {
    const reader = new FileReader();
    reader.onload = () => {
      const svgImg = new Image();
      svgImg.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = svgImg.naturalWidth * TYPO_RASTER_SCALE;
        canvas.height = svgImg.naturalHeight * TYPO_RASTER_SCALE;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(svgImg, 0, 0, canvas.width, canvas.height);
        const dataURL = canvas.toDataURL('image/png');
        p.loadImage(dataURL, (img) => callback(img, dataURL));
      };
      svgImg.src = reader.result as string;
    };
    reader.readAsDataURL(file);
  };

  exposed.loadImageDataURL = (dataURL, callback) => {
    p.loadImage(dataURL, callback);
  };

  exposed.getSeed = () => seed;
  exposed.setSeed = (s) => { seed = s; };

  exposed.saveJPG = () => p.saveCanvas('hybrid-poster', 'jpg');
  exposed.savePNG = () => p.saveCanvas('hybrid-poster', 'png');
  exposed.saveHighResPNG = async (multiplier = 8) => {
    const prev = p.pixelDensity();
    p.pixelDensity(multiplier);
    await p.redraw();
    p.saveCanvas(`hybrid-poster-${multiplier}x`, 'png');
    p.pixelDensity(prev);
    await p.redraw();
  };

  exposed.setFormat = (fmt: Format) => {
    params.format = fmt;
    const dims: Record<Format, [number, number]> = {
      poster: [POSTER_W, POSTER_H],
      landscape: [LANDSCAPE_W, LANDSCAPE_H],
      social: [SOCIAL_W, SOCIAL_H],
      social45: [SOCIAL45_W, SOCIAL45_H],
    };
    [canvasW, canvasH] = dims[fmt] ?? [POSTER_W, POSTER_H];
    p.resizeCanvas(canvasW, canvasH);
    generatePoster();
    updateCanvasScale();
  };
};

// ---------------------------------------------------------------------------
// Boot p5
// ---------------------------------------------------------------------------

const canvasHolder = document.getElementById('canvas-holder')!;
const myp5 = new p5(sketch, canvasHolder) as PosterSketch;

// ---------------------------------------------------------------------------
// Canvas scaling (CSS transform for landscape format)
// ---------------------------------------------------------------------------

function updateCanvasScale() {
  const canvasEl = canvasHolder.querySelector('canvas') as HTMLCanvasElement | null;

  if (isFullscreen) {
    // Fill the full viewport (may upscale)
    currentCanvasScale = Math.min(window.innerWidth / canvasW, window.innerHeight / canvasH);
    if (canvasEl) {
      canvasEl.style.transform = `scale(${currentCanvasScale})`;
      canvasEl.style.transformOrigin = 'top left';
    }
    canvasHolder.style.width = `${Math.round(canvasW * currentCanvasScale)}px`;
    canvasHolder.style.height = `${Math.round(canvasH * currentCanvasScale)}px`;
    return;
  }

  const sidebar = document.getElementById('sidebar')!;
  const sidebarW = sidebar.offsetWidth + 24;
  const maxW = window.innerWidth - sidebarW - 40;
  const maxH = window.innerHeight - (appMode === 'live' ? 48 : 200); // no timeline in live
  currentCanvasScale = Math.min(maxW / canvasW, maxH / canvasH, 1);
  if (canvasEl) {
    canvasEl.style.transform = `scale(${currentCanvasScale})`;
    canvasEl.style.transformOrigin = 'top left';
  }
  canvasHolder.style.width = `${Math.round(canvasW * currentCanvasScale)}px`;
  canvasHolder.style.height = `${Math.round(canvasH * currentCanvasScale)}px`;
  canvasHolder.style.overflow = 'hidden';
}

window.addEventListener('resize', updateCanvasScale);

// ---------------------------------------------------------------------------
// Native canvas mouse handlers for typo box drag
// (uses getBoundingClientRect to compute canvas coordinates regardless of
//  CSS scale — p5's own mouseX/Y doesn't account for transform scaling)
// ---------------------------------------------------------------------------

function attachCanvasMouse() {
  const canvasEl = canvasHolder.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvasEl) { setTimeout(attachCanvasMouse, 50); return; }
  // Capture in non-null local so closures below don't see the nullable type
  const el = canvasEl;

  function toCanvas(e: MouseEvent) {
    const rect = el.getBoundingClientRect();
    // rect.width is the visual (CSS-scaled) width; el.width is the logical width
    return {
      x: (e.clientX - rect.left) * (el.width / rect.width),
      y: (e.clientY - rect.top) * (el.height / rect.height),
    };
  }

  el.addEventListener('mousemove', (e) => {
    const { x, y } = toCanvas(e);
    hoveredTypoId = null;
    for (const box of [...typoBoxes].reverse()) {
      const hit = typoHitBoxes.get(box.id);
      if (!hit) continue;
      if (Math.abs(x - hit.cx) <= hit.w / 2 && Math.abs(y - hit.cy) <= hit.h / 2) {
        hoveredTypoId = box.id;
        break;
      }
    }
    el.style.cursor = hoveredTypoId !== null ? 'crosshair' : 'default';
  });

  el.addEventListener('mouseleave', () => {
    hoveredTypoId = null;
    el.style.cursor = 'default';
  });
}

attachCanvasMouse();

// ---------------------------------------------------------------------------
// Audio upload handler
// ---------------------------------------------------------------------------

const audioUpload = document.getElementById('upload-audio') as HTMLInputElement;
const audioStatus = document.getElementById('audio-status') as HTMLDivElement;

audioUpload.addEventListener('change', () => {
  const file = audioUpload.files?.[0];
  if (!file) return;
  audioStatus.textContent = 'Analysing…';
  audioStatus.style.color = '#888';
  loadAudioFile(file)
    .then(() => {
      const mins = Math.floor(audioDuration / 60);
      const secs = (audioDuration % 60).toFixed(1);
      audioStatus.textContent = `✓ ${file.name.slice(0, 20)}  ${mins}m ${secs}s`;
      audioStatus.style.color = '#00cc88';
      renderTimeline();
    })
    .catch((err) => {
      audioStatus.textContent = `Error: ${err.message}`;
      audioStatus.style.color = '#ff4444';
    });
});

// ---------------------------------------------------------------------------
// Tweakpane
// ---------------------------------------------------------------------------

const pane = new Pane({
  container: document.getElementById('pane-holder')!,
  title: 'Hybrid Generator',
}) as unknown as PaneHandle;

pane.addInput(params, 'format', {
  label: 'Format',
  options: {
    'Poster 700×990': 'poster', 'Landscape 1920×1080': 'landscape',
    'Social 1080×1920': 'social', 'Social 1080×1350': 'social45',
  },
});
pane.addInput(params, 'baseSpeed', { min: 0, max: 100, step: 1, label: 'Speed' });
pane.addInput(params, 'speedVariance', { min: 0, max: 100, step: 1, label: 'Variation' });
pane.addInput(params, 'density', { min: 0, max: 1, step: 0.01, label: 'Density' });
pane.addButton({ title: 'Generate New' }).on('click', () => myp5.generatePoster());

// ---- Record-only ----
const recordFolder = pane.addFolder({ title: 'Timeline & Export' });
recordFolder.addButton({ title: '◆ Set Density Key' }).on('click', () => {
  densityKfs.push({ time: tlTime, value: params.density });
  densityKfs.sort((a, b) => a.time - b.time);
  renderTimeline();
});
recordFolder.addButton({ title: '◆ Set Speed Key' }).on('click', () => {
  speedKfs.push({ time: tlTime, value: params.baseSpeed });
  speedKfs.sort((a, b) => a.time - b.time);
  renderTimeline();
});
recordFolder.addButton({ title: 'Save JPG' }).on('click', () => myp5.saveJPG());
recordFolder.addButton({ title: 'Save PNG' }).on('click', () => myp5.savePNG());
recordFolder.addButton({ title: 'Save PNG (8×)' }).on('click', () => myp5.saveHighResPNG(8));

const audioFolder = pane.addFolder({ title: 'Audio React', expanded: false });
audioFolder.addInput(audioConfig, 'densityStrength', { min: 0, max: 1, step: 0.01, label: 'Density' });
audioFolder.addInput(audioConfig, 'speedStrength', { min: 0, max: 50, step: 1, label: 'Speed' });

// ---- Live-only ----
const liveFolder = pane.addFolder({ title: 'Camera Interaction' });
liveFolder.addInput(liveConfig, 'mode',     { options: { 'Squares follow the body': 'attract', 'Squares avoid the body': 'repel', 'Squares cling to the skeleton': 'magnetic' }, label: 'Mode' });
liveFolder.addInput(liveConfig, 'strength', { min: 0, max: 1, step: 0.01, label: 'Strength' });
liveFolder.addInput(liveConfig, 'sweep',    { min: 0, max: 1, step: 0.01, label: 'Movement' });
liveFolder.addInput(liveConfig, 'reaction', { min: 0, max: 1, step: 0.01, label: 'Energy' });
liveFolder.addInput(liveConfig, 'videoAsImage', { label: 'Camera as Image' });
liveFolder.addInput(liveConfig, 'gradientMap', { label: 'Gradient Map' });
liveFolder.addInput(liveConfig, 'keyOut', { label: 'Key Out BG' });
liveFolder.addInput(liveConfig, 'dither', { min: 0, max: 1, step: 0.01, label: 'Edge Dither' });
liveFolder.addInput(liveConfig, 'showSkeleton', { label: 'Show Tracking' });
const cameraSetup = liveFolder.addFolder({ title: 'Camera Setup', expanded: false });
cameraSetup.addInput(liveConfig, 'mirror', { label: 'Mirror' });
cameraSetup.addInput(liveConfig, 'rotate', { options: { 'Normal': 0, 'Rotated 90°': 90, 'Rotated 270°': 270 }, label: 'Orientation' });
liveFolder.addInput(liveRecord, 'seconds', { min: 1, max: 300, step: 1, label: 'Clip Length s' });
liveRecBtn = liveFolder.addButton({ title: '⏺ Record Clip' });
liveRecBtn.on('click', () => { if (isRecording) stopLiveRecording(); else startLiveRecording(); });
liveFolder.addButton({ title: '⛶ Open Display Window' }).on('click', () => openDisplayWindow());

// ---- Shared ----
const projectFolder = pane.addFolder({ title: 'Project' });
projectFolder.addButton({ title: '💾 Save Project' }).on('click', () => saveProject());
projectFolder.addButton({ title: '📂 Open Project' }).on('click', () => {
  document.getElementById('upload-project')!.click();
});

// ---------------------------------------------------------------------------
// Mode tabs
// ---------------------------------------------------------------------------

const cameraStatusEl = document.getElementById('camera-status')!;

function setAppMode(mode: AppMode): void {
  if (mode === appMode) return;
  appMode = mode;
  const live = mode === 'live';
  document.body.classList.toggle('mode-live', live);
  document.querySelectorAll<HTMLButtonElement>('#mode-tabs button')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  recordFolder.hidden = live;
  audioFolder.hidden = live;
  liveFolder.hidden = !live;
  if (live) {
    tlPlaying = false;
    if (isRecording) stopRecording();
    startCamera();
  } else {
    if (isRecording) stopLiveRecording();
    stopCamera();
    if (isFullscreen) exitFullscreen();
  }
  updateCanvasScale();
}

// The Doc tab is a reading view, not a render mode: it leaves appMode alone and just
// parks the draw loop so a hidden canvas isn't burning frames.
type View = AppMode | 'doc';

function setView(view: View): void {
  document.body.classList.toggle('mode-doc', view === 'doc');
  if (view === 'doc') {
    myp5.noLoop();
  } else {
    myp5.loop();
    setAppMode(view);
  }
  document.querySelectorAll<HTMLButtonElement>('#mode-tabs button')
    .forEach((b) => b.classList.toggle('active', b.dataset.mode === view));
  updateCanvasScale();
}

document.querySelectorAll<HTMLButtonElement>('#mode-tabs button').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.mode as View));
});
liveFolder.hidden = true;

// ---------------------------------------------------------------------------
// Typo box list
// ---------------------------------------------------------------------------

function createTypoBox(): TypoBox {
  const id = nextTypoId++;
  return {
    id, name: `Box ${id}`, img: null, imgDataURL: null,
    scale: 20, x: 0.5, y: id === 1 ? 0.45 : 0.54,
    z: TYPO_Z_LAYER_COUNT,
    visStart: 0, visEnd: tlDuration,
    posKfs: [],
  };
}

function removeTypoBox(id: number) {
  typoBoxes = typoBoxes.filter((b) => b.id !== id);
  renderTypoList();
  renderTimeline();
}

function renderTypoList() {
  const list = document.getElementById('typo-list')!;
  list.innerHTML = '';

  typoBoxes.forEach((box, idx) => {
    const color = BOX_COLORS[idx % BOX_COLORS.length];
    const item = document.createElement('div');
    item.className = 'typo-item';
    item.dataset.id = String(box.id);

    item.innerHTML = `
      <div class="typo-item-header">
        <span class="typo-badge" style="background:${color}">${idx + 1}</span>
        <input class="typo-name-input" type="text" value="${box.name}" placeholder="Name">
        <button class="typo-remove-btn" title="Remove">×</button>
      </div>
      <div class="typo-item-controls">
        <label class="typo-label">Scale <input class="typo-scale" type="range" min="5" max="60" step="1" value="${box.scale}"> <span class="typo-scale-val">${box.scale}%</span></label>
        <label class="typo-label">Z layer <input class="typo-z" type="range" min="0" max="${TYPO_Z_LAYER_COUNT}" step="1" value="${box.z}"> <span class="typo-z-val">${box.z}</span></label>
        <label class="typo-label">X <input class="typo-x" type="range" min="0" max="1" step="0.01" value="${box.x.toFixed(2)}"> <span class="typo-x-val">${box.x.toFixed(2)}</span></label>
        <label class="typo-label">Y <input class="typo-y" type="range" min="0" max="1" step="0.01" value="${box.y.toFixed(2)}"> <span class="typo-y-val">${box.y.toFixed(2)}</span></label>
        <div class="typo-upload-row">
          <button class="typo-upload-btn">${box.img ? '✓ SVG Loaded' : 'Upload SVG'}</button>
          <input class="typo-file-input" type="file" accept=".svg,image/svg+xml" style="display:none">
        </div>
        <button class="typo-addposkey-btn record-only" title="Record position keyframe at current time">◆ Add Pos Key at ${tlTime.toFixed(2)}s</button>
        <button class="typo-clrpos-btn record-only" title="Remove all position keyframes">✕ Pos Keys (${box.posKfs.length})</button>
      </div>
    `;

    item.querySelector<HTMLInputElement>('.typo-name-input')!.addEventListener('input', (e) => {
      box.name = (e.target as HTMLInputElement).value;
      renderTimeline();
    });

    const scaleInput = item.querySelector<HTMLInputElement>('.typo-scale')!;
    const scaleVal = item.querySelector<HTMLSpanElement>('.typo-scale-val')!;
    scaleInput.addEventListener('input', () => {
      box.scale = Number(scaleInput.value);
      scaleVal.textContent = `${box.scale}%`;
    });

    const zInput = item.querySelector<HTMLInputElement>('.typo-z')!;
    const zVal = item.querySelector<HTMLSpanElement>('.typo-z-val')!;
    zInput.addEventListener('input', () => {
      box.z = Number(zInput.value);
      zVal.textContent = String(box.z);
    });

    const xInput = item.querySelector<HTMLInputElement>('.typo-x')!;
    const xVal = item.querySelector<HTMLSpanElement>('.typo-x-val')!;
    xInput.addEventListener('input', () => {
      box.x = Number(xInput.value);
      xVal.textContent = box.x.toFixed(2);
    });

    const yInput = item.querySelector<HTMLInputElement>('.typo-y')!;
    const yVal = item.querySelector<HTMLSpanElement>('.typo-y-val')!;
    yInput.addEventListener('input', () => {
      box.y = Number(yInput.value);
      yVal.textContent = box.y.toFixed(2);
    });

    const uploadBtn = item.querySelector<HTMLButtonElement>('.typo-upload-btn')!;
    const fileInput = item.querySelector<HTMLInputElement>('.typo-file-input')!;
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      myp5.rasterizeTypoBox(file, (img, dataURL) => {
        box.img = img;
        box.imgDataURL = dataURL;
        uploadBtn.textContent = '✓ SVG Loaded';
      });
    });

    item.querySelector<HTMLButtonElement>('.typo-addposkey-btn')!.addEventListener('click', () => {
      const eps = 0.05;
      const existingIdx = box.posKfs.findIndex((k) => Math.abs(k.time - tlTime) < eps);
      if (existingIdx >= 0) {
        box.posKfs[existingIdx].x = box.x;
        box.posKfs[existingIdx].y = box.y;
      } else {
        box.posKfs.push({ time: tlTime, x: box.x, y: box.y });
        box.posKfs.sort((a, b) => a.time - b.time);
      }
      renderTypoList();
      renderTimeline();
    });

    item.querySelector<HTMLButtonElement>('.typo-clrpos-btn')!.addEventListener('click', () => {
      box.posKfs = [];
      selectedKf = null;
      renderTypoList();
      renderTimeline();
    });

    item.querySelector<HTMLButtonElement>('.typo-remove-btn')!.addEventListener('click', () => removeTypoBox(box.id));

    list.appendChild(item);
  });

  const addBtn = document.createElement('button');
  addBtn.className = 'typo-add-btn';
  addBtn.textContent = '+ Add Typo Box';
  addBtn.addEventListener('click', () => {
    typoBoxes.push(createTypoBox());
    renderTypoList();
    renderTimeline();
  });
  list.appendChild(addBtn);
}

renderTypoList();

// ---------------------------------------------------------------------------
// Video export
// ---------------------------------------------------------------------------

function downloadRecording(mimeType: string): void {
  const blob = new Blob(recordedChunks, { type: mimeType.split(';')[0] });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hybrid-export-${Date.now()}.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  recordedChunks = [];
  isRecording = false;
  updateRecordBtn();
  updateLiveRecBtn();
}

const REC_MIME = () => ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  .find((m) => MediaRecorder.isTypeSupported(m)) ?? 'video/webm';


function updateLiveRecBtn(): void {
  if (!liveRecBtn) return;
  if (isRecording && liveRecEndsAt) {
    const left = Math.max(0, Math.ceil((liveRecEndsAt - performance.now()) / 1000));
    liveRecBtn.title = `⏹ Recording… ${left}s  (click to stop)`;
  } else {
    liveRecBtn.title = '⏺ Record Clip';
  }
}

function startLiveRecording(): void {
  if (isRecording) return;
  const canvasEl = canvasHolder.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvasEl) return;
  const mimeType = REC_MIME();
  recordedChunks = [];
  mediaRecorder = new MediaRecorder(canvasEl.captureStream(60), {
    mimeType, videoBitsPerSecond: 12_000_000,
  });
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => { downloadRecording(mimeType); };
  mediaRecorder.start(100);
  isRecording = true;
  liveRecEndsAt = performance.now() + liveRecord.seconds * 1000;
  liveRecTimeout = window.setTimeout(stopLiveRecording, liveRecord.seconds * 1000);
  liveRecTicker = window.setInterval(updateLiveRecBtn, 250);
  updateLiveRecBtn();
}

function stopLiveRecording(): void {
  clearTimeout(liveRecTimeout); liveRecTimeout = 0;
  clearInterval(liveRecTicker); liveRecTicker = 0;
  liveRecEndsAt = 0;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  else { isRecording = false; updateLiveRecBtn(); }
}

function startRecording() {
  const canvasEl = canvasHolder.querySelector('canvas') as HTMLCanvasElement | null;
  if (!canvasEl) return;
  if (isRecording) return;

  // Reset to start
  tlPlaying = false;
  tlTime = 0; animT = 0;
  if (audioElement) { audioElement.pause(); audioElement.currentTime = audioTrimStart; }

  // Pick best supported codec — VP9 first, VP8 fallback, then generic WebM
  const mimeType = REC_MIME();

  const stream = canvasEl.captureStream(60);

  // Capture audio track from the <audio> element when loaded
  if (audioElement) {
    try {
      // captureStream() exists on HTMLMediaElement in Chrome but is not in the TS lib
      const audioStream = (audioElement as HTMLMediaElement & { captureStream(): MediaStream }).captureStream();
      audioStream.getAudioTracks().forEach((t) => stream.addTrack(t));
    } catch (_) { /* not supported — video-only export */ }
  }

  recordedChunks = [];
  mediaRecorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 12_000_000,  // 12 Mbps — high quality for AME input
  });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => { downloadRecording(mimeType); };

  mediaRecorder.start(100);  // flush chunks every 100 ms
  isRecording = true;
  tlPlaying = true;
  updateRecordBtn();
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return;
  mediaRecorder.stop();
  tlPlaying = false;
  isRecording = false;
  if (audioElement) audioElement.pause();
  updateRecordBtn();
}

function updateRecordBtn() {
  const btn = document.getElementById('tl-record') as HTMLButtonElement | null;
  const status = document.getElementById('tl-rec-status') as HTMLSpanElement | null;
  if (!btn || !status) return;
  if (isRecording) {
    btn.textContent = '⏹ Stop & Save';
    btn.style.borderColor = '#ff4444';
    btn.style.color = '#ff4444';
    status.textContent = `● REC`;
  } else {
    btn.textContent = '⏺ Record';
    btn.style.borderColor = '';
    btn.style.color = '';
    status.textContent = '';
  }
}

// ---------------------------------------------------------------------------
// Camera / Live Mode
// ---------------------------------------------------------------------------

// Skeleton bones used for rasterising the body and for the debug overlay (MediaPipe indices).
const BONES: Array<[number, number]> = [
  [11, 12], [11, 23], [12, 24], [23, 24],   // torso
  [11, 13], [13, 15], [12, 14], [14, 16],   // arms
  [23, 25], [25, 27], [24, 26], [26, 28],   // legs
  [0, 11], [0, 12],                         // neck-ish
];

// Draw the camera frame into the analysis canvas with mirror / rotation / cover-crop so the
// person keeps their proportions instead of being stretched from 16:9 into 9:16.
function drawCameraInto(ctx: CanvasRenderingContext2D, W: number, H: number, filter?: string): void {
  const vw = cameraVideo!.videoWidth || 1280;
  const vh = cameraVideo!.videoHeight || 720;
  const rot = liveConfig.rotate;
  const rotated = rot === 90 || rot === 270;
  const dw = rotated ? H : W;
  const dh = rotated ? W : H;

  const targetAspect = dw / dh;
  const srcAspect = vw / vh;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (srcAspect > targetAspect) { sw = vh * targetAspect; sx = (vw - sw) / 2; }
  else { sh = vw / targetAspect; sy = (vh - sh) / 2; }

  ctx.save();
  if (filter) ctx.filter = filter;   // ignored by browsers without SVG canvas filters
  ctx.translate(W / 2, H / 2);
  if (liveConfig.mirror) ctx.scale(-1, 1);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(cameraVideo!, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}

function drawCameraToAnalysis(): void {
  drawCameraInto(cameraAnalysisCtx!, cameraAnalysisCanvas!.width, cameraAnalysisCanvas!.height);
}

async function loadPoseModel(): Promise<void> {
  if (poseLandmarker) return;
  if (!poseLoadPromise) {
    poseLoadPromise = (async () => {
      const vision = await FilesetResolver.forVisionTasks('/mediapipe/wasm');
      poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: '/models/pose_landmarker_lite.task', delegate: 'GPU' },
        runningMode: 'VIDEO',
        numPoses: 3,
        outputSegmentationMasks: true,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
      });
      segEnabled = true;
    })();
  }
  return poseLoadPromise;
}

// The segmentation head costs inference time, so turn it off when the toggle is off.
function syncSegmentationOption(): void {
  if (!poseLandmarker || segPending || liveConfig.keyOut === segEnabled) return;
  segPending = true;
  const want = liveConfig.keyOut;
  poseLandmarker.setOptions({ outputSegmentationMasks: want })
    .then(() => { segEnabled = want; if (!want) maskReady = false; })
    .catch(() => { /* keep current setting */ })
    .finally(() => { segPending = false; });
}

// Separable box blur, in place on src. Used to widen the mask's edge so there is a band
// for the dither to scatter across — the raw mask ramps over only a couple of pixels.
function boxBlur(src: Uint8Array, tmp: Uint8Array, w: number, h: number, r: number): void {
  const span = 2 * r + 1;
  const cx = (x: number) => (x < 0 ? 0 : x > w - 1 ? w - 1 : x);
  const cy = (y: number) => (y < 0 ? 0 : y > h - 1 ? h - 1 : y);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[row + cx(x)];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = (sum / span) | 0;
      sum -= src[row + cx(x - r)];
      sum += src[row + cx(x + r + 1)];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[cy(y) * w + x];
    for (let y = 0; y < h; y++) {
      src[y * w + x] = (sum / span) | 0;
      sum -= tmp[cy(y - r) * w + x];
      sum += tmp[cy(y + r + 1) * w + x];
    }
  }
}

// Collapse the per-person masks into one alpha channel we can composite with.
function buildMask(masks: Array<{ width: number; height: number; getAsUint8Array(): Uint8Array }>): void {
  const w = masks[0].width, h = masks[0].height;
  const n = w * h;
  if (!maskCanvas || maskCanvas.width !== w || maskCanvas.height !== h) {
    maskCanvas = document.createElement('canvas');
    maskCanvas.width = w; maskCanvas.height = h;
    maskCtx = maskCanvas.getContext('2d')!;
    maskImage = maskCtx.createImageData(w, h);
    const d = maskImage.data;
    for (let i = 0; i < n; i++) { d[i * 4] = 255; d[i * 4 + 1] = 255; d[i * 4 + 2] = 255; }
    maskWork = new Uint8Array(n);
    maskTmp = new Uint8Array(n);
    // Fixed thresholds: the grain sits still in the frame while the body moves through it,
    // instead of re-randomising every frame and crawling.
    ditherNoise = new Uint8Array(n);
    for (let i = 0; i < n; i++) ditherNoise[i] = (Math.random() * 256) | 0;
  }
  const d = maskImage!.data;
  const work = maskWork!;

  work.set(masks[0].getAsUint8Array().subarray(0, n));
  for (let k = 1; k < masks.length; k++) {
    const a = masks[k].getAsUint8Array();
    for (let i = 0; i < n; i++) if (a[i] > work[i]) work[i] = a[i];
  }

  const amt = liveConfig.dither;
  if (amt <= 0.001) {
    for (let i = 0; i < n; i++) d[i * 4 + 3] = work[i];
  } else {
    boxBlur(work, maskTmp!, w, h, 1 + Math.round(amt * 4));
    const noise = ditherNoise!;
    // Fully-inside pixels always pass, fully-outside never do; the widened edge scatters
    // in proportion to its coverage.
    for (let i = 0; i < n; i++) d[i * 4 + 3] = work[i] > noise[i] ? 255 : 0;
  }
  maskCtx!.putImageData(maskImage!, 0, 0);
}

// One pose frame: run the landmarker on the analysis canvas, match people to last frame for
// velocity, then rebuild the presence field.
function poseFrame(): void {
  poseFrameId = requestAnimationFrame(poseFrame);
  if (!poseLandmarker || !cameraVideo || cameraVideo.readyState < 2 || !cameraAnalysisCanvas) return;
  const now = performance.now();
  if (now - lastPoseTs < 33) return;   // cap ~30 fps (matches typical camera rate)
  lastPoseTs = now;

  syncSegmentationOption();
  drawCameraToAnalysis();
  const result = poseLandmarker.detectForVideo(cameraAnalysisCanvas, now);

  const segMasks = result.segmentationMasks;
  if (segMasks && segMasks.length > 0) {
    if (liveConfig.keyOut) { buildMask(segMasks); maskReady = true; }
    for (const mk of segMasks) mk.close();
  } else if (!segEnabled) {
    maskReady = false;
  }

  const next: TrackedPose[] = [];
  const centre = (pts: Float32Array, vis: Float32Array) => {
    let x = 0, y = 0, n = 0;
    for (let i = 0; i < 33; i++) if (vis[i] > 0.5) { x += pts[i * 2]; y += pts[i * 2 + 1]; n++; }
    return n ? { x: x / n, y: y / n } : { x: pts[0], y: pts[1] };
  };
  for (const lm of result.landmarks) {
    const pts = new Float32Array(66);
    const rawVis = new Float32Array(33);
    for (let i = 0; i < 33; i++) {
      pts[i * 2] = lm[i].x * canvasW;
      pts[i * 2 + 1] = lm[i].y * canvasH;
      rawVis[i] = lm[i].visibility ?? 1;
    }
    // Match to a previous person by centre of the visible landmarks (hips may be off-screen)
    const c = centre(pts, rawVis);
    let best: TrackedPose | null = null, bestD = 0.35 * canvasH;
    for (const prev of poses) {
      const pc = centre(prev.pts, prev.vis);
      const d = Math.hypot(c.x - pc.x, c.y - pc.y);
      if (d < bestD) { bestD = d; best = prev; }
    }
    const vel = new Float32Array(66);
    const vis = new Float32Array(33);
    const act = new Float32Array(33);
    const dxf = new Float32Array(66);
    let scale = 0;
    if (best) {
      const dt = Math.max(0.008, (now - best.t) / 1000);
      const rate = 1 / dt;
      const aD = euroAlpha(rate, EURO_D_CUTOFF);
      const ref = best.scale || bodyScale(best.pts, best.act);
      for (let i = 0; i < 33; i++) {
        // One Euro on each coordinate, with the speed term in body-widths/sec
        const ix = i * 2, iy = ix + 1;
        const px = best.pts[ix], py = best.pts[iy];
        dxf[ix] = best.dxf[ix] + aD * ((pts[ix] - px) * rate - best.dxf[ix]);
        dxf[iy] = best.dxf[iy] + aD * ((pts[iy] - py) * rate - best.dxf[iy]);
        const speedNorm = Math.hypot(dxf[ix], dxf[iy]) / ref;
        const a = euroAlpha(rate, EURO_MIN_CUTOFF + EURO_BETA * speedNorm);
        pts[ix] = px + (pts[ix] - px) * a;
        pts[iy] = py + (pts[iy] - py) * a;
        // Visibility smoothing + hysteresis → activation ramps over ~200ms instead of popping
        vis[i] = 0.3 * rawVis[i] + 0.7 * best.vis[i];
        const wasOn = best.act[i] > 0.5;
        const target = vis[i] > ACT_ON ? 1 : vis[i] < ACT_OFF ? 0 : (wasOn ? 1 : 0);
        act[i] = best.act[i] + (target - best.act[i]) * 0.18;
      }
      for (let i = 0; i < 66; i++) vel[i] = 0.25 * ((pts[i] - best.pts[i]) / dt) + 0.75 * best.vel[i];
      scale = 0.9 * ref + 0.1 * bodyScale(pts, act);
      poses.splice(poses.indexOf(best), 1);
    } else {
      vis.set(rawVis);
      for (let i = 0; i < 33; i++) act[i] = rawVis[i] > ACT_ON ? 0.3 : 0; // fade in from 0.3
      scale = bodyScale(pts, act);
    }
    next.push({ pts, vel, vis, act, dxf, scale, t: now });
  }
  // People not detected this frame coast for a moment instead of vanishing (and re-appearing)
  for (const lost of poses) {
    if (now - lost.t < POSE_COAST_MS) {
      for (let i = 0; i < 66; i++) lost.vel[i] *= 0.8;
      next.push(lost);
    }
  }
  poses = next;
  if (poses.length > 0) buildMagShapes();

  // Global signals: presence + how fast the extremities move
  let speedSum = 0, n = 0, cxSum = 0;
  for (const pose of poses) {
    for (const i of [0, 15, 16, 27, 28]) {
      if (pose.act[i] < 0.5) continue;
      speedSum += Math.hypot(pose.vel[i * 2], pose.vel[i * 2 + 1]); n++;
    }
    cxSum += (pose.pts[22] + pose.pts[24] + pose.pts[46] + pose.pts[48]) / 4;
  }
  const rawEnergy = poses.length === 0 ? 0 : Math.min(1, 0.35 + (n ? speedSum / n : 0) / 1200);
  const rawBias = poses.length === 0 ? 0 : ((cxSum / poses.length) / canvasW - 0.5) * 2;
  motionEnergy += (rawEnergy - motionEnergy) * 0.15;
  motionBias   += (rawBias   - motionBias)   * 0.15;

  updatePresenceField();
}

// Rasterise the skeleton into the field grid as capsules, smooth, then compute per-cell
// displacement + scale (nearest-cell search) plus a velocity sweep from the nearest limb.
function updatePresenceField(): void {
  const fw = Math.ceil(canvasW / FIELD_PX);
  const fh = Math.ceil(canvasH / FIELD_PX);
  if (fw !== fieldW || fh !== fieldH || !fieldOcc) {
    fieldW = fw; fieldH = fh;
    fieldOcc   = new Float32Array(fw * fh);
    fieldVelX  = new Float32Array(fw * fh);
    fieldVelY  = new Float32Array(fw * fh);
    fieldDispX = new Float32Array(fw * fh);
    fieldDispY = new Float32Array(fw * fh);
    fieldScale = new Float32Array(fw * fh).fill(1);
    fieldGain = 0;
  }
  const occ = fieldOcc!, velX = fieldVelX!, velY = fieldVelY!;
  const dispX = fieldDispX!, dispY = fieldDispY!, scl = fieldScale!;
  const cfg = FI;

  // 1. Capsules from every tracked pose. radius relative to shoulder width.
  type Capsule = { ax: number; ay: number; bx: number; by: number; r: number; vx: number; vy: number; w: number };
  const caps: Capsule[] = [];
  for (const pose of poses) {
    const P = pose.pts, V = pose.vel, act = pose.act;
    const sw = Math.max(40, Math.hypot(P[22] - P[24], P[23] - P[25]));
    const add = (a: number, b: number, rf: number) => {
      const w = Math.min(act[a], act[b]);
      if (w < 0.02) return;
      caps.push({
        ax: P[a * 2], ay: P[a * 2 + 1], bx: P[b * 2], by: P[b * 2 + 1], r: sw * rf, w,
        vx: (V[a * 2] + V[b * 2]) / 2, vy: (V[a * 2 + 1] + V[b * 2 + 1]) / 2,
      });
    };
    const hd = headDisc(P, act, sw);
    if (hd) caps.push({ ax: hd.cx, ay: hd.cy, bx: hd.cx, by: hd.cy, r: hd.r, w: hd.w, vx: V[0], vy: V[1] });
    add(11, 12, 0.35); add(23, 24, 0.4);               // shoulders, hips
    add(11, 23, 0.45); add(12, 24, 0.45);              // torso sides
    const wT = Math.min(act[11], act[12], act[23], act[24]);
    if (wT > 0.02) {
      caps.push({                                      // torso centre
        ax: (P[22] + P[24]) / 2, ay: (P[23] + P[25]) / 2, bx: (P[46] + P[48]) / 2, by: (P[47] + P[49]) / 2, r: sw * 0.6, w: wT,
        vx: (V[22] + V[24] + V[46] + V[48]) / 4, vy: (V[23] + V[25] + V[47] + V[49]) / 4,
      });
    }
    add(11, 13, 0.22); add(13, 15, 0.2); add(12, 14, 0.22); add(14, 16, 0.2);   // arms
    add(15, 15, 0.32); add(16, 16, 0.32);                                        // hands (big — they interact)
    add(23, 25, 0.3); add(25, 27, 0.26); add(24, 26, 0.3); add(26, 28, 0.26);    // legs
    add(27, 27, 0.3); add(28, 28, 0.3);                                          // feet
  }

  // 2. Raw coverage + nearest-limb velocity per cell, then EMA
  const a = cfg.fieldSmooth;
  const margin = FIELD_PX;
  for (let cy = 0; cy < fh; cy++) {
    for (let cx = 0; cx < fw; cx++) {
      const i = cy * fw + cx;
      const px = (cx + 0.5) * FIELD_PX, py = (cy + 0.5) * FIELD_PX;
      let best = Infinity, bvx = 0, bvy = 0, raw = 0;
      for (const c of caps) {
        const dx = c.bx - c.ax, dy = c.by - c.ay;
        const len2 = dx * dx + dy * dy;
        let tt = len2 > 0 ? ((px - c.ax) * dx + (py - c.ay) * dy) / len2 : 0;
        tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
        const qx = c.ax + tt * dx - px, qy = c.ay + tt * dy - py;
        const d = Math.sqrt(qx * qx + qy * qy) - c.r;
        const cov = Math.max(0, Math.min(1, 1 - d / margin)) * c.w;   // fades with bone activation
        if (cov > raw) raw = cov;
        if (d < best) { best = d; bvx = c.vx; bvy = c.vy; }
      }
      occ[i] = a * raw + (1 - a) * occ[i];
      // velocity only matters near the body; fade with distance
      const nearV = caps.length === 0 ? 0 : Math.max(0, 1 - Math.max(0, best) / cfg.sweepRadius);
      velX[i] = a * bvx * nearV + (1 - a) * velX[i];
      velY[i] = a * bvy * nearV + (1 - a) * velY[i];
    }
  }

  // 3. Gain ramp
  const target = poses.length > 0 ? 1 : 0;
  fieldGain += (target - fieldGain) * 0.12;
  const n = fw * fh;
  if (!dtD || dtD.length !== n) {
    dtD = new Float32Array(n);
    dtNX = new Int16Array(n); dtNY = new Int16Array(n);
    dtNX2 = new Int16Array(n); dtNY2 = new Int16Array(n);
  }
  const isActive = new Uint8Array(n);
  const isInactive = new Uint8Array(n);
  let nActive = 0;
  for (let i = 0; i < n; i++) {
    if (occ[i] > 0.3) { isActive[i] = 1; nActive++; } else isInactive[i] = 1;
  }
  if (fieldGain < 0.001 || nActive === 0 || nActive === n) {
    dispX.fill(0); dispY.fill(0); scl.fill(1);
    return;
  }

  if (liveConfig.mode === 'magnetic') { dispX.fill(0); dispY.fill(0); scl.fill(1); return; }

  // 4. Nearest opposite-class cell via two distance transforms, then displacement + scale
  nearestSeedTransform(isInactive, fw, fh, dtNX!, dtNY!);    // for cells inside the body
  nearestSeedTransform(isActive,   fw, fh, dtNX2!, dtNY2!);  // for cells outside it
  const attract = liveConfig.mode === 'attract';
  const repelRadius = cfg.scaleRadius * 2;

  for (let cy = 0; cy < fh; cy++) {
    for (let cx = 0; cx < fw; cx++) {
      const i = cy * fw + cx;
      const inside = isActive[i] === 1;
      const bx = inside ? dtNX![i] : dtNX2![i];
      const by = inside ? dtNY![i] : dtNY2![i];
      const ddx = bx - cx, ddy = by - cy;
      const distCells = Math.sqrt(ddx * ddx + ddy * ddy);
      const distPx = distCells * FIELD_PX;
      let ux = 0, uy = 0;
      if (distCells > 0) { ux = (bx - cx) / distCells; uy = (by - cy) / distCells; }

      const near = inside ? 1 : Math.max(0, 1 - distPx / cfg.scaleRadius);
      let dx = 0, dy = 0;
      if (attract) {
        if (!inside) {
          const mag = Math.min(distPx * cfg.pull + cfg.overshoot * FIELD_PX, cfg.maxPull);
          dx = ux * mag; dy = uy * mag;
        }
      } else if (inside) {
        const mag = distPx + FIELD_PX;
        dx = ux * mag; dy = uy * mag;
      } else {
        const mag = Math.max(0, repelRadius - distPx) * cfg.pull;
        dx = -ux * mag; dy = -uy * mag;
      }
      dx += velX[i] * cfg.sweepSec;
      dy += velY[i] * cfg.sweepSec;

      const s = 1 + cfg.scaleNear * near - cfg.scaleFar * (1 - near);
      dispX[i] = dx * fieldGain;
      dispY[i] = dy * fieldGain;
      scl[i]   = 1 + (s - 1) * fieldGain;
    }
  }
}

// Head centre/radius from the ears (fallback: nose + shoulder width).
function headDisc(P: Float32Array, act: Float32Array, sw: number): { cx: number; cy: number; r: number; w: number } | null {
  const wEars = Math.min(act[7], act[8]);
  if (wEars > 0.02) {
    const cx = (P[14] + P[16]) / 2, cy = (P[15] + P[17]) / 2;
    const r = Math.max(sw * 0.3, Math.hypot(P[14] - P[16], P[15] - P[17]) * 0.62);
    return { cx, cy, r, w: wEars };
  }
  if (act[0] > 0.02) return { cx: P[0], cy: P[1], r: sw * 0.4, w: act[0] };
  return null;
}

function buildMagShapes(): void {
  const out: MagShape[] = [];
  for (const pose of poses) {
    const P = pose.pts, V = pose.vel, act = pose.act;
    const sw = Math.max(40, Math.hypot(P[22] - P[24], P[23] - P[25]));
    const vv = (i: number): [number, number] => [V[i * 2], V[i * 2 + 1]];

    const head = headDisc(P, act, sw);
    if (head) out.push({ kind: 'disc', ...head, v: act[7] > 0.02 ? [(V[14] + V[16]) / 2, (V[15] + V[17]) / 2] : vv(0) });

    const wTorso = Math.min(act[11], act[12], act[23], act[24]);
    if (wTorso > 0.02) {
      const idx = [11, 12, 24, 23];
      const qx = idx.map((i) => P[i * 2]), qy = idx.map((i) => P[i * 2 + 1]);
      const ex: number[] = [], ey: number[] = [], elen2: number[] = [];
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) & 3;
        ex.push(qx[k2] - qx[k]); ey.push(qy[k2] - qy[k]);
        elen2.push(ex[k] * ex[k] + ey[k] * ey[k]);
      }
      out.push({
        kind: 'quad', w: wTorso, x: qx, y: qy, ex, ey, elen2,
        cx: (P[22] + P[24] + P[46] + P[48]) / 4, cy: (P[23] + P[25] + P[47] + P[49]) / 4,
        v: idx.map(vv),
      });
    }
    for (const [a, b] of BONES) {
      if (a === 0 || b === 0) continue;                       // neck lines replaced by head disc
      const w = Math.min(act[a], act[b]);
      if (w < 0.02) continue;
      const ax = P[a * 2], ay = P[a * 2 + 1];
      const sdx = P[b * 2] - ax, sdy = P[b * 2 + 1] - ay;
      out.push({ kind: 'seg', w, ax, ay, bx: P[b * 2], by: P[b * 2 + 1],
        dx: sdx, dy: sdy, len2: sdx * sdx + sdy * sdy, va: vv(a), vb: vv(b) });
    }
  }
  magShapes = out;
}

// Scratch for snapToBody so it allocates nothing per element.
const snapD  = new Float32Array(64);
const snapTX = new Float32Array(64), snapTY = new Float32Array(64);
const snapVX = new Float32Array(64), snapVY = new Float32Array(64);

// Target on the body for a square at (px,py). Each shape yields a distance and a spread-out
// target (along the bone / across the disc or torso, using a stable per-element hash). The
// result is a soft blend of the closest shapes, so a square never hard-flips between two
// bones from one frame to the next.
const snapOut = { x: 0, y: 0, vx: 0, vy: 0 };   // reused — called ~700×/frame
function snapToBody(px: number, py: number, hx: number, hy: number): { x: number; y: number; vx: number; vy: number } {
  const hash = Math.sin(hx * 12.9898 + hy * 78.233) * 43758.5453;
  const u = hash - Math.floor(hash);            // 0..1 stable per element
  const n = Math.min(magShapes.length, 64);
  let dmin = Infinity;

  for (let i = 0; i < n; i++) {
    const sh = magShapes[i];
    let d = 0, tx = 0, ty = 0, vx = 0, vy = 0;
    if (sh.kind === 'seg') {
      const dx = sh.dx, dy = sh.dy;
      let t = sh.len2 > 0 ? ((px - sh.ax) * dx + (py - sh.ay) * dy) / sh.len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const rx = sh.ax + t * dx - px, ry = sh.ay + t * dy - py;
      d = Math.sqrt(rx * rx + ry * ry);
      t = Math.max(0, Math.min(1, t + (u - 0.5) * 0.6));
      tx = sh.ax + dx * t; ty = sh.ay + dy * t;
      vx = sh.va[0] + (sh.vb[0] - sh.va[0]) * t; vy = sh.va[1] + (sh.vb[1] - sh.va[1]) * t;
    } else if (sh.kind === 'disc') {
      const ox = px - sh.cx, oy = py - sh.cy;
      const dist = Math.sqrt(ox * ox + oy * oy);
      d = Math.max(0, dist - sh.r);
      const ang = dist > 1 ? Math.atan2(oy, ox) : u * 6.2832;
      const rr = dist < sh.r ? dist : sh.r * (0.15 + 0.85 * u);   // inside: stay; outside: fill the disc
      tx = sh.cx + Math.cos(ang) * rr; ty = sh.cy + Math.sin(ang) * rr;
      vx = sh.v[0]; vy = sh.v[1];
    } else {
      // Convex quad: inside → stay put; outside → nearest edge point, pulled inward to fill.
      let inside = true, sign = 0;
      let bestE = Infinity, ex = 0, ey = 0, evx = 0, evy = 0;
      for (let k = 0; k < 4; k++) {
        const k2 = (k + 1) & 3;
        const ax = sh.x[k], ay = sh.y[k];
        const dx = sh.ex[k], dy = sh.ey[k];
        const cr = dx * (py - ay) - dy * (px - ax);
        if (sign === 0) sign = cr < 0 ? -1 : 1; else if (cr * sign < 0) inside = false;
        let t = sh.elen2[k] > 0 ? ((px - ax) * dx + (py - ay) * dy) / sh.elen2[k] : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + t * dx, qy = ay + t * dy;
        const rdx = qx - px, rdy = qy - py;
        const dd = Math.sqrt(rdx * rdx + rdy * rdy);
        if (dd < bestE) {
          bestE = dd; ex = qx; ey = qy;
          evx = sh.v[k][0] + (sh.v[k2][0] - sh.v[k][0]) * t;
          evy = sh.v[k][1] + (sh.v[k2][1] - sh.v[k][1]) * t;
        }
      }
      if (inside) {
        d = 0; tx = px; ty = py;
        vx = (sh.v[0][0] + sh.v[1][0] + sh.v[2][0] + sh.v[3][0]) / 4;
        vy = (sh.v[0][1] + sh.v[1][1] + sh.v[2][1] + sh.v[3][1]) / 4;
      } else {
        d = bestE;
        const f = u * 0.85;
        tx = ex + (sh.cx - ex) * f; ty = ey + (sh.cy - ey) * f;
        vx = evx; vy = evy;
      }
    }
    snapD[i] = d; snapTX[i] = tx; snapTY[i] = ty; snapVX[i] = vx; snapVY[i] = vy;
    if (d < dmin) dmin = d;
  }

  const SIGMA = 45; // px — how wide the blend between neighbouring shapes is
  let wsum = 0, x = 0, y = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const e = (snapD[i] - dmin) / SIGMA;
    if (e > 4) continue;
    const w = Math.exp(-e) * magShapes[i].w;
    wsum += w; x += snapTX[i] * w; y += snapTY[i] * w; vx += snapVX[i] * w; vy += snapVY[i] * w;
  }
  if (wsum < 1e-6) { snapOut.x = px; snapOut.y = py; snapOut.vx = 0; snapOut.vy = 0; return snapOut; }
  snapOut.x = x / wsum; snapOut.y = y / wsum; snapOut.vx = vx / wsum; snapOut.vy = vy / wsum;
  return snapOut;
}

// Bilinear sample of the presence field at a canvas-pixel position.
function sampleField(px: number, py: number): { dx: number; dy: number; scale: number } {
  const dispX = fieldDispX!, dispY = fieldDispY!, scl = fieldScale!;
  const gx = Math.max(0, Math.min(fieldW - 1.001, px / FIELD_PX - 0.5));
  const gy = Math.max(0, Math.min(fieldH - 1.001, py / FIELD_PX - 0.5));
  const x0 = gx | 0, y0 = gy | 0;
  const fx = gx - x0, fy = gy - y0;
  const i00 = y0 * fieldW + x0, i10 = i00 + 1, i01 = i00 + fieldW, i11 = i01 + 1;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  return {
    dx:    dispX[i00] * w00 + dispX[i10] * w10 + dispX[i01] * w01 + dispX[i11] * w11,
    dy:    dispY[i00] * w00 + dispY[i10] * w10 + dispY[i01] * w01 + dispY[i11] * w11,
    scale: scl[i00]   * w00 + scl[i10]   * w10 + scl[i01]   * w01 + scl[i11]   * w11,
  };
}

async function startCamera(): Promise<void> {
  cameraStatusEl.textContent = 'Loading tracking model…';
  cameraStatusEl.style.color = '#888';
  try {
    await loadPoseModel();
  } catch (err) {
    cameraStatusEl.textContent = `Tracking model failed: ${(err as Error).message}`;
    cameraStatusEl.style.color = '#ff4444';
    return;
  }
  if (appMode !== 'live') return; // user switched back while loading

  cameraStatusEl.textContent = 'Starting camera…';
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
  } catch (_) {
    cameraStatusEl.textContent = 'Camera access denied or unavailable.';
    cameraStatusEl.style.color = '#ff4444';
    return;
  }
  if (appMode !== 'live') { stopCamera(); return; }

  if (!cameraVideo) {
    cameraVideo = document.createElement('video');
    cameraVideo.muted = true; cameraVideo.playsInline = true;
    cameraVideo.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px';
    document.body.appendChild(cameraVideo);
  }
  cameraVideo.srcObject = cameraStream;
  await cameraVideo.play();

  if (!cameraAnalysisCanvas) {
    cameraAnalysisCanvas = document.createElement('canvas');
    cameraAnalysisCtx = cameraAnalysisCanvas.getContext('2d')!;
  }
  // Same aspect as the poster canvas; ~1/4 res is plenty for the pose model.
  cameraAnalysisCanvas.width  = Math.round(canvasW / 4);
  cameraAnalysisCanvas.height = Math.round(canvasH / 4);

  poses = []; fieldOcc = null; fieldGain = 0; motionEnergy = 0; motionBias = 0; lastPoseTs = -1;
  cancelAnimationFrame(poseFrameId);
  poseFrameId = requestAnimationFrame(poseFrame);
  cameraStatusEl.textContent = '● Camera live';
  cameraStatusEl.style.color = '#00cc88';
}

function stopCamera(): void {
  cancelAnimationFrame(poseFrameId);
  poseFrameId = 0;
  if (cameraStream) { cameraStream.getTracks().forEach((t) => t.stop()); cameraStream = null; }
  if (cameraVideo) cameraVideo.srcObject = null;
  poses = []; fieldGain = 0; motionEnergy = 0; motionBias = 0; magShapes = []; maskReady = false;
  cameraStatusEl.textContent = 'Camera off';
  cameraStatusEl.style.color = '#555';
}

// Public screens get their own tab on a unique URL. The control tab broadcasts its settings
// so edits here show up there live.
const DISPLAY_KEY = 'hybrid-display-state';
const displayId = new URLSearchParams(location.search).get('display');
const isDisplay = !!displayId;
const displayChannel = new BroadcastChannel('hybrid-display');

function openDisplayWindow(): void {
  const id = Math.random().toString(36).slice(2, 8);
  pushDisplayState();
  window.open(`${location.pathname}?display=${id}`, '_blank');
}

function pushDisplayState(): void {
  const snap = JSON.stringify({ params, liveConfig, seed: myp5.getSeed() });
  try { localStorage.setItem(DISPLAY_KEY, snap); } catch (_) { /* private mode */ }
  displayChannel.postMessage(snap);
}

function applyDisplayState(json: string): void {
  try {
    const st = JSON.parse(json) as { params: Params; liveConfig: typeof liveConfig; seed: number };
    Object.assign(params, st.params);
    Object.assign(liveConfig, st.liveConfig);
    if (typeof st.seed === 'number' && st.seed !== myp5.getSeed()) myp5.setSeed(st.seed);
  } catch (_) { /* malformed — ignore */ }
}

function exitFullscreen(): void {
  isFullscreen = false;
  document.body.classList.remove('fullscreen');
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  updateCanvasScale();
}

// Browser handles Esc natively in fullscreen — mirror that back into our state.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && isFullscreen && !isDisplay) exitFullscreen();
});

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

const TL_HEADER_H = 36;
const TL_TRACK_H = 28;
const TL_LEFT = 90;
const EDGE_HIT = 7; // px within which edge drag activates

let tlCanvas: HTMLCanvasElement;
let tlCtx: CanvasRenderingContext2D;
let tlDrag: TlDragTarget = null;

function tlTotalH() { return TL_HEADER_H + TL_TRACK_H * 3 + TL_TRACK_H * typoBoxes.length; }
function tlTimeToX(t: number) { return TL_LEFT + (t / tlDuration) * (tlCanvas.width - TL_LEFT - 8); }
function tlXToTime(x: number) { return Math.max(0, Math.min(tlDuration, ((x - TL_LEFT) / (tlCanvas.width - TL_LEFT - 8)) * tlDuration)); }
function tlTrackY(i: number) { return TL_HEADER_H + i * TL_TRACK_H; }

function renderTimeline() {
  if (!tlCtx) return;
  const W = tlCanvas.width;
  const H = tlTotalH();
  tlCanvas.height = H;
  const ctx = tlCtx;

  ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#1a1a1a'; ctx.fillRect(0, TL_HEADER_H, TL_LEFT, H - TL_HEADER_H);

  // Track backgrounds + labels
  const trackLabels = ['Density', 'Base Speed', 'Audio', ...typoBoxes.map((b, i) => `${i + 1}: ${b.name || 'Box'}`)];
  trackLabels.forEach((label, i) => {
    const ty = tlTrackY(i);
    ctx.fillStyle = i % 2 === 0 ? '#161616' : '#1c1c1c';
    ctx.fillRect(TL_LEFT, ty, W - TL_LEFT, TL_TRACK_H);
    ctx.fillStyle = i === 2 ? (audioEnergyData ? '#00cc88' : '#444') : '#555';
    ctx.font = '10px ui-monospace,monospace';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(label, TL_LEFT - 4, ty + TL_TRACK_H / 2);
  });

  // Second grid
  ctx.strokeStyle = '#2a2a2a'; ctx.lineWidth = 1;
  for (let t = 0; t <= tlDuration; t++) {
    const x = tlTimeToX(t);
    ctx.beginPath(); ctx.moveTo(x, TL_HEADER_H); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = '#444'; ctx.font = '9px ui-monospace,monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillText(`${t}s`, x, 2);
  }

  // Audio bar (track 2)
  if (audioEnergyData && audioBassData) {
    const barDur = audioTrimEnd - audioTrimStart;
    const bx0 = tlTimeToX(audioBarStart);
    const bx1 = tlTimeToX(audioBarStart + barDur);
    const bty = tlTrackY(2);
    const bh = TL_TRACK_H;

    // Filled waveform envelope (energy)
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx0 + EDGE_HIT, bty + 2, Math.max(0, bx1 - bx0 - EDGE_HIT * 2), bh - 4);
    ctx.clip();
    ctx.fillStyle = '#00ff8820';
    ctx.fillRect(bx0 + EDGE_HIT, bty + 2, Math.max(0, bx1 - bx0 - EDGE_HIT * 2), bh - 4);
    const pxCount = Math.max(1, Math.floor(bx1 - bx0 - EDGE_HIT * 2));
    for (let px = 0; px < pxCount; px++) {
      const audioT = audioTrimStart + (px / pxCount) * barDur;
      const fi = Math.max(0, Math.min(audioEnergyData.length - 1, Math.floor(audioT * 60)));
      const ht = audioEnergyData[fi] * (bh - 6);
      ctx.fillStyle = `rgba(0,255,136,${0.5 + audioEnergyData[fi] * 0.4})`;
      ctx.fillRect(bx0 + EDGE_HIT + px, bty + bh - 3 - ht, 1, ht);
    }
    ctx.restore();

    // Highlight current audio time on the bar
    const audioNow = audioTrimStart + (tlTime - audioBarStart);
    if (audioNow >= audioTrimStart && audioNow <= audioTrimEnd) {
      const nowX = tlTimeToX(audioBarStart + (audioNow - audioTrimStart));
      ctx.strokeStyle = '#00ff88'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(nowX, bty + 2); ctx.lineTo(nowX, bty + bh - 2); ctx.stroke();
    }

    // Edges
    ctx.fillStyle = '#00cc88';
    ctx.fillRect(bx0, bty + 2, EDGE_HIT, bh - 4);
    ctx.fillRect(bx1 - EDGE_HIT, bty + 2, EDGE_HIT, bh - 4);
  }

  // Typo bars (tracks 3+)
  typoBoxes.forEach((box, i) => {
    const ty = tlTrackY(3 + i);
    const x0 = tlTimeToX(box.visStart);
    const x1 = tlTimeToX(box.visEnd);
    const color = BOX_COLORS[i % BOX_COLORS.length];
    // Body
    ctx.fillStyle = color + '88';
    ctx.fillRect(x0 + EDGE_HIT, ty + 4, Math.max(0, x1 - x0 - EDGE_HIT * 2), TL_TRACK_H - 8);
    // Edges (more opaque, clearly draggable)
    ctx.fillStyle = color;
    ctx.fillRect(x0, ty + 2, EDGE_HIT, TL_TRACK_H - 4);
    ctx.fillRect(x1 - EDGE_HIT, ty + 2, EDGE_HIT, TL_TRACK_H - 4);
    // Position keyframe diamonds inside the bar
    box.posKfs.forEach((kf, ki) => {
      const kx = tlTimeToX(kf.time);
      if (kx < x0 || kx > x1) return;
      const cy = ty + TL_TRACK_H / 2;
      const isSel = selectedKf?.kind === 'typo-pos' && selectedKf.boxId === box.id && selectedKf.idx === ki;
      ctx.fillStyle = isSel ? '#ffffff' : '#ffffffaa';
      ctx.beginPath();
      ctx.moveTo(kx, cy - 5); ctx.lineTo(kx + 4, cy); ctx.lineTo(kx, cy + 5); ctx.lineTo(kx - 4, cy);
      ctx.closePath(); ctx.fill();
      if (isSel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
    });
  });

  // Keyframe diamonds on density / speed tracks
  const drawKfs = (kfs: Keyframe[], trackIdx: number, color: string, selKind: 'density' | 'speed') => {
    const ty = tlTrackY(trackIdx) + TL_TRACK_H / 2;
    kfs.forEach((kf, ki) => {
      const x = tlTimeToX(kf.time);
      const isSel = selectedKf?.kind === selKind && selectedKf.idx === ki;
      ctx.fillStyle = isSel ? '#ffffff' : color;
      ctx.beginPath();
      ctx.moveTo(x, ty - 5); ctx.lineTo(x + 4, ty); ctx.lineTo(x, ty + 5); ctx.lineTo(x - 4, ty);
      ctx.closePath(); ctx.fill();
      if (isSel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.stroke(); }
    });
  };
  drawKfs(densityKfs, 0, '#00eaff', 'density');
  drawKfs(speedKfs, 1, '#ff5a00', 'speed');

  // Playhead
  const ph = tlTimeToX(tlTime);
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(ph, 0); ctx.lineTo(ph, H); ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(ph, TL_HEADER_H / 2, 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#888'; ctx.font = '10px ui-monospace,monospace';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(`${tlTime.toFixed(2)}s`, ph + 7, TL_HEADER_H / 2);
}

function initTimeline() {
  const container = document.getElementById('timeline')!;

  const controls = document.createElement('div');
  controls.id = 'tl-controls';
  controls.innerHTML = `
    <button id="tl-play">▶ Play</button>
    <button id="tl-pause">⏸ Pause</button>
    <button id="tl-stop">⏹ Stop</button>
    <span class="tl-label">Duration</span>
    <input id="tl-duration" type="number" min="1" max="120" step="1" value="${tlDuration}">
    <span class="tl-label">s</span>
    <button id="tl-clear-kf">✕ All Keys</button>
    <span class="tl-label" style="margin-left:8px;border-left:1px solid #2a2a2a;padding-left:8px;"></span>
    <button id="tl-record">⏺ Record</button>
    <span id="tl-rec-status" style="color:#ff4444;font-size:10px;font-family:ui-monospace,monospace;min-width:40px;"></span>
  `;
  container.appendChild(controls);

  tlCanvas = document.createElement('canvas');
  tlCanvas.id = 'tl-canvas';
  container.appendChild(tlCanvas);
  tlCtx = tlCanvas.getContext('2d')!;

  new ResizeObserver(() => {
    tlCanvas.width = container.clientWidth;
    renderTimeline();
  }).observe(container);

  document.getElementById('tl-play')!.addEventListener('click', () => { tlPlaying = true; });
  document.getElementById('tl-pause')!.addEventListener('click', () => { tlPlaying = false; });
  document.getElementById('tl-record')!.addEventListener('click', () => {
    isRecording ? stopRecording() : startRecording();
  });
  document.getElementById('tl-stop')!.addEventListener('click', () => {
    tlPlaying = false; tlTime = 0; animT = 0;
    if (audioElement) { audioElement.pause(); audioElement.currentTime = audioTrimStart; }
    renderTimeline();
  });
  document.getElementById('tl-clear-kf')!.addEventListener('click', () => {
    densityKfs = []; speedKfs = [];
    typoBoxes.forEach((b) => { b.posKfs = []; });
    renderTypoList(); renderTimeline();
  });

  const durInput = document.getElementById('tl-duration') as HTMLInputElement;
  durInput.addEventListener('change', () => {
    tlDuration = Math.max(1, Number(durInput.value));
    densityKfs = densityKfs.filter((k) => k.time <= tlDuration);
    speedKfs = speedKfs.filter((k) => k.time <= tlDuration);
    typoBoxes.forEach((b) => {
      b.visEnd = Math.min(b.visEnd, tlDuration);
      b.posKfs = b.posKfs.filter((k) => k.time <= tlDuration);
    });
    renderTimeline();
  });

  // ---- Timeline mouse ----

  tlCanvas.addEventListener('mousedown', (e) => {
    const rect = tlCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (tlCanvas.width / rect.width);
    const my = (e.clientY - rect.top) * (tlCanvas.height / rect.height);

    // Playhead knob
    const ph = tlTimeToX(tlTime);
    if (Math.abs(mx - ph) < 10 && my < TL_HEADER_H) {
      tlDrag = { kind: 'playhead' }; return;
    }

    // Keyframe diamonds
    const checkKfs = (kfs: Keyframe[], arr: Keyframe[], ti: number, selKind: 'density' | 'speed') => {
      const cy = tlTrackY(ti) + TL_TRACK_H / 2;
      for (let i = 0; i < kfs.length; i++) {
        if (Math.abs(mx - tlTimeToX(kfs[i].time)) < 8 && Math.abs(my - cy) < 8) {
          selectedKf = { kind: selKind, idx: i };
          if (e.shiftKey) { kfs.splice(i, 1); selectedKf = null; renderTimeline(); }
          else { tlDrag = { kind: 'kf', arr, idx: i }; }
          return true;
        }
      }
      return false;
    };
    if (checkKfs(densityKfs, densityKfs, 0, 'density')) return;
    if (checkKfs(speedKfs, speedKfs, 1, 'speed')) return;

    // Check typo pos-kf diamonds on their timeline bars
    for (const box of typoBoxes) {
      const bIdx = typoBoxes.indexOf(box);
      const ty = tlTrackY(3 + bIdx) + TL_TRACK_H / 2;
      if (Math.abs(my - ty) > 8) continue;
      for (let i = 0; i < box.posKfs.length; i++) {
        const kx = tlTimeToX(box.posKfs[i].time);
        if (Math.abs(mx - kx) < 8) {
          selectedKf = { kind: 'typo-pos', boxId: box.id, idx: i };
          if (e.shiftKey) { box.posKfs.splice(i, 1); selectedKf = null; renderTimeline(); }
          else { tlDrag = { kind: 'typo-pos-kf', box, idx: i }; }
          return;
        }
      }
    }

    // Click on empty space clears selection
    selectedKf = null;

    // Audio bar (track 2)
    if (audioEnergyData) {
      const barDur = audioTrimEnd - audioTrimStart;
      const aty = tlTrackY(2);
      if (my >= aty && my <= aty + TL_TRACK_H) {
        const bx0 = tlTimeToX(audioBarStart);
        const bx1 = tlTimeToX(audioBarStart + barDur);
        if (mx >= bx0 && mx <= bx0 + EDGE_HIT) {
          tlDrag = { kind: 'audio-start', initBarStart: audioBarStart, initTrimStart: audioTrimStart, initMt: tlXToTime(mx) }; return;
        }
        if (mx >= bx1 - EDGE_HIT && mx <= bx1) {
          tlDrag = { kind: 'audio-end', initTrimEnd: audioTrimEnd, initMt: tlXToTime(mx) }; return;
        }
        if (mx > bx0 + EDGE_HIT && mx < bx1 - EDGE_HIT) {
          tlDrag = { kind: 'audio-body', initBarStart: audioBarStart, initMt: tlXToTime(mx) }; return;
        }
      }
    }

    // Typo bars — edge first, then body
    for (let i = 0; i < typoBoxes.length; i++) {
      const box = typoBoxes[i];
      const ty = tlTrackY(3 + i);
      if (my < ty || my > ty + TL_TRACK_H) continue;
      const x0 = tlTimeToX(box.visStart);
      const x1 = tlTimeToX(box.visEnd);
      if (mx >= x0 && mx <= x0 + EDGE_HIT) {
        tlDrag = { kind: 'typo-start', id: box.id }; return;
      }
      if (mx >= x1 - EDGE_HIT && mx <= x1) {
        tlDrag = { kind: 'typo-end', id: box.id }; return;
      }
      if (mx > x0 + EDGE_HIT && mx < x1 - EDGE_HIT) {
        tlDrag = { kind: 'typo-body', id: box.id, initStart: box.visStart, initEnd: box.visEnd, initMt: tlXToTime(mx) }; return;
      }
    }

    // Scrub playhead
    if (my >= TL_HEADER_H) {
      tlTime = tlXToTime(mx); recomputeAnimT(tlTime);
      seekAudioToTlTime(tlTime);
      renderTimeline();
    }
  });

  tlCanvas.addEventListener('mousemove', (e) => {
    if (!tlDrag) return;
    const rect = tlCanvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (tlCanvas.width / rect.width);
    const t = tlXToTime(mx);

    if (tlDrag.kind === 'playhead') {
      tlTime = t; recomputeAnimT(tlTime); seekAudioToTlTime(tlTime);
    } else if (tlDrag.kind === 'kf') {
      tlDrag.arr[tlDrag.idx].time = t;
      tlDrag.arr.sort((a, b) => a.time - b.time);
    } else if (tlDrag.kind === 'typo-start') {
      const box = typoBoxes.find((b) => b.id === (tlDrag as { id: number }).id)!;
      box.visStart = Math.max(0, Math.min(t, box.visEnd - 0.1));
    } else if (tlDrag.kind === 'typo-end') {
      const box = typoBoxes.find((b) => b.id === (tlDrag as { id: number }).id)!;
      box.visEnd = Math.max(t, box.visStart + 0.1);
    } else if (tlDrag.kind === 'typo-body') {
      const drag = tlDrag;
      const box = typoBoxes.find((b) => b.id === drag.id)!;
      const dur = drag.initEnd - drag.initStart;
      const dt = t - drag.initMt;
      box.visStart = Math.max(0, Math.min(tlDuration - dur, drag.initStart + dt));
      box.visEnd = box.visStart + dur;
    } else if (tlDrag.kind === 'audio-start') {
      const drag = tlDrag;
      const delta = t - drag.initMt;
      const newBarStart = Math.max(0, drag.initBarStart + delta);
      const newTrimStart = Math.max(0, Math.min(audioTrimEnd - 0.05, drag.initTrimStart + delta));
      audioBarStart = newBarStart;
      audioTrimStart = newTrimStart;
    } else if (tlDrag.kind === 'audio-end') {
      const drag = tlDrag;
      const delta = t - drag.initMt;
      audioTrimEnd = Math.max(audioTrimStart + 0.05, Math.min(audioDuration, drag.initTrimEnd + delta));
    } else if (tlDrag.kind === 'audio-body') {
      const drag = tlDrag;
      const barDur = audioTrimEnd - audioTrimStart;
      const delta = t - drag.initMt;
      audioBarStart = Math.max(0, Math.min(tlDuration - barDur, drag.initBarStart + delta));
    }
    renderTimeline();
  });

  tlCanvas.addEventListener('mouseup', () => { tlDrag = null; });
  tlCanvas.addEventListener('mouseleave', () => { tlDrag = null; });
  tlCanvas.addEventListener('contextmenu', (e) => e.preventDefault());
}

initTimeline();

// Delete / Backspace removes the currently selected keyframe
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isFullscreen) { exitFullscreen(); return; }
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  // Don't steal from text inputs
  if (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement) return;
  if (!selectedKf) return;
  e.preventDefault();
  if (selectedKf.kind === 'density') {
    densityKfs.splice(selectedKf.idx, 1);
  } else if (selectedKf.kind === 'speed') {
    speedKfs.splice(selectedKf.idx, 1);
  } else if (selectedKf.kind === 'typo-pos') {
    const skf = selectedKf;
    const box = typoBoxes.find((b) => b.id === skf.boxId);
    if (box) box.posKfs.splice(skf.idx, 1);
  }
  selectedKf = null;
  renderTimeline();
});

// rAF keeps timeline rendering smooth during playback
(function tlRaf() { if (tlPlaying) renderTimeline(); requestAnimationFrame(tlRaf); })();

// ---------------------------------------------------------------------------
// Project Save / Load
// ---------------------------------------------------------------------------

interface ProjectFile {
  version: 1;
  params: Params;
  seed: number;
  tlDuration: number;
  densityKfs: Keyframe[];
  speedKfs: Keyframe[];
  imgADataURL?: string | null;   // legacy — the default image is always used now
  audioBase64: string | null;
  audioMimeType: string | null;
  audioDuration: number;
  audioBarStart: number;
  audioTrimStart: number;
  audioTrimEnd: number;
  liveConfig?: typeof liveConfig;
  typoBoxes: Array<{
    id: number; name: string; imgDataURL: string | null;
    scale: number; x: number; y: number; z: number;
    visStart: number; visEnd: number; posKfs: PosKeyframe[];
  }>;
}

function saveProject() {
  const proj: ProjectFile = {
    version: 1,
    params: { ...params },
    liveConfig: { ...liveConfig },
    seed: myp5.getSeed(),
    tlDuration,
    densityKfs: densityKfs.map((k) => ({ ...k })),
    speedKfs: speedKfs.map((k) => ({ ...k })),
    audioBase64: audioRawBase64,
    audioMimeType,
    audioDuration,
    audioBarStart,
    audioTrimStart,
    audioTrimEnd,
    typoBoxes: typoBoxes.map((b) => ({
      id: b.id, name: b.name, imgDataURL: b.imgDataURL,
      scale: b.scale, x: b.x, y: b.y, z: b.z,
      visStart: b.visStart, visEnd: b.visEnd,
      posKfs: b.posKfs.map((k) => ({ ...k })),
    })),
  };
  const blob = new Blob([JSON.stringify(proj)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `hybrid-${Date.now()}.hybridproject`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function loadProject(file: File) {
  const proj = JSON.parse(await file.text()) as ProjectFile;

  // Params + timeline meta
  Object.assign(params, proj.params);
  if (proj.liveConfig) Object.assign(liveConfig, proj.liveConfig);
  tlDuration = proj.tlDuration;
  densityKfs = proj.densityKfs;
  speedKfs = proj.speedKfs;
  audioBarStart = proj.audioBarStart ?? 0;
  audioTrimStart = proj.audioTrimStart ?? 0;
  audioTrimEnd = proj.audioTrimEnd ?? 0;
  audioDuration = proj.audioDuration ?? 0;
  selectedKf = null;

  // Audio
  if (proj.audioBase64 && proj.audioMimeType) {
    audioRawBase64 = proj.audioBase64;
    audioMimeType = proj.audioMimeType;
    const arrayBuf = base64ToArrayBuffer(proj.audioBase64);
    await loadAudioFromBuffer(arrayBuf, proj.audioMimeType);
    // Restore trim positions (loadAudioFromBuffer resets them)
    audioBarStart = proj.audioBarStart ?? 0;
    audioTrimStart = proj.audioTrimStart ?? 0;
    audioTrimEnd = proj.audioTrimEnd ?? proj.audioDuration ?? 0;
    const mins = Math.floor(audioDuration / 60);
    const secs = (audioDuration % 60).toFixed(1);
    const audioStatusEl = document.getElementById('audio-status') as HTMLDivElement | null;
    if (audioStatusEl) { audioStatusEl.textContent = `✓ Project audio  ${mins}m ${secs}s`; audioStatusEl.style.color = '#00cc88'; }
  }

  // Typo boxes
  nextTypoId = 1;
  typoBoxes = proj.typoBoxes.map((b) => {
    nextTypoId = Math.max(nextTypoId, b.id + 1);
    return {
      id: b.id, name: b.name, img: null, imgDataURL: b.imgDataURL ?? null,
      scale: b.scale, x: b.x, y: b.y, z: b.z,
      visStart: b.visStart, visEnd: b.visEnd, posKfs: b.posKfs ?? [],
    } as TypoBox;
  });

  // Load typo box images async
  for (const box of typoBoxes) {
    if (box.imgDataURL) {
      myp5.loadImageDataURL(box.imgDataURL, (img) => { box.img = img; });
    }
  }

  // Regenerate poster with saved seed and refresh UI
  myp5.generatePoster(proj.seed);
  pane.refresh();
  renderTypoList();
  renderTimeline();
}

// Wire image upload
// Load default image on startup — the generator always uses it when the camera is off
fetch('/default-image.png').then((r) => r.blob()).then((blob) => {
  const f = new File([blob], 'default-image.png', { type: 'image/png' });
  myp5.setUploadedImage(1, f);
}).catch(() => { /* image not present — that's fine */ });

// Wire project open
(document.getElementById('upload-project') as HTMLInputElement).addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  loadProject(file).catch((err) => alert(`Failed to load project: ${err.message}`));
  (e.target as HTMLInputElement).value = ''; // allow re-opening same file
});

// Poll format change (Tweakpane v3 doesn't return the binding from addInput)
let lastFormat: Format = 'poster';
setInterval(() => {
  if (params.format !== lastFormat) { lastFormat = params.format; myp5.setFormat(params.format); }
}, 100);

installGradientMapFilter();

if (isDisplay) {
  // Public screen: no UI, live mode, camera on, driven by the control tab.
  document.body.classList.add('display-mode');
  isFullscreen = true;
  const initial = localStorage.getItem(DISPLAY_KEY);
  if (initial) applyDisplayState(initial);
  displayChannel.onmessage = (e: MessageEvent<string>) => applyDisplayState(e.data);
  setAppMode('live');
  updateCanvasScale();
  // Browsers only allow fullscreen from a gesture — any click on the screen does it.
  document.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  });
} else {
  // Control tab: push settings to any open display windows when something changes.
  let lastSnap = '';
  setInterval(() => {
    const snap = JSON.stringify({ params, liveConfig, seed: myp5.getSeed() });
    if (snap !== lastSnap) { lastSnap = snap; pushDisplayState(); }
  }, 250);
}
