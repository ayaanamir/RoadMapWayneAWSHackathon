
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
