# pipeline — roadmap (owner: Footage)

## M0 · Setup (by Sat 2 PM)
- [ ] `ffmpeg` + `exiftool` installed; `pipeline/requirements.txt` installs clean
- [ ] Pothole YOLO weights downloaded locally (not committed); runs on 5 test images
- [ ] Bedrock model access enabled; `verify.py` returns a verdict for one test image

## Drive (Sat 1–3 PM, with Live)
- [ ] One phone: GPS logger started first, then camera; landscape, low and centered, 60 fps if possible
- [ ] 10-second still clip at each site; full drive recorded
- [ ] Upload videos + `.gpx` to S3 `raw/drive/2026-11-14/`

## M2 · Footage → detections (by Sat midnight)
- [ ] Frame sampler (ffmpeg, 2–3 fps) + timestamp from `exiftool -CreateDate`
- [ ] GPX match (interpolate) → lat/lon per frame; still clips use their embedded location
- [ ] YOLO on frames → keep hits above threshold
- [ ] Bedrock verdict (`pothole | shadow | patch`) + one-sentence reason; prompts in `pipeline/prompts/`
- [ ] Upload frames to S3 `frames/`, `POST /detections` (or `pipeline/out/detections.json` until API is live)
- [ ] At least the Peterboro site processed end to end

## M4 · Polish (by Sun 8 AM)
- [ ] Optional: Bedrock "same spot as the city photo?" check for Peterboro
- [ ] All sites processed; numbers ready for the pitch (sites visited / still there / fixed)
