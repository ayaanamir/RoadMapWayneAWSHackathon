#!/usr/bin/env python3
"""Fetch real Detroit dash-cam frames from the CROWD dataset (YouTube) for labelling.

Usage:
  python3 fetch_crowd.py --out DIR [--videos 20] [--frames-per-video 60]
      [--test-fraction 0.2] [--seed 0] [--height 720] [--min-gap-sec 2]
      [--yt-dlp yt-dlp] [--ffmpeg ffmpeg] [--keep-video]
      [--cookies cookies.txt] [--exclude ids.txt]

Output: DIR/images/{train,test}/<videoid>_<t_ms>.jpg and DIR/manifest.csv.
Each video goes wholly to train or test. Re-running skips videos already in
the manifest. Needs yt-dlp, ffmpeg and node on PATH (or pass paths).
Run on a laptop: YouTube blocks cloud/Colab IPs.
"""
import argparse, csv, json, os, random, shutil, subprocess, sys, urllib.request

MAPPING_URL = "https://raw.githubusercontent.com/crowd-dataset/crowd/main/mapping.csv"
MIN_SEG_SEC = 180
EDGE_SEC = 30
FIELDS = ["path", "split", "video_id", "t_sec", "segment_start", "segment_end", "upload_date"]


def die(msg):
    sys.exit("error: " + msg)


def parse_list(s):
    s = s.strip().strip("[]")
    return [x.strip() for x in s.split(",") if x.strip()] if s else []


def load_segments(mapping_path):
    """Return {video_id: {"segments": [(start,end)], "upload_date": str}} for daytime car segments >= 3 min."""
    if mapping_path and os.path.exists(mapping_path):
        text = open(mapping_path, newline="", encoding="utf-8").read()
    else:
        try:
            with urllib.request.urlopen(MAPPING_URL, timeout=60) as r:
                text = r.read().decode("utf-8")
        except Exception as e:
            die("could not download CROWD mapping.csv: %s" % e)
        if mapping_path:
            open(mapping_path, "w", encoding="utf-8").write(text)
    csv.field_size_limit(10**9)
    out = {}
    for row in csv.DictReader(text.splitlines(True)):
        if row["locality"] != "Detroit" or row["iso3"] != "USA":
            continue
        vids = parse_list(row["videos"])
        tod = json.loads(row["time_of_day"])
        st = json.loads(row["start_time"])
        en = json.loads(row["end_time"])
        veh = parse_list(row["vehicle_type"])
        up = parse_list(row["upload_date"])
        for i, vid in enumerate(vids):
            if i >= len(tod) or i >= len(st) or i >= len(en):
                continue
            if i < len(veh) and veh[i] != "0":
                continue
            segs = [(a, b) for t, a, b in zip(tod[i], st[i], en[i])
                    if t == 0 and b - a >= MIN_SEG_SEC]
            if segs:
                out[vid] = {"segments": segs, "upload_date": up[i] if i < len(up) else ""}
    return out


def read_manifest(path):
    rows, done = [], set()
    if os.path.exists(path):
        with open(path, newline="") as f:
            for r in csv.DictReader(f):
                rows.append(r)
                done.add(r["video_id"])
    return rows, done


def download(args, vid, tmpdir):
    node = shutil.which("node")
    cmd = [args.yt_dlp, "-f", "bv*[height<=%d][ext=mp4]/bv*[height<=%d]/b[height<=%d]" % ((args.height,) * 3),
           "-o", os.path.join(tmpdir, vid + ".%(ext)s"), "--no-playlist", "--no-progress"]
    if node:
        cmd += ["--js-runtimes", "node:" + node]
    if args.cookies:
        cmd += ["--cookies", args.cookies]
    cmd.append("https://www.youtube.com/watch?v=" + vid)
    r = subprocess.run(cmd, capture_output=True, text=True)
    files = [f for f in os.listdir(tmpdir) if f.startswith(vid + ".") and not f.endswith((".part", ".ytdl"))]
    if r.returncode != 0 or not files:
        lines = (r.stderr or r.stdout).strip().splitlines()
        raise RuntimeError(lines[-1] if lines else "yt-dlp failed")
    return os.path.join(tmpdir, files[0])


def pick_times(rng, segments, k, min_gap):
    """Random timestamps inside segments (skipping 30 s at each end), >= min_gap apart."""
    spans = [(a + EDGE_SEC, b - EDGE_SEC) for a, b in segments if b - a > 2 * EDGE_SEC]
    times, tries = [], 0
    while len(times) < k and tries < k * 50:
        tries += 1
        a, b = rng.choice(spans) if len(spans) == 1 else rng.choices(spans, weights=[y - x for x, y in spans])[0]
        t = rng.uniform(a, b)
        if all(abs(t - u) >= min_gap for u in times):
            times.append(t)
    return sorted(times)


def seg_of(t, segments):
    for a, b in segments:
        if a <= t <= b:
            return a, b
    return segments[0]


def extract(ffmpeg, video, t, out):
    r = subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-ss", "%.3f" % t, "-i", video,
                        "-frames:v", "1", "-q:v", "2", out], capture_output=True)
    return r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0


def ahash(ffmpeg, path):
    """16x8 grayscale average hash as an int; None if it cannot be computed."""
    r = subprocess.run([ffmpeg, "-loglevel", "error", "-i", path, "-vf", "scale=16:8",
                        "-pix_fmt", "gray", "-f", "rawvideo", "-"], capture_output=True)
    px = r.stdout
    if r.returncode != 0 or len(px) != 128:
        return None
    avg = sum(px) / 128.0
    h = 0
    for p in px:
        h = (h << 1) | (1 if p >= avg else 0)
    return h


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--videos", type=int, default=20)
    ap.add_argument("--frames-per-video", type=int, default=60)
    ap.add_argument("--test-fraction", type=float, default=0.2)
    ap.add_argument("--out", required=True)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--height", type=int, default=720)
    ap.add_argument("--min-gap-sec", type=float, default=2)
    ap.add_argument("--yt-dlp", default="yt-dlp")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--keep-video", action="store_true")
    ap.add_argument("--cookies")
    ap.add_argument("--exclude")
    args = ap.parse_args()

    for tool in (args.yt_dlp, args.ffmpeg):
        if not shutil.which(tool):
            die("tool not found: %s (pass --yt-dlp / --ffmpeg)" % tool)
    if not shutil.which("node"):
        print("warning: node not found; YouTube downloads may fail (yt-dlp needs a JS runtime)")

    os.makedirs(args.out, exist_ok=True)
    manifest = os.path.join(args.out, "manifest.csv")
    rows, done = read_manifest(manifest)
    cands = load_segments(os.path.join(args.out, "mapping.csv"))
    excluded = set()
    if args.exclude:
        excluded = {l.strip() for l in open(args.exclude) if l.strip()}
    print("%d Detroit daytime-car videos with a segment >= 3 min" % len(cands))

    # Seeded, deterministic choice and split (independent of what is already done).
    ids = sorted(v for v in cands if v not in excluded)
    rng = random.Random(args.seed)
    rng.shuffle(ids)
    chosen = ids[:args.videos]
    n_test = round(len(chosen) * args.test_fraction)
    if args.test_fraction > 0 and len(chosen) >= 2:
        n_test = max(1, min(n_test, len(chosen) - 1))  # keep both splits non-empty
    split_of = {v: ("test" if i < n_test else "train") for i, v in enumerate(chosen)}
    # a video already in the manifest keeps the split it was given
    for r in rows:
        split_of[r["video_id"]] = r["split"]

    tmpdir = os.path.join(args.out, "_tmp")
    os.makedirs(tmpdir, exist_ok=True)
    new = not os.path.exists(manifest)
    mf = open(manifest, "a", newline="")
    w = csv.DictWriter(mf, fieldnames=FIELDS)
    if new:
        w.writeheader()

    ok, failed = 0, []
    for vid in chosen:
        if vid in done:
            print("[skip] %s already in manifest" % vid)
            ok += 1
            continue
        info, split = cands[vid], split_of[vid]
        print("[%s] downloading %s (%s)..." % (split, vid, ", ".join("%d-%ds" % s for s in info["segments"])))
        try:
            try:
                video = download(args, vid, tmpdir)
            except RuntimeError as e:
                print("  retry after: %s" % e)
                video = download(args, vid, tmpdir)
        except Exception as e:
            print("  FAILED download: %s" % e)
            failed.append((vid, str(e)))
            continue
        try:
            os.makedirs(os.path.join(args.out, "images", split), exist_ok=True)
            vrng = random.Random("%s-%s" % (args.seed, vid))
            times = pick_times(vrng, info["segments"], args.frames_per_video, args.min_gap_sec)
            hashes, kept = [], 0
            for t in times:
                rel = "images/%s/%s_%d.jpg" % (split, vid, round(t * 1000))
                dst = os.path.join(args.out, rel)
                if not extract(args.ffmpeg, video, t, dst):
                    continue
                h = ahash(args.ffmpeg, dst)
                if h is not None and any(bin(h ^ o).count("1") <= 3 for o in hashes):
                    os.remove(dst)
                    continue
                if h is not None:
                    hashes.append(h)
                a, b = seg_of(t, info["segments"])
                w.writerow({"path": rel, "split": split, "video_id": vid, "t_sec": "%.3f" % t,
                            "segment_start": a, "segment_end": b, "upload_date": info["upload_date"]})
                kept += 1
            mf.flush()
            print("  kept %d/%d frames" % (kept, len(times)))
            if kept:
                ok += 1
            else:
                failed.append((vid, "no frames extracted"))
        finally:
            if not args.keep_video:
                try:
                    os.remove(video)
                except OSError:
                    pass
    mf.close()
    try:
        os.rmdir(tmpdir)
    except OSError:
        pass

    rows, _ = read_manifest(manifest)
    counts = {"train": 0, "test": 0}
    for r in rows:
        counts[r["split"]] = counts.get(r["split"], 0) + 1
    print("\nSummary: videos ok=%d failed=%d | frames train=%d test=%d | manifest: %s"
          % (ok, len(failed), counts["train"], counts["test"], manifest))
    for vid, why in failed:
        print("  failed %s: %s" % (vid, why))


if __name__ == "__main__":
    main()
