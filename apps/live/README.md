# apps/live

Phone web page: camera, then YOLO in the browser, then boxes on screen. Later it also
sends GPS + the frame to the API as a detection.
Rules: `AGENTS.md` here and at the repo root. Progress: `ROADMAP.md`. What is being worked
on right now: `WORKLOG.md`.

## Files

| File | What it does |
|---|---|
| `index.html` | The page. Loads ONNX Runtime Web from a CDN, then `app.js`. |
| `app.js` | Camera, draw loop, speed numbers, buttons. |
| `detector.js` | Loads the model and turns a frame into a list of boxes. Knows nothing about the page. |
| `reporter.js` | GPS, and sends potholes to the API: upload the frame, then the detection. At most 1 per second. |
| `recorder.js` | Drive recording for the footage pipeline: raw camera video in 5 min files, a GPS track (GPX), and a JSON per file. Nothing is sent. |
| `config.js` | Settings: model URL, engine, confidence. Most can be set from the URL. |
| `style.css` | Looks. |
| `model/` | Local model files for testing. Not in git. |

## Run it on your laptop

```bash
# 1. Serve the repo root (the page uses /apps/live/... paths)
python3 -m http.server 8000

# 2. Open http://localhost:8000/apps/live/index.html and tap "Start camera"
#    The model downloads from R2, so no local model file is needed.
```

To make your own ONNX file (only needed for a new model):
```bash
pip install ultralytics
yolo export model=yolo11n.pt format=onnx imgsz=640
```

The camera only works on `https://` pages or `localhost`. To test on a phone, use the
Vercel URL (see below).

## URL settings

| Parameter | Example | Meaning |
|---|---|---|
| `model` | `?model=https://.../pothole.onnx` | Load a different model file. |
| `ep` | `?ep=wasm` or `?ep=webgpu` | Force one engine. Default tries WebGPU, then WASM. |
| `conf` | `?conf=0.5` | Only show boxes at least this sure (0 to 1). Default 0.35. |
| `dry` | `?dry` | Do everything except send. Shows what would be sent. Use for testing. |
| `sendlabel` | `?sendlabel=cup` | Send boxes with this label instead of `pothole`. Only with `?dry`, or you add fake potholes to the team map. |
| `api` | `?api=https://wayneawshackathon.vercel.app` | Use another API address (for testing from a laptop). Default: same site. |
| `rec` | `?rec=1` | Start recording the drive as soon as the camera is on. |
| `detect` | `?detect=0` | Record only: no model, nothing sent. For long drives. |
| `seg` | `?seg=1` | Minutes per video file. Default 5. Short values are for testing. |

The model's number of classes is read from the file, so the same page works for the
stock model (80 classes) and the pothole model (1 class) with no code change.

## Drive recording (for the footage pipeline)

Mount the phone on the dash, open `/live?rec=1&detect=0`, tap **Start recording**.
Keep the page open with the screen on (the page asks the phone not to sleep).

Files, all named after the UTC time the drive started:

| File | What |
|---|---|
| `drive_<start>_seg<N>.mp4` (`.webm` on Chrome/Android) | Raw camera, no boxes. A new file every 5 min. |
| `drive_<start>_seg<N>.json` | `file, start_utc_ms, end_utc_ms, mime, width, height, fps, user_agent`. The pipeline reads these names, so do not rename them. |
| `drive_<start>.gpx` | GPX 1.1 track, one point per GPS fix with its time. Saved after every video and on Stop. |

Frame time = `start_utc_ms + frame_index / fps`; the pipeline looks up the place in the GPX.
Files download on their own; the **Files** list in the status box has a Save button for
each in case the phone blocks that. Only the newest 3 videos stay in memory. The GPS
track is also kept in the phone's storage every 10 s: if the page closes mid-drive, the
start screen offers to save it next time.

## Model setup

The page loads its model from the team's R2 bucket, so the deployed site works without
any model file in git.

| Model | In the bucket | Status |
|---|---|---|
| Pothole model (YOLO11n, 1 class, mAP50 0.85) | `models/pothole.onnx` | Used now (#39) |
| Stock YOLO11n (COCO, 80 classes) | `models/yolo11n.onnx` | Old placeholder, kept for testing |

To upload (needs the R2 keys in the repo's `.env`):
```bash
pip install boto3
python3 apps/live/tools/upload_model.py apps/live/model/yolo11n.onnx
```

Pothole model (#39): when Muq shares `best.pt`, run
`yolo export model=best.pt format=onnx imgsz=640`, then
`python3 apps/live/tools/upload_model.py best.onnx --name pothole.onnx`, then change
`MODEL_URL` in `config.js` to `${R2_PUBLIC_URL}/models/pothole.onnx`.
You can try it first without a code change: `/live?model=<R2 URL>/models/pothole.onnx`.

The bucket has a rule that lets any web page read (GET) its files. Without it, browsers
block the page from loading the model. Uploads still need the secret keys.

## Sending detections (#42, #43)

After each model run, `reporter.js` checks for a `pothole` box. If there is one, the
phone has a GPS fix (less than 30 s old, within 100 m), and nothing was sent in the
last second, it:

1. saves the frame as a JPEG (max 1280 px wide, quality 0.8, usually under 200 KB),
2. `POST /api/upload?name=<id>.jpg` with the JPEG, gets back `image_url`,
3. `POST /api/detections` with `source: "live"`, `verdict: "unverified"`, GPS, the
   score, and the box in the JPEG's pixels.

The stats box shows GPS accuracy, how many were sent, and the last result. If the API
is not live yet, it says so and the camera keeps running.

The stock model has no `pothole` class, so it sends nothing. To try the flow anyway,
without touching the team database: `/live?dry&sendlabel=person`.

After it answers, the API checks each live photo with the vision model (Ayaan's PR #88).
"Pothole" makes a pin on its own; "shadow" or "patch" never does. While that runs the
phone says "Sent, checking", and the pin shows up a few seconds later. If the check is
off, a new spot still needs a 2nd sighting within 50 m (contract v3).

## Two models: phone and dashcam

The page can run either of two pothole models. Pick one on the start screen, or switch
later with the layers button in the status box (the page reloads and asks for a tap).

| Pick | File in the bucket | Trained on |
|---|---|---|
| Phone | `models/pothole.onnx` | close-up photos (Muq's first model, #39) |
| Dashcam | `models/pothole-dashcam.onnx` | dashcam footage, better from a moving car |

Links: `/live?m=phone` or `/live?m=dashcam`. The phone remembers the last pick.
If the dashcam file is not uploaded yet, the page says so and goes back to the phone model.

To add the dashcam model (YOLO11n, one class, exported at 640):

    python3 apps/live/tools/upload_model.py best.onnx --name pothole-dashcam.onnx

## Speed results (#38)

"Model ms" on the page = time for one model run. Lower is better.

| Device | Browser | WebGPU ms | WASM ms | Notes |
|---|---|---|---|---|
| MacBook (dev laptop) | Chrome | ~31 | ~311 | Test photo, not camera. WASM runs on one thread (see below). |
| MacBook (dev laptop), FaceTime HD webcam | Chrome | ~95 to 111 | not measured | Real webcam on the deployed site (#45). About 7.4 to 8.8 checks per second. GPS ±40 m from Wi-Fi. |
| iPhone 16 (latest iOS) | Safari | ~55 (spikes to 120+) | not measured | Real camera. About 7.4 checks per second on WebGPU. |
| Muq's phone | | | | |
| Ayaan's phone | | | | |

How to fill a row: open `/live` on the phone, start the camera, wait 10 seconds, read
"Model ms". Tap "Switch engine" and read it again.

Why WASM is slow: it can only use more than one CPU thread if the page is sent with two
extra security headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`).
Those would go in `vercel.json`, which Ayaan owns. Only worth asking for if a phone
without WebGPU turns out to be the demo phone.

## Hosted URL (HTTPS)

https://wayneawshackathon.vercel.app/live (redeploys on every merge to `main`).
