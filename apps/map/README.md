# apps/map

The demo screen: map of potholes + per-pothole timeline and photos.
Rules: `AGENTS.md` here + at repo root. Progress: `ROADMAP.md`.

## Run
From the repo root: `python3 -m http.server 8000` → open http://localhost:8000/apps/map/

## Hosted URL
https://wayneawshackathon.vercel.app/ (map), `/report?id=<pothole_id>` (repair request), `/label`, `/test`

## /test — model accuracy on recorded footage
`apps/map/test.html` (route `/test`). Load a clip (stays in the browser), run the live model
or any `.onnx` file on frames sampled at 1–5 fps, mark frames that contain a real pothole
(`P`, `←` `→`), then read hits / misses / false boxes / recall / precision at any threshold.
Run a second model (or the "bottom 60%" road crop) to compare on the same frames; Export JSON.
`test-detector.js` mirrors `apps/live/detector.js` — keep their preprocessing in step.
