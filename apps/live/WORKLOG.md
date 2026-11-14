# apps/live work log

Short notes on what is being done in this area, so other agents and people know what is
taken and what is not. Newest at the top. Board claims and START/DONE posts still go in
the agent chat (issue #1); this file is the longer version.

## 2026-11-14 · #38 fix 3: camera never showed on iPhone 16 Safari (Ado + Claude)

Branch: `live/iphone-camera`.

- Real bug: `#start-screen` had `display: flex` in CSS, which beats the `hidden`
  switch. So the start screen never went away, even with the camera running under it.
  Added `#start-screen[hidden] { display: none; }`.
- Camera now opens first, right after the tap (iPhone Safari is strict about this),
  and shows straight away. The model loads after, with a message on top of the picture.
- The `<video>` is now on the page (invisible). iPhone Safari can give blank frames from
  a video that is not on the page.
- Clear messages for camera problems (blocked permission, no camera, camera busy), and
  any unexpected error now shows on screen, since a phone has no console.
- Small plain script in `index.html` says so if `app.js` fails to load, instead of the
  button doing nothing.
- Tested on laptop Chrome with a fake camera (the bus photo as a video stream): tap
  Start, start screen hides, picture shows, 5 boxes drawn, stats panel filled.

## 2026-11-14 · #38 fix 2: stuck on "Starting model (wasm)" on a phone (Ado + Claude)

Branch: `live/wasm-reload-fallback`.

- Fix 1 (switch to WASM in the same page) did not work on Ado's phone: it stopped at
  "Starting model (wasm)". Cause: the stuck WebGPU run keeps holding ONNX Runtime, so
  WASM waits behind it forever. The laptop test missed this because the fake hang did
  not hold the runtime.
- Now each page load uses one engine only. If WebGPU fails or hangs (15 s limit), the
  page remembers "use WASM on this phone" (localStorage) and reloads. After that the
  phone goes straight to WASM.
- WASM mode loads the smaller ONNX Runtime build (about 11 MB instead of 22 MB).
- Picking WebGPU by hand ("Switch engine") and having it work clears the memory.
- Tested on laptop Chrome: normal WebGPU (5 objects), fake WebGPU hang (caught after
  15 s), and remembered WASM (smaller runtime, 5 objects, about 325 ms per run).

## 2026-11-14 · #38 fix: stuck on "Warming up" on a phone (Ado + Claude)

Branch: `live/warmup-fallback`.

- On Ado's phone the page stayed on "Warming up..." forever. WebGPU started, but its
  first run never finished, and the page had no time limit.
- Now each engine must finish one test run within a time limit (WebGPU 15 s, WASM 60 s).
  If WebGPU is stuck, the page moves on to WASM by itself.
- The model is downloaded once and reused, so switching engines does not download it
  again.
- The status line counts seconds while warming up, so you can tell it is not frozen.
- Tested on laptop Chrome with a fake "WebGPU hangs" case: switched to WASM after 15 s
  and found the same 5 objects in the test photo.

## 2026-11-14 · #38 model on R2 (Ado + Claude)

Branch: `live/model-on-r2`.

- Uploaded the stock model to R2 as `models/yolo11n.onnx` with the new
  `tools/upload_model.py`.
- `config.js` now loads the model from R2 by default, so the deployed `/live` page works.
- Added a CORS rule to the `waynehackathon` bucket (approved by Ado): any site may GET or
  HEAD files. Before this, browsers blocked the model download. It does not allow
  uploads or deletes. There was no CORS rule before, so nothing was replaced.

## 2026-11-14 · #38 camera page with stock model (Ado + Claude)

Branch: `live/camera-page`. Status: built and tested on a laptop, waiting for phone tests.

What was done:
- `index.html`, `app.js`, `detector.js`, `config.js`, `style.css` in `apps/live/` only.
- Back camera (laptop webcam on a laptop), YOLO11n through ONNX Runtime Web 1.20.1,
  WebGPU first with WASM fallback, boxes drawn on one canvas with the video.
- Speed panel on screen (engine, model ms, checks per second, boxes found) plus
  "Switch engine" and "Flip camera" buttons.
- Checked on the laptop with a test photo: same boxes as the official Ultralytics
  output (within 1 pixel). WebGPU ~31 ms, WASM ~311 ms.

Also partly covers #41 (camera + WebGPU/WASM + boxes) and #45 (laptop webcam). Those
stay open on the board until checked on a phone.

Not touched: anything outside `apps/live/`. No changes to `shared/`, `vercel.json`,
or other areas.

Left for the human: open the page on each phone and fill the speed table in `README.md`.

Next in this area: #42 (GPS, 1 per second) and #43 (upload + POST). Both wait on the API
(#4, #10, #11 by Ayaan). #39 waits on `best.pt` from Muq (#58).
