// The live page: camera in, boxes out.
//
// Flow:
//   1. User taps "Start camera" (browsers require a tap before using the camera).
//   2. We open the camera first and show it right away.
//   3. Then we load the model, with a message on top of the camera picture. On a
//      phone this can take a while (about 22 MB to download on WASM).
//   4. The phone shows the camera <video> itself, which keeps it smooth. We do not
//      copy frames by hand. A clear canvas on top holds only the boxes.
//   5. Whenever the model is free, we give it the newest frame, then redraw the
//      boxes. Between runs we wait one screen refresh, so the page never freezes.
//   6. After each model run, reporter.js sends a pothole (if any) to the API with
//      GPS, at most once per second (#42, #43).

import { Detector, EngineFailed } from "./detector.js";
import { Reporter } from "./reporter.js";
import { BACKEND_FROM_URL, REMEMBERED_BACKEND, rememberBackend, MODEL_URL, DRY_RUN } from "./config.js";

const view = document.getElementById("view");
const ctx = view.getContext("2d");
const startScreen = document.getElementById("start-screen");
const startButton = document.getElementById("start");
const statusText = document.getElementById("status");
const banner = document.getElementById("banner");
const bannerText = document.getElementById("banner-text");
const bannerProgress = document.getElementById("banner-progress");
const bannerBar = document.getElementById("banner-bar");
const engineButton = document.getElementById("switch-backend");
const stats = {
  panel: document.getElementById("stats"),
  model: document.getElementById("stat-model"),
  mode: document.getElementById("stat-mode"),
  count: document.getElementById("stat-count"),
  gps: document.getElementById("stat-gps"),
  sent: document.getElementById("stat-sent"),
  message: document.getElementById("stat-message"),
};

const detector = new Detector();
const reporter = new Reporter(showReporterState);
// The camera picture. The canvas "view" sits on top of it and only has the boxes.
const video = document.getElementById("camera");
video.playsInline = true; // needed on iPhone, or the video opens full screen
video.muted = true;

let facing = "environment"; // "environment" = back camera, "user" = front camera
let modelLoopRunning = false;
const recentMs = [];          // last few model run times, for the average
const recentRunTimes = [];    // when the last few runs finished, for checks/second

startButton.addEventListener("click", start);
document.getElementById("switch-backend").addEventListener("click", switchBackend);
document.getElementById("switch-camera").addEventListener("click", flipCamera);

async function start() {
  startButton.disabled = true;

  // Step 1: the camera. Done first, straight after the tap, because iPhone Safari is
  // strict about only asking for the camera right after the user taps something.
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot use the camera here. The page must be opened over https (or on localhost).");
    }
    say("Opening camera");
    await openCamera();
  } catch (err) {
    console.error("[live] camera failed:", err);
    say(cameraProblem(err));
    startButton.disabled = false;
    return;
  }

  // The camera works: show it now, and load the model on top of it.
  // Ask for location now too, while we are still close to the tap.
  reporter.startGps();

  startScreen.hidden = true;
  say("Starting the detector", 0);
  banner.hidden = false;

  // Step 2: the model.
  try {
    await detector.load(say);
    const { name, sending } = modelInfo();
    stats.model.textContent = name;
    stats.mode.textContent = sending ? "Sending" : "Practice";
    stats.mode.className = sending ? "mode on" : "mode";
    stats.panel.hidden = false;
    banner.hidden = true;
    // WebGPU was picked by hand and it worked: stop forcing WASM on this phone.
    if (BACKEND_FROM_URL === "webgpu") rememberBackend(null);
    startModelLoop();
    console.info(`[live] model ready on ${detector.backend} in ${Math.round(detector.loadMs)} ms`);
  } catch (err) {
    console.error("[live] model failed:", err);

    // WebGPU failed and nobody forced it in the URL: remember to use WASM on this
    // phone and reload. A reload is needed because a stuck WebGPU run keeps holding
    // the runtime, so WASM cannot start in this same page.
    if (err instanceof EngineFailed && err.backend === "webgpu" && !BACKEND_FROM_URL) {
      say("WebGPU does not work on this phone. Switching to WASM...");
      rememberBackend("wasm");
      setTimeout(() => window.location.reload(), 1000);
      return;
    }
    say(`Model did not load: ${err.message || err}`);
  }
}

// Turn a camera error into something a person can act on.
function cameraProblem(err) {
  if (err?.name === "NotAllowedError") {
    return "Camera access was blocked. On iPhone: tap \"aA\" in the address bar, then Website Settings, then Camera: Allow. Then reload this page.";
  }
  if (err?.name === "NotFoundError" || err?.name === "OverconstrainedError") {
    return "No camera found on this device.";
  }
  if (err?.name === "NotReadableError") {
    return "The camera is busy. Close other apps or tabs using it and try again.";
  }
  return `Camera did not start: ${err?.message || err}`;
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
      frameRate: { ideal: 30 }, // steady 30 per second; more only heats the phone
    },
  });
  video.srcObject = stream;
  await video.play();
}

// Run the model again and again, one frame at a time, for as long as the page is open.
function startModelLoop() {
  if (modelLoopRunning) return;
  modelLoopRunning = true;
  requestAnimationFrame(modelStep);
}

async function modelStep() {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w && h && !video.paused) {
    try {
      const { boxes, ms } = await detector.detect(video, w, h);
      drawBoxes(boxes, w, h);
      recordSpeed(ms);
      stats.count.textContent = String(boxes.length);

      // Send a pothole to the API if there is one (reporter.js decides if it is time).
      reporter.maybeSend(boxes, video, w, h);
    } catch (err) {
      console.error("[live] model run failed:", err);
    }
  }
  // Wait for the next screen refresh before the next run. This gives the phone a
  // moment to draw the camera and handle taps, so nothing stutters.
  requestAnimationFrame(modelStep);
}

// Clear the box layer and draw the newest boxes. Only runs after a model run, not
// every screen refresh. w and h are the camera size, which the boxes are measured in.
function drawBoxes(boxes, w, h) {
  // Same size as the camera picture, so a box at (x, y) lands on the same spot.
  if (view.width !== w || view.height !== h) {
    view.width = w;
    view.height = h;
  } else {
    ctx.clearRect(0, 0, w, h);
  }

  const line = Math.max(2, Math.round(view.width / 320));
  const fontSize = Math.max(14, Math.round(view.width / 45));
  ctx.lineWidth = line;
  ctx.font = `500 ${fontSize}px "Geist Mono", ui-monospace, monospace`;
  ctx.textBaseline = "top";

  for (const b of boxes) {
    const color = "#f2c230"; // road-paint yellow, the same as "still there" on the map
    ctx.strokeStyle = color;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    // Label above the box (or inside it, if the box touches the top edge).
    const text = `${b.label} ${Math.round(b.score * 100)}%`;
    const textW = ctx.measureText(text).width + 8;
    const textH = fontSize + 6;
    const ty = b.y - textH >= 0 ? b.y - textH : b.y;
    ctx.fillStyle = color;
    ctx.fillRect(b.x, ty, textW, textH);
    ctx.fillStyle = "#141415";
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

  // Speed is not shown on screen any more. It sits in the engine button's tooltip
  // (long-press or hover) and the console, for comparing phones.
  const avgMs = recentMs.reduce((a, b) => a + b, 0) / recentMs.length;
  let perSecond = 0;
  if (recentRunTimes.length > 1) {
    const seconds = (now - recentRunTimes[0]) / 1000;
    perSecond = (recentRunTimes.length - 1) / seconds;
  }
  engineButton.title = `Switch engine (now ${detector.backend}, ${avgMs.toFixed(0)} ms, ${perSecond.toFixed(1)} per s)`;
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

// Which model is running, for the stats box, and whether sightings go to the map.
// "Practice" (?dry in the link) means nothing is sent.
function modelInfo() {
  const file = MODEL_URL.split("/").pop();
  const name = file === "pothole.onnx" ? "Pothole model"
    : file === "yolo11n.onnx" ? "Stock model"
    : file.replace(/\.onnx$/, "");
  return { name, sending: !DRY_RUN };
}

// Update the GPS / sent lines in the stats box.
function showReporterState({ gps, gpsTone, sent, message, messageTone }) {
  stats.gps.textContent = gps;
  stats.gps.dataset.tone = gpsTone;
  stats.sent.textContent = String(sent);
  stats.message.textContent = message;
  stats.message.dataset.tone = messageTone;
  stats.message.hidden = !message;
}

// Show a message on the start screen and on top of the camera picture.
// `progress` (0 to 1) fills the yellow bar; leave it out to hide the bar (errors).
function say(text, progress) {
  statusText.textContent = text;
  bannerText.textContent = text;
  const hasBar = typeof progress === "number";
  bannerProgress.hidden = !hasBar;
  if (hasBar) bannerBar.style.transform = `scaleX(${Math.max(0, Math.min(1, progress))})`;
}

// Show any error we did not expect on screen, since a phone has no console to check.
window.addEventListener("error", (e) => showUnexpected(e.message));
window.addEventListener("unhandledrejection", (e) => showUnexpected(e.reason?.message || e.reason));
function showUnexpected(message) {
  say(`Error: ${message}`);
  if (startScreen.hidden) banner.hidden = false;
}

// Show which engine will be used, before anything loads.
if (BACKEND_FROM_URL) {
  say(`Engine set to ${BACKEND_FROM_URL} by the URL.`);
} else if (REMEMBERED_BACKEND === "wasm") {
  say("Using WASM on this phone (WebGPU did not work here before). Tap Start camera.");
}

// Tell the small check in index.html that this script loaded.
window.liveReady = true;
