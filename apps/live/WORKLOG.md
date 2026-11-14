# apps/live work log

Short notes on what is being done in this area, so other agents and people know what is
taken and what is not. Newest at the top. Board claims and START/DONE posts still go in
the agent chat (issue #1); this file is the longer version.

## 2026-11-14 · Status box cleanup, icon buttons, loading box (Ado + Claude)

Branch: `live/icons-and-loader`.

- Status box: removed the grey speed line and the divider under the header. Speed now
  sits in the engine button's tooltip and the console.
- "Flip camera" and "Switch engine" are now square icon buttons (Lucide
  "switch-camera" and "cpu", inline SVG, ISC license).
- Last result is one short line, no grey box: "Would send pothole 87%", "Sent, on the
  map", "Pothole seen, waiting for GPS".
- Loading box (shown while the camera first starts): plain steps ("Starting the
  detector", "Downloading the pothole model", "Getting ready") and a yellow bar that
  fills with the real download progress.
- Checked locally with a fake camera: bar goes 5% to 90% in about 70 steps, then hides.

## 2026-11-14 · Status box and start screen restyled (Ado + Claude)

Branch: `live/stats-box-polish`.

- Took the map's look (apps/map/style.css) so phone and map read as one product:
  graphite colors, road-paint yellow as the only accent, IBM Plex Sans and Mono,
  every size on a 4px grid.
- Status box reordered by what matters: model name and "Sending" (yellow) or
  "Practice" at the top; In view, GPS, Sent to map in the middle; last result; speed
  numbers in one small grey line; "Flip camera" button with "Switch engine" as a quiet
  text button.
- Pothole boxes on the camera picture are now road-paint yellow with a mono label.
- Start screen: product name with the yellow stripe (as on the map), off-white button.
- Wording: "Practice: nothing goes to the map", "Would send: ...", "On the map as ...".
- Checked locally with a fake camera and GPS in practice mode.

## 2026-11-14 · Model name in the stats box (Ado + Claude)

Branch: `live/show-model-name`.

- Stats box now starts with "Model": `pothole`, `stock`, or the file name, plus
  `(dry)` when nothing is sent. Added after the phone ran the old model by mistake.
- #46 done: Ado pointed the phone at a pothole photo and away 10+ times; it boxed the
  pothole every time and cleared every time.
- Heads-up: on the bus test photo (no pothole), the pothole model drew 1 "pothole" box.
  Fine for the demo (phone sightings are "unverified" and cannot turn a pin yellow), but
  keep the phone off dark road patches and shadows when demoing.

## 2026-11-14 · #39 pothole model in (Ado + Claude)

Branch: `live/pothole-model`.

- Muq shared the pothole model as ONNX (YOLO11n, one class "pothole", 640x640,
  mAP50 0.85). Checked it: valid file, output [1, 5, 8400], same format as the stock
  model, no boxes on a blank image.
- Uploaded to R2 as `models/pothole.onnx` with `tools/upload_model.py`. Download
  matches the original (sha256 78550b47...).
- `config.js` now loads it by default. The stock model stays in the bucket for testing.
- Checked on the deployed site (dry run): loads on WebGPU, label "pothole", about
  27 ms per check on the laptop.
- From now on `/live` sends real detections when it sees a pothole and has GPS. Add
  `?dry` to the link for tests that should not reach the team map.

## 2026-11-14 · #45 done: laptop webcam works (Ado + Claude)

- Deployed `/live` on the MacBook in Chrome with the real FaceTime HD webcam
  (1280x720): WebGPU, about 95 to 111 ms per check, 7.4 to 8.8 checks per second.
  Boxes drawn (found "person"). GPS ±40 m from Wi-Fi location.
- This is the demo fallback if the phone has trouble. Recheck before the demo.

## 2026-11-14 · #42 GPS and #43 send detections (Ado + Claude)

Branch: `live/send-detections`.

- New `reporter.js`: follows GPS, and after each model run sends the strongest
  `pothole` box at most once per second: JPEG, `POST /api/upload`, then
  `POST /api/detections` (`source: "live"`, `verdict: "unverified"`). Shapes from
  `shared/CONTRACTS.md` v3.
- Stats box now shows GPS accuracy, number sent, and the last result.
- Test switches: `?dry` (send nothing, show what would be sent), `?sendlabel=` (send
  another label, for the stock model), `?api=` (another API address).
- Tested on laptop Chrome with a fake camera, fake GPS, and a fake API on localhost
  (never the team API): 4 uploads + 4 detections in 5 s with the right fields;
  "not live yet" message on 404 with the camera still running; default settings send
  nothing with the stock model.
- Ayaan's `/api/upload` and `/api/detections` are not live yet (404). Nothing else to
  change on the phone side when they are.

Not touched: anything outside `apps/live/`.

## 2026-11-14 · #38 and #41 done: works on iPhone 16 Safari (Ado + Claude)

- Camera opens and boxes show on Ado's iPhone 16 (latest iOS, Safari).
- Engine WebGPU, about 55 ms per check (spikes to 120+), about 7.4 checks per second.
- Speed table in `README.md` updated. Other phones still to add.

Next: #42 (GPS, at most 1 per second) and #43 (upload frame + POST detection). Ayaan's
`/api/health` and `/api/potholes` are live; `/api/upload` and `/api/detections` are not
yet. #39 waits on `best.pt` from Muq.

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

## Smoother camera, Geist font, Practice tag (branch live/smooth-camera)

- The page now shows the camera `<video>` directly. Before, it copied every frame onto
  a canvas by hand, 60 times a second, on the same thread as the model. That is what
  made the picture stutter on the phone.
- The canvas is now a clear layer on top with only the boxes, redrawn once per model
  run. Same size and "contain" fit as the video, so boxes still line up (checked).
- The model runs one frame at a time and waits one screen refresh between runs, so
  the phone can draw the camera and handle taps in between.
- Camera asks for 30 frames per second.
- Model input: the 4.9 MB array and tensor are made once and reused, instead of a new
  one every frame.
- Font: Geist and Geist Mono. "Practice" / "Sending" is now an outlined tag with a
  dot (gray for Practice, yellow for Sending).
- To check on the iPhone: is the camera smooth, and is model speed the same or better.

## Shorter status messages (branch live/short-messages)

- Removed "Ready" under the start button and the border on the Practice/Sending tag.
- Status box messages are now a few words: "Practice mode", "Waiting for GPS",
  "Would send, 87%", "On the map", "Sent, needs 2nd sighting",
  "Not sent: no connection / server offline / server error 500 / photo failed".
- GPS row: "Blocked", "No signal", "Not available" instead of full sentences.
- Color only where it matters: green = sent, amber = waiting for GPS or GPS too rough,
  red = not sent or location blocked, gray = practice. Everything else stays white.

## "Sent, checking" message (branch live/checking-message)

- After #88 the API checks live photos with the vision model after it answers, and
  says so with `verifying: n`. The phone now shows "Sent, checking" then, instead of
  the outdated "Sent, needs 2nd sighting". README updated to match.

## Phone / dashcam model switch (branch live/model-switch)

- Two named models in `config.js` (`MODELS`): phone = `models/pothole.onnx`, dashcam =
  `models/pothole-dashcam.onnx`. Picker on the start screen, layers button in the status
  box to switch (reloads), `?m=` in the link, last pick remembered.
- If the picked model is not in the bucket, the page says so and reloads on the phone model.
- `?model=<URL>` still works for any other file and hides the picker.
- Tested on the laptop: picker, dashcam fallback (file not uploaded yet), status box name
  and switch button.
