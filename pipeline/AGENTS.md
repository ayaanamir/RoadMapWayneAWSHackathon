# Area: `pipeline/` — owner: Footage

Also read the root `AGENTS.md` and `shared/CONTRACTS.md` (v2).

## Job
Saturday's drive → `Detection`s, run on a laptop:
1. Inputs on disk (never in git): `data/raw/drive/2026-11-14/*.mov|*.mp4` + `*.gpx`.
2. Start time: `exiftool -CreateDate <video>`. Still clips: their single
   `ISO6709` location (`exiftool -ee -G1 "-gps*" <clip>`).
3. ffmpeg frames at 2–3 fps; frame time = start + offset; interpolate lat/lon from the GPX.
4. YOLO11n pothole model on frames; keep hits above a threshold.
5. Verify each hit with OpenRouter (`verify.py`, prompts in `pipeline/prompts/`):
   crop → `{ "verdict": "pothole|shadow|patch", "reason": "…" }`.
6. `POST /api/upload` (frame JPEG ≤ 1280 px) → `POST /api/detections` (`source: "drive"`).
   Until the API is up, write `pipeline/out/detections.json` (gitignored).

## Model
Fine-tune YOLO11n on a public pothole dataset (Colab GPU, ~20–40 min) or use a pretrained
pothole checkpoint. Weights stay local / shared via Drive — never committed. Give the
`.pt` to Live for the ONNX export.

## Stack
Python 3.12: `ultralytics`, `opencv-python`, `gpxpy`, `requests`; system `ffmpeg`, `exiftool`.

## Done check
One clip end to end; every detection validates against `shared/schema/detection.schema.json`
and shows up on the map.
