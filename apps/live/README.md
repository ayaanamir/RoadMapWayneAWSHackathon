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
| `config.js` | Settings: model URL, engine, confidence. Most can be set from the URL. |
| `style.css` | Looks. |
| `model/` | Local model files for testing. Not in git. |

## Run it on your laptop

```bash
# 1. Get the stock model (placeholder until the pothole model is ready, see #39)
pip install ultralytics
yolo export model=yolo11n.pt format=onnx imgsz=640
mkdir -p apps/live/model && mv yolo11n.onnx apps/live/model/

# 2. Serve the repo root (the page uses /apps/live/... paths)
python3 -m http.server 8000

# 3. Open http://localhost:8000/apps/live/index.html and tap "Start camera"
```

The camera only works on `https://` pages or `localhost`. To test on a phone, use the
Vercel URL (see below).

## URL settings

| Parameter | Example | Meaning |
|---|---|---|
| `model` | `?model=https://.../pothole.onnx` | Load a different model file. |
| `ep` | `?ep=wasm` or `?ep=webgpu` | Force one engine. Default tries WebGPU, then WASM. |
| `conf` | `?conf=0.5` | Only show boxes at least this sure (0 to 1). Default 0.35. |

The model's number of classes is read from the file, so the same page works for the
stock model (80 classes) and the pothole model (1 class) with no code change.

## Model setup

Placeholder now: stock `yolo11n.pt` exported with the command above.
Pothole model (#39): when Muq shares `best.pt` (#58), run
`yolo export model=best.pt format=onnx imgsz=640`, upload it to R2 as
`models/pothole.onnx`, and set `MODEL_URL` in `config.js` to
`<R2_PUBLIC_URL>/models/pothole.onnx`.

## Speed results (#38)

"Model ms" on the page = time for one model run. Lower is better.

| Device | Browser | WebGPU ms | WASM ms | Notes |
|---|---|---|---|---|
| MacBook (dev laptop) | Chrome | ~31 | ~311 | Test photo, not camera. WASM runs on one thread (see below). |
| Ado's phone | | | | |
| Muq's phone | | | | |
| Ayaan's phone | | | | |

How to fill a row: open `/live` on the phone, start the camera, wait 10 seconds, read
"Model ms". Tap "Switch engine" and read it again.

Why WASM is slow: it can only use more than one CPU thread if the page is sent with two
extra security headers (`Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy`).
Those would go in `vercel.json`, which Ayaan owns. Only worth asking for if a phone
without WebGPU turns out to be the demo phone.

## Hosted URL (HTTPS)

_Not deployed yet (#44)._ Will be `https://<deployment>/live`.
