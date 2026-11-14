# apps/live roadmap (owner: Live, Ado)

Matches the board issues (`python3 scripts/board.py next live`).

## M0 · Setup (by Sat 2 PM)
- [x] #38 Camera page with stock YOLO11n (COCO) ONNX as placeholder (iPhone 16 Safari: WebGPU, ~55 ms, ~7.4 checks/s)
- [ ] #39 Swap in pothole model: export Muq's `best.pt` to ONNX, host on R2, load from `R2_PUBLIC_URL/models/pothole.onnx` (waits on #58)

## M3 · Live detection (by Sun 3 AM)
- [x] #41 Rear camera + ONNX Runtime Web (WebGPU, WASM fallback) + boxes on screen (checked on iPhone 16 Safari)
- [x] #42 GPS via `navigator.geolocation`; at most 1 detection per second (built, tested with fake GPS)
- [ ] #43 Upload frame via `POST /api/upload`, then `POST /api/detections` (`source: "live"`) (built, tested on a fake API; waits on Ayaan's real endpoints)
- [ ] #44 Served by Vercel at `/live` (HTTPS); URL in chat
- [x] #45 Fallback: laptop webcam works too (checked on the deployed site with the MacBook webcam)

## M4 · Demo-ready (by Sun 8 AM)
- [ ] #46 Works pointed at a pothole photo on a laptop screen, 5 times in a row

Dropped: ride along on the drive (#40, Muq drives solo).
