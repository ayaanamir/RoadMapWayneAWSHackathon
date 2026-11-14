# pipeline/autolabel — Detroit dash-cam data, teacher labels, one scoreboard

Big vision model labels real Detroit footage → small YOLO model trains on it → scored on held-out Detroit drives.
Order: fetch_crowd.py → teacher_label.py → (human skims review.html) → make_yolo_dataset.py → train on Colab → eval_models.py.


## fetch_crowd.py

Builds a set of real Detroit dash-cam frames for labelling from the
[CROWD dataset](https://github.com/crowd-dataset/crowd) (YouTube video ids and
daytime segments in `mapping.csv`). Videos are split train/test as whole
videos, so no video contributes frames to both.

```
python3 pipeline/autolabel/fetch_crowd.py --out data/crowd --videos 20 --frames-per-video 60 \
    [--test-fraction 0.2] [--seed 0] [--height 720] [--min-gap-sec 2] \
    [--yt-dlp PATH] [--ffmpeg PATH] [--keep-video] [--cookies cookies.txt] [--exclude ids.txt]
```

Output: `OUT/images/{train,test}/<videoid>_<t_ms>.jpg` and `OUT/manifest.csv`
(`path,split,video_id,t_sec,segment_start,segment_end,upload_date`). Re-running
resumes: videos already in the manifest are skipped.

Notes:
- Needs `yt-dlp`, `ffmpeg` and `node` (yt-dlp's JS runtime for YouTube).
- Run it on a laptop. YouTube blocks Colab and most cloud IPs; use `--cookies` if you get a bot check.
- Each video is downloaded whole (about a minute each); YouTube rejects ffmpeg range requests.
- Only daytime car segments of 3 minutes or more are used; the first and last 30 s of each segment are skipped. Near-duplicate frames (average hash, Hamming distance <= 3) are dropped, so you may get fewer than K frames.
- `upload_date` is copied from CROWD as is (`ddmmyyyy`, leading zero dropped).
- CROWD does not redistribute video; do not commit frames. Respect YouTube's terms of service.


## teacher_label.py

Labels dash-cam frames with a large vision model via OpenRouter (default `google/gemini-4-carbon`).
Prompts for strict pothole boxes (Gemini `box_2d` 0-1000) plus lookalikes, converts boxes with
confidence >= `--min-conf` to YOLO (class 0). Frames with no potholes get an EMPTY label file
(hard negatives). Frames with no visible road and no potholes are skipped and listed in `no_road.txt`.

```
export OPENROUTER_API_KEY=...
python3 teacher_label.py --images frames/ --out labeled/ --limit 20      # try a few first
python3 teacher_label.py --images frames/ --out labeled/                  # resumable (OUT/cache)
python3 teacher_label.py --images frames/ --out labeled/ --dry-run        # fake teacher, no API
```

Options: `--model`, `--base-url`, `--concurrency 8`, `--min-conf 0.5`, `--limit N`,
`--price-in 2.0 --price-out 10.0` (USD per 1M tokens, for the cost estimate).
Output: `labels/`, `cache/`, `summary.csv`, `no_road.txt`, `review.html` (open it in a browser;
yellow solid = pothole, grey dashed = lookalike; filter buttons at the top).
Retries 429/5xx up to 4 times with backoff, 60 s timeout.

## make_yolo_dataset.py

Builds a YOLO dataset (`images/{train,val}`, `labels/{train,val}`, `data.yaml`, nc 1 `pothole`).
Video id = filename up to the last `_`, so all frames of a video land in the same split.
`--max-negative-ratio` (default 0.3) caps the share of empty-label images (deterministic drop).

```
python3 make_yolo_dataset.py --pair frames/ labeled/labels --out dataset/ \
    [--pair other_frames/ other/labels] [--val-fraction 0.1] [--max-negative-ratio 0.3] [--copy]
```
Images are symlinked by default (use `--copy` if the dataset moves to another machine).


## eval_models.py

One scoreboard for every candidate pothole model, scored on the same labelled frames
(YOLO-format `--images` / `--labels`, class 0 = pothole, missing/empty label = no pothole).

```
python eval_models.py --images DIR --labels DIR --out DIR \
    --model rdd2022.pt:3 --model live.onnx [--modes 640,960,road2x] [--device cpu]
```

- `MODEL[:ids]` = which predicted class ids count as pothole (default all).
- Modes: `640`, `960` (plain predict, conf 0.01) and `road2x` (crop y 35%-95%, two tiles with 15% overlap at 640, merged with NMS 0.5).
- Box TP = IoU >= 0.3, greedy by score; conf swept 0.05-0.90. Frame-level P/R too.
- Outputs: `report.md` (sorted table + verdict), `results.json` (all curves), `worst_errors.html` (top model: 30 worst false positives and missed GT boxes; open it from the out dir, image paths are relative).
- Needs ultralytics, opencv, numpy. Note: ONNX models are fixed-size, so the 960 mode may just be letterboxed to the export size.

## push_frames.py

Uploads crowd frames (from `fetch_crowd.py`) to R2 through `POST /api/upload`, registers them in the
review queue (`/api/labels` action `add`, batches of 100) and optionally runs the server-side teacher.
`frame_id = "crowd_" + <image stem>` (i.e. `crowd_<videoid>_<t_ms>`).

```
python3 push_frames.py --manifest OUT/manifest.csv --api https://wayneawshackathon.vercel.app --teach \
    [--concurrency 6] [--limit N] [--dry-run]
```
- Resumable: `OUT/push_state.json` maps frame_id to image_url; finished uploads are skipped on rerun (add is an upsert, teach only touches status "new").
- 429/5xx/network errors retry 4 times with backoff. `--teach` loops `GET ?todo=teach` until empty, or stops after 2 passes where the same frames keep failing; prints progress every 25 frames, taught/error counts and error texts grouped.
- `--dry-run` prints the plan without network.

## pull_reviewed.py

Exports human-reviewed frames into a YOLO folder: `DIR/{train,test}/images/<frame_id>.jpg` and
`DIR/{train,test}/labels/<frame_id>.txt` (class 0, `cx cy w h` from the top-left normalised boxes; empty file = no pothole).
Images are cached. Because `frame_id` is `crowd_<videoid>_<t_ms>`, `make_yolo_dataset.py` (video = name up to the last `_`) keeps each video in one split.

```
python3 pull_reviewed.py --api https://wayneawshackathon.vercel.app --out reviewed/
```

End-to-end team flow:
1. `fetch_crowd.py` -> `OUT/manifest.csv` + frames
2. `push_frames.py --manifest OUT/manifest.csv --api ... --teach` (one person)
3. Everyone reviews frames at `/label` until `/api/labels?stats=1` shows `test_left` and `train_left` at 0
4. `pull_reviewed.py --api ... --out reviewed/`
5. `eval_models.py --images reviewed/test/images --labels reviewed/test/labels ...` (scoreboard on the test split)
6. `make_yolo_dataset.py --pair reviewed/train/images reviewed/train/labels --out dataset/ --copy`
7. Zip `dataset/` and train in Colab.
