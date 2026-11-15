# pipeline

Drive footage + GPS → verified `Detection`s → API.
Rules: `AGENTS.md` here + at repo root. Progress: `ROADMAP.md`.

## Run
_Owner fills in:_
- Install: `pip install -r pipeline/requirements.txt` (+ system `ffmpeg`, `exiftool`)
- Process a clip: `…`

## run_drive.py
Offline drive pipeline: the phone recorder's files (`drive_<UTC>_seg<N>.mp4`, `.json` sidecars,
`drive_<UTC>.gpx`) -> pothole sightings -> `POST /api/upload` + `POST /api/detections?verify=wait`
(`source: "drive"`, the server's vision check runs before it answers, verdicts are logged).

```
python pipeline/run_drive.py --drive path/to/drive --model best.onnx --dry-run   # no network
python pipeline/run_drive.py --drive path/to/drive --model best.onnx             # send
```
Options: `--conf 0.40 --fps 3 --api URL --out DIR --max-sightings 200 --min-gap-m 15 --min-gap-s 3 --road-band`.
Frame time = sidecar `start_utc_ms` + video time (filename timestamp if the sidecar is missing);
lat/lon are interpolated from the GPX, frames more than 10 s from any GPS point are skipped.
One best box per frame, then hits within `min-gap-m` AND `min-gap-s` of a stronger one are dropped.
Each sent sighting costs about 0.4 cents of server vision check, so `--max-sightings` caps it
(most confident kept). Output in `pipeline/out/<drive>/`: `summary.json`, `detections.json`,
`sent.json` (resume: re-running skips what was sent), and with `--dry-run` `hits/*.jpg` with boxes drawn.

## Training notebooks (Colab)
- `train/train_pothole.ipynb` — v1, YOLO11n on Roboflow voxrl + ptvvw (live default).
- `train/train_dashcam.ipynb` — v2, dash-cam fine-tune (Figshare + ptvvw, 960).
- `train/train_dashcam_detroit.ipynb` — v3, + human-reviewed Detroit frames, 640.
- `train/train_v4.ipynb` — v4, Detroit v4 set (`autolabel/build_v4_data.py`) + RDD2022 US crack negatives, v1 weight blends, Detroit exam + crack check.
- `train/train_v5.ipynb` — v5 (#118): Detroit v4 set + clean RDD2022 Japan/India D40 + city_paste + US crack negatives + style_aug, blends, exam + crack check + ship verdict.
- Results and metrics: `MODEL_REPORT.md`, `train/results/`.

## Data credits
- RDD2022 (Arya et al.), CC BY-SA 4.0 — US subset via the Hugging Face mirror `dronefreak/RDD2022` (cracks only, used as negatives); Japan + India D40 potholes from the original release (Figshare) via `autolabel/rdd_d40_clean.py`.
- Figshare "Potholes dataset with YOLO annotations" (article 21214400).
- Roboflow Universe: `brad-dwyer/pothole-voxrl`, `work-5qhak/potholes-ptvvw` (see each page for license).
- Detroit dash-cam frames from the CROWD dataset (YouTube; frames not redistributed) and Improve Detroit / SeeClickFix city photos, labels reviewed by the team.
