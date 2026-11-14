
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
