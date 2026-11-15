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
