// Model-accuracy test page (/test): runs a YOLO11 ONNX model on video frames.
//
// MIRROR of apps/live/detector.js (Ado's area; the repo rules forbid importing it).
// Same preprocessing (640 letterbox, gray 114, RGB 0-1, CHW), same output decoding,
// same duplicate removal (overlap 0.45). Differences, on purpose:
//   - keeps every box down to RAW_MIN (0.05) so the page can re-score at any threshold
//     without re-running; removing duplicates first gives the same boxes per threshold
//   - optional "road crop": only the bottom part of the frame goes to the model
// If apps/live/detector.js changes how it prepares or reads frames, change this too.

const ORT_VERSION = '1.20.1'; // same as apps/live/config.js
const ORT_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
export const INPUT_SIZE = 640;
export const RAW_MIN = 0.05;
const OVERLAP_MAX = 0.45;

let ortPromise = null;
function loadRuntime() {
  if (window.ort) return Promise.resolve(window.ort);
  ortPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = ORT_CDN + ('gpu' in navigator ? 'ort.webgpu.min.js' : 'ort.wasm.min.js');
    s.onload = () => { window.ort.env.wasm.wasmPaths = ORT_CDN; resolve(window.ort); };
    s.onerror = () => reject(new Error('Could not load ONNX Runtime from the CDN.'));
    document.head.appendChild(s);
  });
  return ortPromise;
}

export class Detector {
  constructor(name) {
    this.name = name;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = INPUT_SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  /** bytes: Uint8Array of the .onnx file. Tries WebGPU, falls back to WASM. */
  async load(bytes) {
    this.ort = await loadRuntime();
    const tries = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
    let lastErr;
    for (const ep of tries) {
      try {
        this.session = await this.ort.InferenceSession.create(bytes, {
          executionProviders: [ep], graphOptimizationLevel: 'all',
        });
        const blank = new this.ort.Tensor('float32', new Float32Array(3 * INPUT_SIZE * INPUT_SIZE), [1, 3, INPUT_SIZE, INPUT_SIZE]);
        await this.session.run({ [this.session.inputNames[0]]: blank });
        this.backend = ep;
        return;
      } catch (err) { lastErr = err; }
    }
    throw new Error(`Model would not start: ${lastErr?.message || lastErr}`);
  }

  /**
   * source: <video>/<canvas>. crop: fraction of the frame height cut off the TOP
   * (0 = whole frame, 0.4 = only the bottom 60% goes to the model).
   * Returns { boxes: [{x,y,w,h,score}] in source pixels, ms }.
   */
  async detect(source, srcW, srcH, crop = 0) {
    const cropY = Math.round(srcH * crop);
    const regionH = srcH - cropY;
    const size = INPUT_SIZE;
    const scale = Math.min(size / srcW, size / regionH);
    const drawW = Math.round(srcW * scale);
    const drawH = Math.round(regionH * scale);
    const padX = Math.floor((size - drawW) / 2);
    const padY = Math.floor((size - drawH) / 2);

    this.ctx.fillStyle = 'rgb(114,114,114)';
    this.ctx.fillRect(0, 0, size, size);
    this.ctx.drawImage(source, 0, cropY, srcW, regionH, padX, padY, drawW, drawH);
    const px = this.ctx.getImageData(0, 0, size, size).data;
    const area = size * size;
    const data = new Float32Array(3 * area);
    for (let i = 0; i < area; i++) {
      data[i] = px[i * 4] / 255;
      data[i + area] = px[i * 4 + 1] / 255;
      data[i + 2 * area] = px[i * 4 + 2] / 255;
    }
    const input = new this.ort.Tensor('float32', data, [1, 3, size, size]);

    const t0 = performance.now();
    const out = (await this.session.run({ [this.session.inputNames[0]]: input }))[this.session.outputNames[0]];
    const ms = performance.now() - t0;

    // YOLO11 output [1, 4 + classes, candidates]: cx, cy, w, h, then one score per class.
    const [, rows, count] = out.dims;
    const classes = rows - 4;
    const o = out.data;
    const found = [];
    for (let j = 0; j < count; j++) {
      let best = 0;
      for (let c = 0; c < classes; c++) best = Math.max(best, o[(4 + c) * count + j]);
      if (best < RAW_MIN) continue;
      const w = o[2 * count + j], h = o[3 * count + j];
      const x = (o[j] - w / 2 - padX) / scale;
      const y = (o[count + j] - h / 2 - padY) / scale + cropY;
      found.push(clamp({ x, y, w: w / scale, h: h / scale, score: best }, srcW, srcH));
    }
    return { boxes: dedupe(found), ms };
  }
}

function clamp(b, W, H) {
  const x = Math.max(0, b.x), y = Math.max(0, b.y);
  return { ...b, x, y, w: Math.min(W, b.x + b.w) - x, h: Math.min(H, b.y + b.h) - y };
}

function dedupe(boxes) {
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const b of boxes) if (!kept.some((k) => iou(k, b) > OVERLAP_MAX)) kept.push(b);
  return kept;
}

function iou(a, b) {
  const l = Math.max(a.x, b.x), t = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w), btm = Math.min(a.y + a.h, b.y + b.h);
  const s = Math.max(0, r - l) * Math.max(0, btm - t);
  const u = a.w * a.h + b.w * b.h - s;
  return u > 0 ? s / u : 0;
}
