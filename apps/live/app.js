// The live page: camera in, boxes out.
//
// Flow:
//   1. User taps "Start camera" (browsers require a tap before using the camera).
//   2. We load the model and open the camera at the same time.
//   3. Every screen refresh we draw the newest camera frame plus the latest boxes.
//   4. Separately, whenever the model is free, we give it the newest frame.
//      The model is slower than the screen, so the picture stays smooth and the
//      boxes update as fast as the model allows.
//
// Not done here yet (separate board tasks):
//   #42 GPS + one detection per second, #43 upload frame and POST /api/detections.
//   The place to hook those in is marked "NEXT" below.

import { Detector, EngineFailed } from "./detector.js";
import { BACKEND_FROM_URL, REMEMBERED_BACKEND, rememberBackend } from "./config.js";

const view = document.getElementById("view");
const ctx = view.getContext("2d");
const startScreen = document.getElementById("start-screen");
const startButton = document.getElementById("start");
const statusText = document.getElementById("status");
const stats = {
  panel: document.getElementById("stats"),
  backend: document.getElementById("stat-backend"),
  ms: document.getElementById("stat-ms"),
  fps: document.getElementById("stat-fps"),
  count: document.getElementById("stat-count"),
};

const detector = new Detector();
const video = document.createElement("video");
video.playsInline = true; // needed on iPhone, or the video opens full screen
video.muted = true;

let facing = "environment"; // "environment" = back camera, "user" = front camera
let latestBoxes = [];
let modelBusy = false;
const recentMs = [];          // last few model run times, for the average
const recentRunTimes = [];    // when the last few runs finished, for checks/second

startButton.addEventListener("click", start);
document.getElementById("switch-backend").addEventListener("click", switchBackend);
document.getElementById("switch-camera").addEventListener("click", flipCamera);

async function start() {
  startButton.disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot use the camera here. The page must be opened over https (or on localhost).");
    }
    // Load the model and open the camera in parallel to save time.
    await Promise.all([
      detector.load(setStatus),
      openCamera(),
    ]);
    stats.backend.textContent = detector.backend;
    // WebGPU was picked by hand and it worked: stop forcing WASM on this phone.
    if (BACKEND_FROM_URL === "webgpu") rememberBackend(null);
    console.info(`[live] model ready on ${detector.backend} in ${Math.round(detector.loadMs)} ms`);

    startScreen.hidden = true;
    stats.panel.hidden = false;
    requestAnimationFrame(drawLoop);
  } catch (err) {
    console.error("[live]", err);

    // WebGPU failed and nobody forced it in the URL: remember to use WASM on this
    // phone and reload. A reload is needed because a stuck WebGPU run keeps holding
    // the runtime, so WASM cannot start in this same page.
    if (err instanceof EngineFailed && err.backend === "webgpu" && !BACKEND_FROM_URL) {
      setStatus("WebGPU does not work on this phone. Switching to WASM...");
      rememberBackend("wasm");
      setTimeout(() => window.location.reload(), 1000);
      return;
    }

    setStatus(err.message || String(err));
    startButton.disabled = false;
  }
}

// Open the camera. On a phone we ask for the back camera; on a laptop the browser
// just gives us the webcam, which is our demo fallback (#45).
async function openCamera() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  video.srcObject = stream;
  await video.play();
}

// Runs once per screen refresh.
function drawLoop() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w && h) {
    // Match the canvas to the camera's real size so boxes are in the same pixels.
    if (view.width !== w || view.height !== h) {
      view.width = w;
      view.height = h;
    }
    ctx.drawImage(video, 0, 0, w, h);
    drawBoxes(latestBoxes);

    // Give the model a new frame only if it finished the last one.
    if (!modelBusy) runModel(w, h);
  }
  requestAnimationFrame(drawLoop);
}

async function runModel(w, h) {
  modelBusy = true;
  try {
    const { boxes, ms } = await detector.detect(video, w, h);
    latestBoxes = boxes;
    recordSpeed(ms);
    stats.count.textContent = String(boxes.length);

    // NEXT (#42, #43): if a pothole is in `boxes`, and it has been at least 1 second
    // since the last one we sent, read GPS, save the frame as a JPEG, upload it, and
    // POST the detection.
  } catch (err) {
    console.error("[live] model run failed:", err);
  } finally {
    modelBusy = false;
  }
}

function drawBoxes(boxes) {
  const line = Math.max(2, Math.round(view.width / 320));
  const fontSize = Math.max(14, Math.round(view.width / 45));
  ctx.lineWidth = line;
  ctx.font = `600 ${fontSize}px system-ui, sans-serif`;
  ctx.textBaseline = "top";

  for (const b of boxes) {
    const color = "#f97316";
    ctx.strokeStyle = color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    // Label above the box (or inside it, if the box touches the top edge).
    const text = `${b.label} ${Math.round(b.score * 100)}%`;
    const textW = ctx.measureText(text).width + 8;
    const textH = fontSize + 6;
    const ty = b.y - textH >= 0 ? b.y - textH : b.y;
    ctx.fillStyle = color;
    ctx.fillRect(b.x, ty, textW, textH);
    ctx.fillStyle = "#111111";
    ctx.fillText(text, b.x + 4, ty + 3);
  }
}

// Keep a short history so the numbers are steady instead of jumping every frame.
function recordSpeed(ms) {
  const now = performance.now();
  recentMs.push(ms);
  recentRunTimes.push(now);
  if (recentMs.length > 30) recentMs.shift();
  if (recentRunTimes.length > 30) recentRunTimes.shift();

  const avgMs = recentMs.reduce((a, b) => a + b, 0) / recentMs.length;
  stats.ms.textContent = avgMs.toFixed(0);

  if (recentRunTimes.length > 1) {
    const seconds = (now - recentRunTimes[0]) / 1000;
    stats.fps.textContent = ((recentRunTimes.length - 1) / seconds).toFixed(1);
  }
}

// Reload the page using the other engine, to compare speed on the same phone.
function switchBackend() {
  const next = detector.backend === "webgpu" ? "wasm" : "webgpu";
  const url = new URL(window.location.href);
  url.searchParams.set("ep", next);
  window.location.href = url.toString();
}

async function flipCamera() {
  facing = facing === "environment" ? "user" : "environment";
  try {
    await openCamera();
  } catch (err) {
    console.error("[live] could not switch camera:", err);
  }
}

function setStatus(text) {
  statusText.textContent = text;
}

// Show which engine will be used, before anything loads.
if (BACKEND_FROM_URL) {
  setStatus(`Engine set to ${BACKEND_FROM_URL} by the URL.`);
} else if (REMEMBERED_BACKEND === "wasm") {
  setStatus("Using WASM on this phone (WebGPU did not work here before). Tap Start camera.");
}
