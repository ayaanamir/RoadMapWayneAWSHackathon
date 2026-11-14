// Runs a YOLO11 model in the browser with ONNX Runtime Web.
//
// How it works, in three steps:
//   1. prepare: fit the camera frame into a 640x640 square (adding gray bars so it
//      is not stretched) and turn the pixels into numbers the model understands.
//   2. run: hand those numbers to the model.
//   3. read: turn the model's raw output into a short list of boxes, in the same
//      pixel positions as the original camera frame.
//
// This file does not know about the page, the camera, or the API. It only takes an
// image and returns boxes, so the same code works for the stock model and the
// pothole model.

import {
  ORT_CDN, MODEL_URL, BACKEND, INPUT_SIZE, CONFIDENCE_MIN, OVERLAP_MAX, labelsFor,
} from "./config.js";

// ONNX Runtime Web. Loaded by loadRuntime() once we know which engine to use.
let ort = null;

// Thrown when the engine itself fails (not, for example, a bad network). The page uses
// this to switch engines. Trying another engine in the same page does not work: a stuck
// WebGPU run keeps holding the runtime, so a fresh page load is needed.
export class EngineFailed extends Error {
  constructor(backend, cause) {
    super(`${backend} did not work on this device: ${cause?.message || cause}`);
    this.backend = backend;
  }
}

export class Detector {
  constructor() {
    this.session = null;   // the loaded model
    this.backend = "";     // "webgpu" or "wasm", whichever actually loaded
    this.labels = [];      // class names
    this.loadMs = 0;       // how long loading took

    // A hidden square canvas we reuse for every frame (cheaper than making a new one).
    this.canvas = document.createElement("canvas");
    this.canvas.width = INPUT_SIZE;
    this.canvas.height = INPUT_SIZE;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
  }

  // Download the model and start it on one engine (WebGPU or WASM).
  // onStatus(text, progress) reports each step; progress runs from 0 to 1.
  async load(onStatus = () => {}) {
    const started = performance.now();
    const backend = chooseBackend();

    onStatus("Starting the detector", 0.05);
    ort = await loadRuntime(backend);

    // The download is most of the wait, so it fills most of the progress bar (10 to 85%).
    const modelBytes = await download(MODEL_URL, (done) => {
      onStatus("Downloading the pothole model", 0.1 + done * 0.75);
    });

    // Start the model and do one test run on a blank image. The first run is always
    // slow (setup work), so we pay that cost now instead of on the first camera frame.
    // An engine only counts as working once this test run finishes. On some phones
    // WebGPU starts fine and then hangs here, so there is a time limit.
    try {
      onStatus("Getting ready", 0.9);
      this.session = await withTimeLimit(
        startAndWarmUp(modelBytes, backend),
        START_LIMIT_MS[backend],
        (seconds) => onStatus(`Getting ready, ${seconds}s`, 0.9),
      );
    } catch (err) {
      throw new EngineFailed(backend, err);
    }

    this.backend = backend;
    this.loadMs = performance.now() - started;
    this.inputName = this.session.inputNames[0];
    this.outputName = this.session.outputNames[0];
  }

  // Find objects in one frame. `source` can be a <video>, <canvas>, or <img>.
  // Returns { boxes, ms } where each box is { x, y, w, h, score, label } in the
  // source's own pixels, and ms is how long the model took.
  async detect(source, sourceWidth, sourceHeight) {
    const { input, fit } = this.prepare(source, sourceWidth, sourceHeight);

    const started = performance.now();
    const results = await this.session.run({ [this.inputName]: input });
    const ms = performance.now() - started;

    const output = results[this.outputName];
    const boxes = this.read(output, fit);
    return { boxes, ms };
  }

  // Step 1: draw the frame into the 640x640 square and convert it to model input.
  prepare(source, srcW, srcH) {
    const size = INPUT_SIZE;
    const scale = Math.min(size / srcW, size / srcH);
    const drawW = Math.round(srcW * scale);
    const drawH = Math.round(srcH * scale);
    const padX = Math.floor((size - drawW) / 2);
    const padY = Math.floor((size - drawH) / 2);

    // Gray background (the value YOLO was trained with), then the frame centered.
    this.ctx.fillStyle = "rgb(114,114,114)";
    this.ctx.fillRect(0, 0, size, size);
    this.ctx.drawImage(source, 0, 0, srcW, srcH, padX, padY, drawW, drawH);

    // The canvas gives pixels as R,G,B,A,R,G,B,A,... with values 0 to 255.
    // The model wants all reds, then all greens, then all blues, with values 0 to 1.
    const pixels = this.ctx.getImageData(0, 0, size, size).data;
    const area = size * size;
    const data = new Float32Array(3 * area);
    for (let i = 0; i < area; i++) {
      data[i] = pixels[i * 4] / 255;                 // red
      data[i + area] = pixels[i * 4 + 1] / 255;      // green
      data[i + 2 * area] = pixels[i * 4 + 2] / 255;  // blue
    }

    const input = new ort.Tensor("float32", data, [1, 3, size, size]);
    return { input, fit: { scale, padX, padY, srcW, srcH } };
  }

  // Step 3: turn raw model output into a clean list of boxes.
  //
  // YOLO11 output shape is [1, 4 + classes, candidates]. For each candidate, the
  // first 4 rows are the box (center x, center y, width, height) and the rest are
  // one score per class. There is no separate "is there anything here" score.
  read(output, fit) {
    const [, rows, count] = output.dims;
    const classCount = rows - 4;
    if (this.labels.length !== classCount) this.labels = labelsFor(classCount);
    const out = output.data;

    const found = [];
    for (let j = 0; j < count; j++) {
      // Best class for this candidate.
      let best = 0;
      let bestScore = 0;
      for (let c = 0; c < classCount; c++) {
        const score = out[(4 + c) * count + j];
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (bestScore < CONFIDENCE_MIN) continue;

      // Box in 640x640 space, centered. Convert to top-left corner in frame pixels,
      // undoing the gray bars and the resize from step 1.
      const cx = out[j];
      const cy = out[count + j];
      const w = out[2 * count + j];
      const h = out[3 * count + j];
      const x = (cx - w / 2 - fit.padX) / fit.scale;
      const y = (cy - h / 2 - fit.padY) / fit.scale;

      found.push(clampBox({
        x, y, w: w / fit.scale, h: h / fit.scale,
        score: bestScore, classId: best, label: this.labels[best],
      }, fit.srcW, fit.srcH));
    }

    return removeDuplicates(found, OVERLAP_MAX);
  }
}

// Which engine to use. "auto" picks WebGPU (usually much faster) when the browser
// has it, otherwise WASM.
function chooseBackend() {
  if (BACKEND === "webgpu" || BACKEND === "wasm") return BACKEND;
  return "gpu" in navigator ? "webgpu" : "wasm";
}

// Add the ONNX Runtime <script> for one engine and wait for it to load.
// The WASM-only build is much smaller to download (about 11 MB instead of 22 MB),
// which matters on a phone.
function loadRuntime(backend) {
  if (window.ort) return Promise.resolve(window.ort);
  const file = backend === "webgpu" ? "ort.webgpu.min.js" : "ort.wasm.min.js";
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = ORT_CDN + file;
    script.onload = () => {
      // Tell ONNX Runtime where to download its helper files from.
      window.ort.env.wasm.wasmPaths = ORT_CDN;
      resolve(window.ort);
    };
    script.onerror = () => reject(new Error(`Could not load ${file} from the CDN.`));
    document.head.appendChild(script);
  });
}

// Download a file and report how much has arrived (0 to 1) as it comes in.
// Falls back to a plain download if the size is unknown.
async function download(url, onProgress) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not download the model (HTTP ${response.status}).`);
  }
  const total = Number(response.headers.get("Content-Length")) || 0;
  if (!total || !response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(total);
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes.set(value, received);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  return bytes.subarray(0, received);
}

// Create a model session on one engine and run it once on a blank image.
async function startAndWarmUp(modelBytes, backend) {
  const session = await ort.InferenceSession.create(modelBytes, {
    executionProviders: [backend],
    graphOptimizationLevel: "all",
  });
  await session.run({ [session.inputNames[0]]: blankInput() });
  return session;
}

// How long starting the model (including the test run) may take before we give up.
// WebGPU is fast when it works, so a long wait means it is stuck. WASM is slower on
// older phones but reliable, so it gets more time.
const START_LIMIT_MS = { webgpu: 15_000, wasm: 90_000 };

// Wait for `promise`, but fail if it takes longer than `limitMs`.
// Calls onTick(seconds) once a second so the page can show it is still working.
function withTimeLimit(promise, limitMs, onTick) {
  let seconds = 0;
  let ticker;
  let timer;
  const timeout = new Promise((_, reject) => {
    ticker = setInterval(() => onTick(++seconds), 1000);
    timer = setTimeout(
      () => reject(new Error(`no result after ${limitMs / 1000} seconds`)),
      limitMs,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearInterval(ticker);
    clearTimeout(timer);
  });
}

// An all-zero input, used for the warm-up run.
function blankInput() {
  const size = INPUT_SIZE;
  return new ort.Tensor("float32", new Float32Array(3 * size * size), [1, 3, size, size]);
}

// Keep a box inside the frame edges.
function clampBox(b, maxW, maxH) {
  const x = Math.max(0, b.x);
  const y = Math.max(0, b.y);
  const w = Math.min(maxW, b.x + b.w) - x;
  const h = Math.min(maxH, b.y + b.h) - y;
  return { ...b, x, y, w, h };
}

// The model usually finds the same object several times with slightly different
// boxes. Keep the strongest one and drop others of the same class that overlap it
// too much. (This is often called "non-max suppression".)
function removeDuplicates(boxes, overlapMax) {
  boxes.sort((a, b) => b.score - a.score);
  const kept = [];
  for (const box of boxes) {
    const duplicate = kept.some(
      (k) => k.classId === box.classId && overlap(k, box) > overlapMax,
    );
    if (!duplicate) kept.push(box);
  }
  return kept;
}

// How much two boxes overlap: 0 = not at all, 1 = exactly the same box.
function overlap(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.w, b.x + b.w);
  const bottom = Math.min(a.y + a.h, b.y + b.h);
  const shared = Math.max(0, right - left) * Math.max(0, bottom - top);
  const total = a.w * a.h + b.w * b.h - shared;
  return total > 0 ? shared / total : 0;
}
