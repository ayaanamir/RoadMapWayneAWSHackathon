#!/usr/bin/env python3
"""Score pothole detectors on the same labelled test frames.

Usage:
  python eval_models.py --images DIR --labels DIR --out DIR \
      --model rdd.pt:3 --model live.onnx [--modes 640,960,road2x] [--device cpu]

Test set is YOLO format: labels/<same relative path>.txt per image, class 0 =
pothole, empty or missing file = no pothole. MODEL[:ids] picks which predicted
class ids count as pothole (default all). Modes: "640"/"960" = plain predict at
that size; "road2x" = crop the road band (y 35%..95%), two overlapping tiles
(15% overlap) at 640, boxes mapped back and merged with NMS.
Writes report.md, results.json and worst_errors.html (top model) into --out.
"""
import argparse
import html
import json
import os
import time

import numpy as np

THRS = [round(0.05 * i, 2) for i in range(1, 19)]  # 0.05 .. 0.90
MATCH_IOU = 0.3
IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def iou_matrix(a, b):
    """IoU between (N,4) and (M,4) xyxy arrays."""
    if len(a) == 0 or len(b) == 0:
        return np.zeros((len(a), len(b)))
    x1 = np.maximum(a[:, None, 0], b[None, :, 0])
    y1 = np.maximum(a[:, None, 1], b[None, :, 1])
    x2 = np.minimum(a[:, None, 2], b[None, :, 2])
    y2 = np.minimum(a[:, None, 3], b[None, :, 3])
    inter = np.clip(x2 - x1, 0, None) * np.clip(y2 - y1, 0, None)
    aa = (a[:, 2] - a[:, 0]) * (a[:, 3] - a[:, 1])
    ab = (b[:, 2] - b[:, 0]) * (b[:, 3] - b[:, 1])
    return inter / (aa[:, None] + ab[None, :] - inter + 1e-9)


def nms(boxes, scores, thr=0.5):
    order = np.argsort(-scores)
    keep = []
    while len(order):
        i = order[0]
        keep.append(i)
        if len(order) == 1:
            break
        ious = iou_matrix(boxes[i:i + 1], boxes[order[1:]])[0]
        order = order[1:][ious < thr]
    return np.array(keep, dtype=int)


def list_images(root):
    out = []
    for d, _, files in os.walk(root):
        for f in files:
            if os.path.splitext(f)[1].lower() in IMG_EXT:
                out.append(os.path.relpath(os.path.join(d, f), root))
    return sorted(out)


def read_gt(labels_dir, rel, w, h):
    """YOLO txt -> (N,4) pixel xyxy of class-0 boxes. Missing file = empty."""
    path = os.path.join(labels_dir, os.path.splitext(rel)[0] + ".txt")
    boxes = []
    if os.path.exists(path):
        for line in open(path):
            p = line.split()
            if len(p) < 5 or int(float(p[0])) != 0:
                continue
            cx, cy, bw, bh = (float(v) for v in p[1:5])
            boxes.append([(cx - bw / 2) * w, (cy - bh / 2) * h,
                          (cx + bw / 2) * w, (cy + bh / 2) * h])
    return np.array(boxes, dtype=float).reshape(-1, 4)


def parse_model(spec):
    path, ids = spec, None
    if ":" in spec:
        head, tail = spec.rsplit(":", 1)
        if tail and all(t.isdigit() for t in tail.split(",")):
            path, ids = head, {int(t) for t in tail.split(",")}
    return path, ids


def run_model(model, img, ids, mode, device):
    """Return (boxes (N,4), scores (N,)) in full-frame pixel coords."""
    h, w = img.shape[:2]

    def predict(im, size):
        r = model.predict(im, imgsz=size, conf=0.01, iou=0.5, device=device, verbose=False)[0]
        if r.boxes is None or len(r.boxes) == 0:
            return np.zeros((0, 4)), np.zeros(0)
        b = r.boxes.xyxy.cpu().numpy()
        s = r.boxes.conf.cpu().numpy()
        c = r.boxes.cls.cpu().numpy().astype(int)
        if ids is not None:
            m = np.isin(c, list(ids))
            b, s = b[m], s[m]
        return b, s

    if mode in ("640", "960"):
        return predict(img, int(mode))
    if mode == "road2x":
        y0, y1 = int(h * 0.35), int(h * 0.95)
        tiles = [(0, int(w * 0.575)), (int(w * 0.425), w)]
        all_b, all_s = [], []
        for x0, x1 in tiles:
            b, s = predict(img[y0:y1, x0:x1], 640)
            b = b.copy()
            b[:, [0, 2]] += x0
            b[:, [1, 3]] += y0
            all_b.append(b)
            all_s.append(s)
        b, s = np.concatenate(all_b), np.concatenate(all_s)
        if len(b):
            k = nms(b, s, 0.5)
            b, s = b[k], s[k]
        return b, s
    raise SystemExit(f"unknown mode '{mode}' (use 640, 960, road2x)")


def match(pred_b, pred_s, gt, thr):
    """Greedy by score. Returns (tp flags per kept pred, matched gt flags, kept idx)."""
    keep = np.where(pred_s >= thr)[0]
    keep = keep[np.argsort(-pred_s[keep])]
    used = np.zeros(len(gt), bool)
    tp = np.zeros(len(keep), bool)
    ious = iou_matrix(pred_b[keep], gt)
    for n in range(len(keep)):
        if len(gt) == 0:
            break
        cand = np.where(~used & (ious[n] >= MATCH_IOU))[0]
        if len(cand):
            j = cand[np.argmax(ious[n][cand])]
            used[j] = True
            tp[n] = True
    return tp, used, keep


def prf(tp, fp, fn):
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return p, r, f


def sweep(preds, gts):
    rows = []
    for thr in THRS:
        tp = fp = fn = ftp = ffp = ffn = 0
        for (b, s), gt in zip(preds, gts):
            t, used, keep = match(b, s, gt, thr)
            tp += int(t.sum()); fp += int((~t).sum()); fn += int((~used).sum())
            pos, pred_pos = len(gt) > 0, len(keep) > 0
            ftp += pos and pred_pos; ffp += (not pos) and pred_pos; ffn += pos and not pred_pos
        bp, br, bf = prf(tp, fp, fn)
        fp_, fr, ff = prf(ftp, ffp, ffn)
        rows.append(dict(thr=thr, box_p=bp, box_r=br, box_f1=bf,
                         frame_p=fp_, frame_r=fr, frame_f1=ff,
                         tp=tp, fp=fp, fn=fn))
    return rows


def summarize(rows, ms):
    best = max(rows, key=lambda r: r["box_f1"])
    ok = [r["box_r"] for r in rows if r["box_p"] >= 0.8 and r["tp"] > 0]
    return dict(best_f1=best["box_f1"], thr=best["thr"], box_p=best["box_p"], box_r=best["box_r"],
                frame_p=best["frame_p"], frame_r=best["frame_r"],
                recall_at_p80=max(ok) if ok else None, ms=ms)


def write_errors(path, out_dir, images_dir, rels, sizes, preds, gts, thr, title):
    """HTML sheet: 30 highest-scoring false positives and 30 missed GT boxes."""
    fps, misses = [], []
    for i, ((b, s), gt) in enumerate(zip(preds, gts)):
        tp, used, keep = match(b, s, gt, thr)
        for n, k in enumerate(keep):
            if not tp[n]:
                fps.append((float(s[k]), i, b[k]))
        for j in np.where(~used)[0]:
            misses.append((0.0, i, gt[j]))
    fps.sort(key=lambda x: -x[0])
    parts = [f"<html><body style='font-family:sans-serif'><h1>{html.escape(title)} at conf {thr}</h1>"
             "<style>.c{display:inline-block;margin:6px;vertical-align:top}"
             ".w{position:relative;display:inline-block}.w img{width:320px;display:block}"
             ".b{position:absolute;border:2px solid red;box-sizing:border-box}"
             ".g{border-color:lime}</style>"]

    def card(items, cls, label):
        for score, i, box in items:
            w, h = sizes[i]
            src = html.escape(os.path.relpath(os.path.join(images_dir, rels[i]), out_dir))
            st = (f"left:{box[0]/w*100:.2f}%;top:{box[1]/h*100:.2f}%;"
                  f"width:{(box[2]-box[0])/w*100:.2f}%;height:{(box[3]-box[1])/h*100:.2f}%")
            cap = f"{label} {score:.2f}" if score else label
            parts.append(f"<div class=c><div class=w><img src='{src}'>"
                         f"<div class='b {cls}' style='{st}'></div></div>"
                         f"<div>{cap} {html.escape(rels[i])}</div></div>")

    parts.append(f"<h2>Top {min(30, len(fps))} false positives (red)</h2>")
    card(fps[:30], "", "FP")
    parts.append(f"<h2>First {min(30, len(misses))} of {len(misses)} missed GT boxes (green)</h2>")
    card(misses[:30], "g", "MISS")
    parts.append("</body></html>")
    open(path, "w").write("\n".join(parts))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", action="append", required=True, help="PATH[:class_ids], repeatable")
    ap.add_argument("--modes", default="640,960,road2x")
    ap.add_argument("--device", default="cpu")
    a = ap.parse_args()

    import cv2
    from ultralytics import YOLO

    rels = list_images(a.images)
    if not rels:
        raise SystemExit(f"no images found in {a.images}")
    os.makedirs(a.out, exist_ok=True)
    imgs = [cv2.imread(os.path.join(a.images, r)) for r in rels]
    bad = [r for r, im in zip(rels, imgs) if im is None]
    if bad:
        raise SystemExit(f"cannot read image(s): {bad[:3]}")
    sizes = [(im.shape[1], im.shape[0]) for im in imgs]
    gts = [read_gt(a.labels, r, *sz) for r, sz in zip(rels, sizes)]
    n_gt = sum(len(g) for g in gts)
    n_pos = sum(len(g) > 0 for g in gts)
    print(f"{len(rels)} images, {n_pos} with potholes, {n_gt} GT boxes")

    results, all_preds = [], {}
    for spec in a.model:
        path, ids = parse_model(spec)
        if not os.path.exists(path):
            raise SystemExit(f"model not found: {path}")
        model = YOLO(path, task="detect")
        for mode in a.modes.split(","):
            mode = mode.strip()
            run_model(model, imgs[0], ids, mode, a.device)  # warm-up, not timed
            preds, t0 = [], time.time()
            for im in imgs:
                preds.append(run_model(model, im, ids, mode, a.device))
            ms = (time.time() - t0) / len(imgs) * 1000
            rows = sweep(preds, gts)
            name = f"{os.path.basename(path)}{':' + ','.join(map(str, sorted(ids))) if ids else ''} [{mode}]"
            res = dict(name=name, model=spec, mode=mode, curve=rows, **summarize(rows, ms))
            results.append(res)
            all_preds[name] = preds
            print(f"{name}: best F1 {res['best_f1']:.3f} @ {res['thr']} ({ms:.0f} ms/img)")

    results.sort(key=lambda r: -r["best_f1"])
    json.dump(dict(n_images=len(rels), n_positive_frames=n_pos, n_gt_boxes=n_gt, results=results),
              open(os.path.join(a.out, "results.json"), "w"), indent=1)

    pct = lambda v: "-" if v is None else f"{v:.2f}"
    lines = [f"# Model scoreboard", "",
             f"Test set: {len(rels)} frames, {n_pos} with potholes, {n_gt} GT boxes. "
             f"Box match IoU >= {MATCH_IOU}, conf swept 0.05-0.90.", "",
             "| # | model [mode] | best box F1 | thr | box P | box R | frame P | frame R | recall @ P>=0.8 | ms/img |",
             "|---|---|---|---|---|---|---|---|---|---|"]
    for i, r in enumerate(results, 1):
        lines.append(f"| {i} | {r['name']} | {r['best_f1']:.3f} | {r['thr']} | {r['box_p']:.2f} | {r['box_r']:.2f} "
                     f"| {r['frame_p']:.2f} | {r['frame_r']:.2f} | {pct(r['recall_at_p80'])} | {r['ms']:.0f} |")
    top = results[0]
    base = {}
    for r in results:
        base.setdefault(r["model"], {})[r["mode"]] = r
    tiling = ""
    for m, d in base.items():
        if "road2x" in d and "640" in d:
            delta = d["road2x"]["best_f1"] - d["640"]["best_f1"]
            tiling += (f" For {os.path.basename(parse_model(m)[0])}, road-band tiling "
                       f"{'helped' if delta > 0 else 'did not help'} ({delta:+.3f} F1 vs plain 640).")
    lines += ["", "## Verdict", "",
              f"Best on this set is {top['name']} with box F1 {top['best_f1']:.3f} at conf {top['thr']} "
              f"(box precision {top['box_p']:.2f}, recall {top['box_r']:.2f}; frame-level precision "
              f"{top['frame_p']:.2f}, recall {top['frame_r']:.2f}), taking {top['ms']:.0f} ms per image.{tiling} "
              f"Small test sets are noisy, so trust the ranking only as far as the labels are trustworthy."]
    open(os.path.join(a.out, "report.md"), "w").write("\n".join(lines) + "\n")

    write_errors(os.path.join(a.out, "worst_errors.html"), a.out, a.images, rels, sizes,
                 all_preds[top["name"]], gts, top["thr"], top["name"])
    print(f"wrote report.md, results.json, worst_errors.html to {a.out}")


if __name__ == "__main__":
    main()
