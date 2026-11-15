#!/usr/bin/env python3
"""Build the v4 pothole training set from the labelled Detroit train frames.

Adds road-band full-res tiles, hard-example duplication (needs --model) and
copy-paste synthetic potholes. Split is by video id so nothing leaks.
Only numpy + opencv + ultralytics + stdlib.
"""
import argparse
import math
import random
import shutil
from collections import Counter
from pathlib import Path

import cv2
import numpy as np

BAND_Y0, BAND_Y1 = 0.35, 0.95
IMG_EXT = {".jpg", ".jpeg", ".png"}


def video_id(stem):
    s = stem[len("crowd_"):] if stem.startswith("crowd_") else stem
    return s.rsplit("_", 1)[0] if "_" in s else s


def read_labels(path, W, H):
    boxes = []
    if path.exists():
        for ln in path.read_text().splitlines():
            p = ln.split()
            if len(p) < 5:
                continue
            cx, cy, w, h = (float(v) for v in p[1:5])
            boxes.append([(cx - w / 2) * W, (cy - h / 2) * H, (cx + w / 2) * W, (cy + h / 2) * H])
    return boxes


def iou(a, b):
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    i = ix * iy
    u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i
    return i / u if u > 0 else 0.0


def tile_origins(W, H, tile):
    y0, y1 = int(BAND_Y0 * H), int(BAND_Y1 * H)
    ts = min(tile, y1 - y0, W)
    n = 1 if W <= ts else math.ceil((W - ts) / (ts * 0.85)) + 1  # >=15% overlap
    xs = [0] if n == 1 else [round(i * (W - ts) / (n - 1)) for i in range(n)]
    return [(x, y0) for x in xs], ts


def remap_to_tile(boxes, x0, y0, ts):
    out = []
    for b in boxes:
        cx0, cy0 = max(b[0], x0), max(b[1], y0)
        cx1, cy1 = min(b[2], x0 + ts), min(b[3], y0 + ts)
        if cx1 <= cx0 or cy1 <= cy0:
            continue
        area = (b[2] - b[0]) * (b[3] - b[1])
        if area <= 0 or (cx1 - cx0) * (cy1 - cy0) < 0.5 * area:
            continue
        if cx1 - cx0 < 4 or cy1 - cy0 < 4:
            continue
        out.append([cx0 - x0, cy0 - y0, cx1 - x0, cy1 - y0])
    return out


def label_text(boxes, W, H):
    lines = []
    for b in boxes:
        x0, y0, x1, y1 = max(0, b[0]), max(0, b[1]), min(W, b[2]), min(H, b[3])
        if x1 - x0 < 1 or y1 - y0 < 1:
            continue
        lines.append("0 %.6f %.6f %.6f %.6f" % ((x0 + x1) / 2 / W, (y0 + y1) / 2 / H, (x1 - x0) / W, (y1 - y0) / H))
    return "\n".join(lines) + ("\n" if lines else "")


def lum(img):
    return float(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).mean())


def road_mask_integral(img):
    """Cheap road-like mask (low saturation, mid brightness, smooth texture) as an integral image."""
    hsv = cv2.cvtColor(cv2.GaussianBlur(img, (0, 0), 3), cv2.COLOR_BGR2HSV)
    g = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (0, 0), 1.5)
    mag = np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0)) + np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1))
    mag = cv2.blur(mag, (15, 15))
    m = (hsv[..., 1] < 40) & ~((hsv[..., 0] > 25) & (hsv[..., 0] < 95) & (hsv[..., 1] > 18)) & (hsv[..., 2] > 55) & (hsv[..., 2] < 180) & (mag < 13)
    return cv2.integral(m.astype(np.uint8))


def road_frac(ii, b, W, H, grow=1.4):
    cx, cy, w, h = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2, (b[2] - b[0]) * grow, (b[3] - b[1]) * grow
    x0, x1 = int(max(0, cx - w / 2)), int(min(W, cx + w / 2))
    y0, y1 = int(max(0, cy - h / 2)), int(min(H, cy + h / 2))
    if x1 <= x0 or y1 <= y0:
        return 0.0
    return (ii[y1, x1] - ii[y0, x1] - ii[y1, x0] + ii[y0, x0]) / float((x1 - x0) * (y1 - y0))


def make_paste(img, crops, n, rng):
    """Paste n random crops into img (copy). Returns (img, boxes)."""
    H, W = img.shape[:2]
    out = img.copy()
    boxes = []
    ii = road_mask_integral(img)
    for _ in range(n):
        for _attempt in range(300):
            crop, (bx0, by0, bx1, by1) = rng.choice(crops)
            yb = rng.uniform(0.55, 0.95)
            f = 0.4 + 0.6 * (yb - 0.55) / 0.40
            hbox = f * math.exp(rng.uniform(math.log(0.0375), math.log(0.10))) * H
            hbox = min(max(hbox, 0.015 * H), 0.10 * H)
            s = hbox / max(1.0, by1 - by0)
            ch, cw = crop.shape[:2]
            nw, nh = max(4, int(round(cw * s))), max(4, int(round(ch * s)))
            bw, bh = (bx1 - bx0) * s, (by1 - by0) * s
            if bw < 4 or bw > 0.5 * W:
                continue
            # box bottom at yb*H, box left random
            top_box = yb * H - bh
            left_box = rng.uniform(0.02 * W, 0.98 * W - bw)
            ox = left_box - bx0 * s
            oy = top_box - by0 * s
            nb = [left_box, top_box, left_box + bw, top_box + bh]
            if any(iou(nb, o) > 0 or (nb[0] < o[2] and nb[2] > o[0] and nb[1] < o[3] and nb[3] > o[1]) for o in boxes):
                continue
            if road_frac(ii, nb, W, H) < 0.9:  # only paste onto road-looking pixels
                continue
            rc = cv2.resize(crop, (nw, nh), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
            # feathered elliptical alpha
            m = np.zeros((nh, nw), np.float32)
            cv2.ellipse(m, (nw // 2, nh // 2), (max(1, int(nw * 0.55)), max(1, int(nh * 0.55))), 0, 0, 360, 1.0, -1)
            m[:2, :] = m[-2:, :] = 0
            m[:, :2] = m[:, -2:] = 0
            sig = max(1.0, 0.07 * min(nw, nh))
            m = cv2.GaussianBlur(m, (0, 0), sig)
            # place with clipping
            px0, py0 = int(round(ox)), int(round(oy))
            dx0, dy0 = max(0, px0), max(0, py0)
            dx1, dy1 = min(W, px0 + nw), min(H, py0 + nh)
            if dx1 - dx0 < 4 or dy1 - dy0 < 4:
                continue
            rc = rc[dy0 - py0:dy1 - py0, dx0 - px0:dx1 - px0]
            m = m[dy0 - py0:dy1 - py0, dx0 - px0:dx1 - px0]
            dst = out[dy0:dy1, dx0:dx1].astype(np.float32)
            ratio = float(np.clip(lum(dst.astype(np.uint8)) / max(1.0, lum(rc)), 0.7, 1.3))
            src = np.clip(rc.astype(np.float32) * ratio, 0, 255)
            a = m[..., None]
            out[dy0:dy1, dx0:dx1] = (src * a + dst * (1 - a)).astype(np.uint8)
            boxes.append(nb)
            break
    return out, boxes


def draw(img, boxes, color=(0, 0, 255)):
    im = img.copy()
    for b in boxes:
        cv2.rectangle(im, (int(b[0]), int(b[1])), (int(b[2]), int(b[3])), color, 2)
    return im


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--images", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--tile", type=int, default=640)
    ap.add_argument("--paste-per-frame", type=int, default=2)
    ap.add_argument("--paste-frames", type=int, default=400)
    ap.add_argument("--conf", type=float, default=0.25)
    a = ap.parse_args()

    rng = random.Random(a.seed)
    out = Path(a.out)
    for sp in ("train", "val"):
        for k in ("images", "labels"):
            (out / k / sp).mkdir(parents=True, exist_ok=True)
    (out / "samples").mkdir(exist_ok=True)

    imgs = sorted(p for p in Path(a.images).iterdir() if p.suffix.lower() in IMG_EXT)
    vids = sorted({video_id(p.stem) for p in imgs})
    rng.shuffle(vids)
    nval = max(1, round(0.15 * len(vids))) if len(vids) > 1 else 0
    val_vids = set(vids[:nval])
    print(f"{len(imgs)} images, {len(vids)} videos, {len(val_vids)} val videos")

    recs = []  # dict(name, split, kind, boxes, hard)

    def emit(img, boxes, name, split, kind, hard=False):
        H, W = img.shape[:2]
        cv2.imwrite(str(out / "images" / split / name), img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        (out / "labels" / split / (Path(name).stem + ".txt")).write_text(label_text(boxes, W, H))
        recs.append(dict(name=name, split=split, kind=kind, boxes=boxes, hard=hard, size=(W, H)))

    # load GT
    gt = {}
    sizes = {}
    for p in imgs:
        im = cv2.imread(str(p))
        if im is None:
            continue
        H, W = im.shape[:2]
        sizes[p] = (W, H)
        gt[p] = read_labels(Path(a.labels) / (p.stem + ".txt"), W, H)
    imgs = [p for p in imgs if p in gt]
    train_imgs = [p for p in imgs if video_id(p.stem) not in val_vids]

    # hard-example mining
    fp_frames, miss_frames = set(), set()
    if a.model:
        import torch
        from ultralytics import YOLO
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        model = YOLO(a.model)
        for i in range(0, len(train_imgs), 16):
            chunk = train_imgs[i:i + 16]
            for p, r in zip(chunk, model.predict([str(c) for c in chunk], imgsz=640, conf=a.conf, device=dev, verbose=False)):
                preds = r.boxes.xyxy.cpu().numpy().tolist() if r.boxes is not None else []
                g = gt[p]
                if any(all(iou(pb, gb) < 0.3 for gb in g) for pb in preds):
                    fp_frames.add(p)
                if any(all(iou(pb, gb) < 0.3 for pb in preds) for gb in g):
                    miss_frames.add(p)
        print(f"hard mining: {len(fp_frames)} FP frames, {len(miss_frames)} miss frames")

    # originals + tiles
    crops = []
    for p in imgs:
        img = cv2.imread(str(p))
        W, H = sizes[p]
        split = "val" if video_id(p.stem) in val_vids else "train"
        boxes = gt[p]
        origins, ts = tile_origins(W, H, a.tile)
        variants = [("", img, boxes)]
        for i, (x0, y0) in enumerate(origins):
            variants.append((f"tile{i}__", img[y0:y0 + ts, x0:x0 + ts], remap_to_tile(boxes, x0, y0, ts)))
        for pre, im, bx in variants:
            kind = "tile" if pre else "orig"
            emit(im, bx, f"{pre}{p.name}", split, kind, hard=(p in fp_frames))
        if split == "train":
            hard = p in fp_frames or p in miss_frames
            if hard:
                tag = "hneg" if p in fp_frames else "miss"
                for k in range(1, 4):
                    for pre, im, bx in variants:
                        nm = f"{tag}{k}_{pre.rstrip('_')}__{p.name}" if pre else f"{tag}{k}__{p.name}"
                        emit(im, bx, nm, split, f"dup_{tag}", hard=(p in fp_frames))
            for b in boxes:
                bw, bh = b[2] - b[0], b[3] - b[1]
                x0, y0 = int(max(0, b[0] - 0.1 * bw)), int(max(0, b[1] - 0.1 * bh))
                x1, y1 = int(min(W, b[2] + 0.1 * bw)), int(min(H, b[3] + 0.1 * bh))
                if x1 - x0 >= 6 and y1 - y0 >= 6 and bh >= 6:
                    crops.append((img[y0:y1, x0:x1].copy(), (b[0] - x0, b[1] - y0, b[2] - x0, b[3] - y0)))

    # copy-paste
    empties = [p for p in train_imgs if not gt[p]]
    rng.shuffle(empties)
    n_paste_imgs = 0
    if crops:
        for p in empties[:a.paste_frames]:
            img = cv2.imread(str(p))
            pimg, pb = make_paste(img, crops, a.paste_per_frame, rng)
            if not pb:
                continue
            emit(pimg, pb, f"paste__{p.stem}__0.jpg", "train", "paste")
            n_paste_imgs += 1

    # negative cap
    tr = [r for r in recs if r["split"] == "train"]
    E = [r for r in tr if not r["boxes"]]
    dropped = 0
    if len(E) > 0.45 * len(tr):
        d = math.ceil((len(E) - 0.45 * len(tr)) / 0.55)
        cand = [r for r in E if not r["hard"] and r["kind"] != "orig"]  # keep every original
        rng.shuffle(cand)
        for r in cand[:d]:
            (out / "images" / "train" / r["name"]).unlink()
            (out / "labels" / "train" / (Path(r["name"]).stem + ".txt")).unlink()
            recs.remove(r)
            dropped += 1

    # verify + report
    def stats(split):
        rs = [r for r in recs if r["split"] == split]
        c = Counter(r["kind"] for r in rs)
        nb = sum(len(r["boxes"]) for r in rs)
        ne = sum(1 for r in rs if not r["boxes"])
        return rs, c, nb, ne

    lines = ["# v4 dataset build report", "",
             f"- source images: {len(imgs)} ({len(train_imgs)} train, {len(imgs) - len(train_imgs)} val); videos {len(vids)} (val {len(val_vids)})",
             f"- seed {a.seed}, tile {a.tile}, conf {a.conf}, model {a.model}",
             f"- hard mining: {len(fp_frames)} false-positive frames (hard negatives), {len(miss_frames)} frames with a missed GT box; each duplicated x3 with its tiles",
             f"- copy-paste: {len(crops)} crops, {n_paste_imgs} pasted frames, {sum(len(r['boxes']) for r in recs if r['kind'] == 'paste')} pasted boxes",
             f"- negative cap (45%): dropped {dropped} plain-empty train images", ""]
    for sp in ("train", "val"):
        rs, c, nb, ne = stats(sp)
        lines.append(f"## {sp}: {len(rs)} images, {nb} boxes, {ne} empty ({100 * ne / max(1, len(rs)):.1f}%)")
        for k, v in sorted(c.items()):
            lines.append(f"- {k}: {v}")
        lines.append("")
    rep = "\n".join(lines)
    (out / "build_report.md").write_text(rep)
    (out / "data.yaml").write_text(f"path: {out.resolve()}\ntrain: images/train\nval: images/val\nnc: 1\nnames: [pothole]\n")

    # samples
    def pick(kind, n, need_boxes=True):
        pool = [r for r in recs if r["kind"] == kind and (r["boxes"] or not need_boxes)]
        rng.shuffle(pool)
        return pool[:n]
    for tag, kind in (("orig", "orig"), ("tile", "tile"), ("paste", "paste")):
        for i, r in enumerate(pick(kind, 4)):
            im = cv2.imread(str(out / "images" / r["split"] / r["name"]))
            cv2.imwrite(str(out / "samples" / f"{tag}_{i}.png"), draw(im, r["boxes"]))
    print(rep)


if __name__ == "__main__":
    main()
