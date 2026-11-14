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

The model's number of classes is read from the file, so the same page works for the
stock model (80 classes) and the pothole model (1 class) with no code change.

## Model setup

The page loads its model from the team's R2 bucket, so the deployed site works without
any model file in git.

| Model | In the bucket | Status |
|---|---|---|
| Stock YOLO11n (COCO, 80 classes) | `models/yolo11n.onnx` | Uploaded, used now |
| Pothole model (1 class) | `models/pothole.onnx` | Waiting on `best.pt` from Muq (#58) |

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

The API only puts a new pin on the map after a verified sighting or a 2nd sighting
within 50 m (contract v3). Live sightings are unverified, so the first one near a
place with no city report will not show; the second one will.

## Speed results (#38)

"Model ms" on the page = time for one model run. Lower is better.

| Device | Browser | WebGPU ms | WASM ms | Notes |
|---|---|---|---|---|
| MacBook (dev laptop) | Chrome | ~31 | ~311 | Test photo, not camera. WASM runs on one thread (see below). |
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
