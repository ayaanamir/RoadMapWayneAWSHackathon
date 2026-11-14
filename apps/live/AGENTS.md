# Area: `apps/live/` — owner: Live

Also read the root `AGENTS.md` and `shared/CONTRACTS.md` (v2).

## Job
Phone page served by Vercel at `/live` (HTTPS, so camera + GPS work):
- Rear camera (`getUserMedia`) → YOLO11n pothole model in the browser
  (`onnxruntime-web`, WebGPU with WASM fallback) → boxes drawn on a canvas.
- On a hit (max 1/sec): JPEG of the frame (≤ 1280 px, quality ~0.8) →
  `POST /api/upload?name=<detection_id>.jpg` → `POST /api/detections` with
  `source: "live"`, `verdict: "unverified"`, GPS from `navigator.geolocation`.
- Laptop webcam must also work (demo fallback).

## Stack
Plain `index.html` + `app.js`, `onnxruntime-web` from a CDN. Model: export with
`yolo export model=<weights>.pt format=onnx`, upload the `.onnx` to the R2 bucket (public),
load it from `R2_PUBLIC_URL/models/pothole.onnx`. `.onnx` files are gitignored — don't commit them.

## Done check
Open `https://<deployment>/live` on a phone, point at a pothole photo on a laptop: a box
appears and the pin shows up on the map within 5 s.
