# Area: `apps/live/` — owner: Live

Also read the root `AGENTS.md`. You write only here and in `pitch/`.

## Job
A phone web page for the live part of the demo:
- Rear camera → YOLO pothole model in the browser (ONNX Runtime Web; WebGPU, falls back
  to WASM) → draw boxes on screen.
- On a hit: grab frame + GPS (`navigator.geolocation`), upload the frame via
  `POST /uploads/presign`, then `POST /detections` with `source: "live"`,
  `verdict: "unverified"`.
- Throttle: at most 1 detection per second.

## Stack
Static `index.html` + JS, `onnxruntime-web` from a CDN, model file served next to the page
(model file is NOT committed — download it in setup, see below). Must be served over
**HTTPS** for camera + GPS (Amplify Hosting or S3 + CloudFront).

## Setup note
Put the `.onnx` model in `apps/live/model/` locally (gitignored) and upload it to the
hosting bucket. Document the exact download/export command in `apps/live/README.md`.

## Check before you finish
Open the HTTPS URL on a real phone, point at a pothole photo on a laptop screen, and
confirm a box appears and a detection reaches the API (or the console logs it).
