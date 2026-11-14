# apps/live roadmap (owner: Live, Ado)

Matches the board issues (`python3 scripts/board.py next live`).

## M0 · Setup (by Sat 2 PM)
- [x] #38 Camera page with stock YOLO11n (COCO) ONNX as placeholder (built; phone speed table in `README.md` still to fill)
- [ ] #39 Swap in pothole model: export Muq's `best.pt` to ONNX, host on R2, load from `R2_PUBLIC_URL/models/pothole.onnx` (waits on #58)

## M3 · Live detection (by Sun 3 AM)
- [ ] #41 Rear camera + ONNX Runtime Web (WebGPU, WASM fallback) + boxes on screen (done in #38, check on a phone)
- [ ] #42 GPS via `navigator.geolocation`; at most 1 detection per second
- [ ] #43 Upload frame via `POST /api/upload`, then `POST /api/detections` (`source: "live"`)
- [ ] #44 Served by Vercel at `/live` (HTTPS); URL in chat
- [ ] #45 Fallback: laptop webcam works too (works on laptop Chrome, recheck before demo)

## M4 · Demo-ready (by Sun 8 AM)
- [ ] #46 Works pointed at a pothole photo on a laptop screen, 5 times in a row

Dropped: ride along on the drive (#40, Muq drives solo).
