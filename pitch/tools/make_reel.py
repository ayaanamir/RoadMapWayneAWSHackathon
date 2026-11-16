#!/usr/bin/env python3
"""Demo reel: run our dash-cam pothole model on a folder of clips, then stitch them into
one looping MP4 for the demo laptop (every clip), plus short GIFs of the best few for the README.

    python3 pitch/tools/make_reel.py "<clips folder>"              # build / update the reel
    python3 pitch/tools/make_reel.py "<clips folder>" --gif 04m17 04m36 07m14   # + README GIFs

How appending works
- <clips folder>/reel.txt is the play order, one file name per line. An optional caption
  goes after " | ", e.g.  east-side-04m17s-04m21s.mp4 | Detroit, east side
  Lines starting with # are skipped (comment a clip out to drop it from the reel).
- Any video in the folder that is not in reel.txt yet is appended to the END of reel.txt
  (oldest file first), so to add clips: drop them in the folder and rerun.
- Each clip is processed once and cached in <clips folder>/_boxed/. Rerunning only does
  the new clips, then re-stitches. Delete a file from _boxed/ to redo that clip.

Output: <clips folder>/_reel/reel.mp4 (1920x1080, 30 fps, H.264, all enabled clips) and one
<clip>.gif per --gif name (README picks; keep it to 2-3, each a few seconds).
Videos never go in git (see root .gitignore); keep the reel on the demo laptop or Drive.

Same preprocessing as apps/live/detector.js: letterbox to 640, gray 114 padding, RGB/255,
NMS 0.45. Default model = what the live page ships for the dash cam; default threshold is
0.35 (the live page uses 0.10, which also boxes curb rocks in these clips).

Needs: ffmpeg, and  pip install onnxruntime opencv-python-headless numpy
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_MODEL = ROOT / "apps" / "live" / "model" / "pothole-dashcam.onnx"
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}
OUT_W, OUT_H, OUT_FPS = 1920, 1080, 30
SIZE = 640
BOX = (0, 200, 255)  # BGR, amber like the live page


class Detector:
    def __init__(self, model, conf):
        self.sess = ort.InferenceSession(str(model), providers=["CPUExecutionProvider"])
        self.inp = self.sess.get_inputs()[0].name
        self.conf = conf

    def __call__(self, img):
        h, w = img.shape[:2]
        sc = min(SIZE / w, SIZE / h)
        dw, dh = round(w * sc), round(h * sc)
        px, py = (SIZE - dw) // 2, (SIZE - dh) // 2
        canvas = np.full((SIZE, SIZE, 3), 114, np.uint8)
        canvas[py:py + dh, px:px + dw] = cv2.resize(img, (dw, dh), interpolation=cv2.INTER_LINEAR)
        x = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32).transpose(2, 0, 1)[None] / 255
        out = self.sess.run(None, {self.inp: x})[0][0]  # [4 + classes, candidates]
        scores = out[4:].max(0)
        keep = scores >= self.conf
        if not keep.any():
            return []
        cx, cy, bw, bh = out[0, keep], out[1, keep], out[2, keep], out[3, keep]
        s = scores[keep]
        boxes = np.stack([(cx - bw / 2 - px) / sc, (cy - bh / 2 - py) / sc, bw / sc, bh / sc], 1)
        idx = np.array(cv2.dnn.NMSBoxes(boxes.tolist(), s.tolist(), self.conf, 0.45), dtype=int).flatten()
        return [(boxes[i], float(s[i])) for i in idx]


def text(img, s, org, scale, thick=2):
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), thick + 3, cv2.LINE_AA)
    cv2.putText(img, s, org, cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), thick, cv2.LINE_AA)


def fit_1080(img):
    """Scale into 1920x1080 keeping aspect, black bars if needed."""
    h, w = img.shape[:2]
    sc = min(OUT_W / w, OUT_H / h)
    nw, nh = round(w * sc), round(h * sc)
    if (nw, nh) == (w, h) and (w, h) == (OUT_W, OUT_H):
        return img
    out = np.zeros((OUT_H, OUT_W, 3), np.uint8)
    x, y = (OUT_W - nw) // 2, (OUT_H - nh) // 2
    out[y:y + nh, x:x + nw] = cv2.resize(img, (nw, nh), interpolation=cv2.INTER_AREA)
    return out


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def process_clip(det, src, dst, caption, conf):
    cap = cv2.VideoCapture(str(src))
    if not cap.isOpened():
        print(f"  skip {src.name}: cannot open")
        return None
    fps = cap.get(cv2.CAP_PROP_FPS) or OUT_FPS
    tmp = dst.with_suffix(".tmp.mp4")
    part = dst.with_suffix(".part.mp4")
    vw = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), fps, (OUT_W, OUT_H))
    n = hit = 0
    top = 0.0
    while True:
        ok, frame = cap.read()
        if not ok:
            break
        frame = fit_1080(frame)
        dets = det(frame)
        for (x, y, w, h), c in dets:
            x, y, w, h = map(int, (x, y, w, h))
            cv2.rectangle(frame, (x, y), (x + w, y + h), BOX, 4)
            label = f"pothole {c:.2f}"
            (tw, th), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.9, 2)
            ty = max(th + 10, y - 10)
            lx = min(max(2, x), OUT_W - tw - 12)  # keep the label on screen
            cv2.rectangle(frame, (lx - 2, ty - th - 8), (lx + tw + 8, ty + 6), BOX, -1)
            cv2.putText(frame, label, (lx + 3, ty), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 0), 2, cv2.LINE_AA)
        text(frame, "Still There?  |  real model output, nothing drawn by hand", (28, 52), 1.0)
        text(frame, f"dash-cam model, threshold {conf:.2f}" + (f"  |  {caption}" if caption else ""),
             (28, OUT_H - 30), 0.85)
        vw.write(frame)
        n += 1
        hit += bool(dets)
        top = max([top] + [c for _, c in dets])
    vw.release()
    if n == 0:
        tmp.unlink(missing_ok=True)
        print(f"  skip {src.name}: no frames")
        return None
    # normalise every clip to the same codec / fps so the concat needs no re-encode
    ffmpeg("-i", str(tmp), "-r", str(OUT_FPS), "-c:v", "libx264", "-preset", "medium", "-crf", "20",
           "-pix_fmt", "yuv420p", "-an", str(part))
    tmp.unlink()
    part.rename(dst)  # only a finished file gets the cached name
    print(f"  {src.name}: {n} frames, {hit} with a box ({100 * hit // n}%), max conf {top:.2f}")
    return dst


def read_order(folder):
    """reel.txt entries (name, caption, enabled); append new videos to the end."""
    order_file = folder / "reel.txt"
    lines = order_file.read_text().splitlines() if order_file.exists() else []
    entries, known = [], set()
    for ln in lines:
        raw = ln.strip()
        if not raw:
            continue
        enabled = not raw.startswith("#")
        body = raw.lstrip("#").strip()
        name, _, cap = body.partition("|")
        name = name.strip()
        if not name or not (folder / name).suffix.lower() in VIDEO_EXT:
            continue  # a plain comment line
        known.add(name)
        entries.append((name, cap.strip(), enabled))
    new = sorted((p for p in folder.iterdir()
                  if p.is_file() and p.suffix.lower() in VIDEO_EXT and p.name not in known),
                 key=lambda p: p.stat().st_mtime)
    if new or not order_file.exists():
        with order_file.open("a") as f:
            if not lines:
                f.write("# Play order for make_reel.py. One clip per line, optional ' | caption'.\n"
                        "# New videos in this folder are appended here automatically. '#' = skip.\n")
            for p in new:
                f.write(f"{p.name}\n")
                entries.append((p.name, "", True))
                print(f"  appended to reel.txt: {p.name}")
    return entries


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder")
    ap.add_argument("--model", default=str(DEFAULT_MODEL))
    # 0.35, not the live page's 0.10: at 0.10 curb rocks and debris get weak (~0.2) boxes
    ap.add_argument("--conf", type=float, default=0.35)
    ap.add_argument("--gif", nargs="+", metavar="NAME_PART", default=[],
                    help="make a README GIF of each clip whose name contains this (2-3 best ones)")
    ap.add_argument("--gif-seconds", type=float, default=4)
    ap.add_argument("--gif-width", type=int, default=640)
    a = ap.parse_args()

    folder = Path(a.folder).expanduser().resolve()
    if not folder.is_dir():
        sys.exit(f"not a folder: {folder}")
    if not Path(a.model).exists():
        sys.exit(f"model not found: {a.model}")
    boxed_dir, reel_dir = folder / "_boxed", folder / "_reel"
    boxed_dir.mkdir(exist_ok=True)
    for leftover in [*boxed_dir.glob("*.tmp.mp4"), *boxed_dir.glob("*.part.mp4")]:  # interrupted run
        leftover.unlink()
    reel_dir.mkdir(exist_ok=True)

    entries = read_order(folder)
    det = Detector(a.model, a.conf)
    parts = []
    for name, caption, enabled in entries:
        if not enabled:
            continue
        src = folder / name
        if not src.exists():
            print(f"  missing, skipped: {name}")
            continue
        dst = boxed_dir / f"{src.stem}.thr{a.conf:.2f}.boxed.mp4"  # new threshold = redo
        stale = dst.exists() and (dst.stat().st_mtime < src.stat().st_mtime
                                  or dst.stat().st_mtime < Path(a.model).stat().st_mtime)
        if not dst.exists() or stale:
            print(f"processing {name}")
            if not process_clip(det, src, dst, caption, a.conf):
                continue
        else:
            print(f"  cached: {name}")
        parts.append(dst)

    if not parts:
        sys.exit("no clips to stitch")
    lst = reel_dir / "concat.txt"
    lst.write_text("".join(f"file '{p.as_posix()}'\n" for p in parts))
    reel = reel_dir / "reel.mp4"
    ffmpeg("-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", "-movflags", "+faststart", str(reel))
    dur = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0",
                          str(reel)], capture_output=True, text=True).stdout.strip()
    print(f"\nreel: {reel}  ({len(parts)} clips, {float(dur or 0):.1f} s)")
    print("loop it: open in QuickTime -> View -> Loop, or  ffplay -loop 0 -fs " + f'"{reel}"')

    for part in a.gif:
        pick = [p for p in parts if part in p.name]
        if not pick:
            print(f"--gif: no clip name contains '{part}', skipped")
            continue
        gif = reel_dir / (pick[0].name.split(".thr")[0] + ".gif")
        ffmpeg("-t", str(a.gif_seconds), "-i", str(pick[0]), "-vf",
               f"fps=10,scale={a.gif_width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];"
               "[b][p]paletteuse=dither=bayer:bayer_scale=4", "-loop", "0", str(gif))
        print(f"gif:  {gif}  ({os.path.getsize(gif) // 1024} KB)")

if __name__ == "__main__":
    main()
