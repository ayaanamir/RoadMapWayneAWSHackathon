# Area: `pipeline/` — owner: Footage

Also read the root `AGENTS.md`. You write only here.

## Job
Turn Saturday's drive into `Detection`s:
1. Inputs: video (`.mov`/`.mp4`) + GPS log (`.gpx`) from S3 `raw/drive/<date>/`.
2. Video start time: `exiftool -CreateDate <video>`. Short still clips: use their single
   embedded location (`com.apple.quicktime.location.ISO6709`).
3. Sample frames (ffmpeg, ~2–3 fps). Frame time = start time + offset → nearest GPX
   point (interpolate) → lat/lon.
4. Run YOLO (pothole model) on frames. Keep hits above a threshold.
5. **Verify with Bedrock** (`verify.py`): crop → `pothole | shadow | patch` + one-sentence
   reason. Optional: compare with the city photo, "same spot?".
6. Upload frame to S3 `frames/<detection_id>.jpg`, then `POST /detections` to the API.
   Until the API exists, write detections to `pipeline/out/detections.json` (gitignored).

## Stack
Python 3.12, `ultralytics`, `opencv-python`, `gpxpy`, `boto3`; system `ffmpeg` + `exiftool`.
Deps in `pipeline/requirements.txt`. Runs on a laptop or one EC2 instance.

## Rules for this area
- Never write to DynamoDB directly — always through the API.
- Never commit video, frames, `.gpx`, or model weights.
- You own the Bedrock prompts. Keep them in `pipeline/prompts/`.

## Check before you finish
Run the pipeline on one short clip and confirm every output validates against
`shared/schema/detection.schema.json`.
