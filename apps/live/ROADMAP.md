# apps/live — roadmap (owner: Live)

## M0 · Setup (by Sat 2 PM)
- [ ] Test an existing in-browser YOLO demo on each teammate's phone; note which browsers are fast
- [ ] Export the pothole model to ONNX (`yolo export format=onnx`), command written in `README.md`

## Drive (Sat 1–3 PM, with Footage)
- [ ] Ride along, film the 10-second still clips, keep notes on which sites still have potholes

## M3 · Live detection (by Sun 3 AM)
- [ ] `index.html`: rear camera + ONNX Runtime Web (WebGPU → WASM fallback) + boxes drawn on screen
- [ ] GPS via `navigator.geolocation`; throttle to 1 detection/sec
- [ ] Upload frame via `POST /uploads/presign`, then `POST /detections` (`source: "live"`)
- [ ] Hosted over HTTPS on AWS (Amplify or S3 + CloudFront); URL in chat
- [ ] Fallback mode: laptop webcam works too

## M4 · Demo-ready (by Sun 8 AM)
- [ ] Works pointed at a pothole photo on a laptop screen, 5 times in a row
