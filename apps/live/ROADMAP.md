# apps/live roadmap (owner: Live, Ado)

Matches the board issues (`python3 scripts/board.py next live`).

## M0 · Setup (by Sat 2 PM)
- [x] #38 Camera page with stock YOLO11n (COCO) ONNX as placeholder (iPhone 16 Safari: WebGPU, ~55 ms, ~7.4 checks/s)
- [x] #39 Swap in pothole model: Muq's ONNX on R2 at `models/pothole.onnx`, now the default

## M3 · Live detection (by Sun 3 AM)
- [x] #41 Rear camera + ONNX Runtime Web (WebGPU, WASM fallback) + boxes on screen (checked on iPhone 16 Safari)
- [x] #42 GPS via `navigator.geolocation`; at most 1 detection per second (built, tested with fake GPS)
- [x] #43 Upload frame via `POST /api/upload`, then `POST /api/detections` (`source: "live"`) (live on the real API)
- [x] #44 Served by Vercel at `/live` (HTTPS): https://wayneawshackathon.vercel.app/live
- [x] #45 Fallback: laptop webcam works too (checked on the deployed site with the MacBook webcam)

## M4 · Demo-ready (by Sun 8 AM)
- [x] #46 Works pointed at a pothole photo on a laptop screen, 5 times in a row (recheck if Muq ships the new dash-cam model)

## Extra
- [x] Drive recorder (`?rec=1`): 5-minute video files, a JSON sidecar per file and a GPX track, per Muq's pipeline spec (`recorder.js`)

Dropped: ride along on the drive (#40, Muq drives solo).
