#!/usr/bin/env python3
"""Turn close-up pothole photos into synthetic dash-cam training examples.

Cuts each boxed pothole out of a source photo (soft elliptical/GrabCut alpha), squashes it into a
dash-cam perspective, matches colour/sharpness to a pothole-free Detroit dash-cam frame, and pastes it
small onto the road band. Writes YOLO images/labels + samples.png + summary.json.

python3 city_paste.py --src-images DIR --src-labels DIR --dest-images DIR --dest-labels DIR --out DIR
       [--pair IMG LAB ...] [--n-out 600] [--per-frame 2] [--seed 0]
"""
import argparse, glob, json, os, random
import cv2
import numpy as np

IMG_EXT = (".jpg", ".jpeg", ".png")


def read_boxes(lab):
    out = []
    if os.path.exists(lab):
        for ln in open(lab):
            p = ln.split()
            if len(p) >= 5:
                out.append(tuple(map(float, p[1:5])))
    return out


def list_pairs(img_dir, lab_dir):
    for f in sorted(glob.glob(os.path.join(img_dir, "*"))):
        if f.lower().endswith(IMG_EXT):
            yield f, os.path.join(lab_dir, os.path.splitext(os.path.basename(f))[0] + ".txt")


def load_sources(pairs, min_px=10):
    srcs = []
    for idir, ldir in pairs:
        for f, lab in list_pairs(idir, ldir):
            boxes = read_boxes(lab)
            if not boxes:
                continue
            im = cv2.imread(f)
            if im is None:
                continue
            H, W = im.shape[:2]
            for cx, cy, w, h in boxes:
                bw, bh = w * W, h * H
                if bw < min_px or bh < min_px:
                    continue
                srcs.append((os.path.basename(f), im, (cx * W, cy * H, bw, bh)))
    return srcs


def cut_pothole(im, box, rng):
    """-> (bgr crop, alpha float32 0..1) with 15% padding, or None."""
    cx, cy, bw, bh = box
    H, W = im.shape[:2]
    x0 = int(max(0, cx - bw / 2 - 0.15 * bw)); x1 = int(min(W, cx + bw / 2 + 0.15 * bw))
    y0 = int(max(0, cy - bh / 2 - 0.15 * bh)); y1 = int(min(H, cy + bh / 2 + 0.15 * bh))
    crop = im[y0:y1, x0:x1].copy()
    ch, cw = crop.shape[:2]
    if ch < 8 or cw < 8:
        return None
    ex, ey = cx - x0, cy - y0
    ell = np.zeros((ch, cw), np.uint8)
    cv2.ellipse(ell, (int(ex), int(ey)), (max(2, int(bw / 2)), max(2, int(bh / 2))), 0, 0, 360, 255, -1)
    alpha = ell.astype(np.float32) / 255
    if min(ch, cw) >= 24:  # GrabCut refine, seeded by the ellipse
        try:
            gm = np.full((ch, cw), cv2.GC_BGD, np.uint8)
            gm[ell > 0] = cv2.GC_PR_FGD
            core = np.zeros_like(ell)
            cv2.ellipse(core, (int(ex), int(ey)), (max(1, int(bw * 0.3)), max(1, int(bh * 0.3))), 0, 0, 360, 255, -1)
            gm[core > 0] = cv2.GC_FGD
            bgd = np.zeros((1, 65), np.float64); fgd = np.zeros((1, 65), np.float64)
            cv2.grabCut(crop, gm, None, bgd, fgd, 3, cv2.GC_INIT_WITH_MASK)
            fg = ((gm == cv2.GC_FGD) | (gm == cv2.GC_PR_FGD)).astype(np.uint8)
            fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
            if 0.3 * (ell > 0).sum() < fg.sum() <= 1.05 * (ell > 0).sum():
                alpha = fg.astype(np.float32)
        except cv2.error:
            pass
    k = int(0.08 * max(ch, cw)) | 1
    alpha = cv2.GaussianBlur(alpha, (k * 2 + 1, k * 2 + 1), k / 2.0)
    alpha = np.clip(alpha * (cv2.GaussianBlur((ell > 0).astype(np.float32), (k * 2 + 1, k * 2 + 1), k / 2.0)), 0, 1)
    return crop, alpha


def warp_dashcam(crop, alpha, rng):
    """Squash vertically + trapezoid; returns BGR, alpha cropped to alpha bbox."""
    ch, cw = crop.shape[:2]
    f = rng.uniform(0.25, 0.5)
    nh = max(4, int(ch * f))
    top = rng.uniform(0.80, 0.95)
    src = np.float32([[0, 0], [cw, 0], [cw, ch], [0, ch]])
    inset = (1 - top) / 2 * cw
    dst = np.float32([[inset, 0], [cw - inset, 0], [cw, nh], [0, nh]])
    M = cv2.getPerspectiveTransform(src, dst)
    rgba = np.dstack([crop.astype(np.float32), alpha * 255])
    w = cv2.warpPerspective(rgba, M, (cw, nh), flags=cv2.INTER_AREA if False else cv2.INTER_LINEAR)
    a = w[..., 3] / 255
    ys, xs = np.where(a > 0.5)
    if len(xs) < 4:
        return None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    return w[y0:y1, x0:x1, :3], a[y0:y1, x0:x1]


def lap_var(g):
    return float(cv2.Laplacian(g, cv2.CV_32F).var())


def reinhard(crop, a, patch):
    c = cv2.cvtColor(crop.astype(np.uint8), cv2.COLOR_BGR2LAB).astype(np.float32)
    p = cv2.cvtColor(patch, cv2.COLOR_BGR2LAB).astype(np.float32).reshape(-1, 3)
    m = a > 0.5
    cp = c[m] if m.sum() > 10 else c.reshape(-1, 3)
    cm, cs = cp.mean(0), cp.std(0) + 1e-3
    pm, ps = p.mean(0), p.std(0) + 1e-3
    matched = (c - cm) / cs * ps + pm
    out = 0.7 * matched + 0.3 * c
    out = cv2.cvtColor(np.clip(out, 0, 255).astype(np.uint8), cv2.COLOR_LAB2BGR)
    return out.astype(np.float32)


def road_mask_integral(img):
    """Cheap road-like mask (low saturation, mid brightness, smooth texture) as an integral image.
    Same test as build_v4_data.py so pasted city potholes only land on road-looking pixels."""
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


def iou_overlap(a, b, pad=6):
    return not (a[2] + pad < b[0] or b[2] + pad < a[0] or a[3] + pad < b[1] or b[3] + pad < a[1])


def paste_one(frame, ii, srcs, boxes_done, rng, tries=200):
    H, W = frame.shape[:2]
    for _ in range(tries):
        # cheap placement test first (one integral lookup) — the strict road mask rejects
        # most spots, so the GrabCut/warp below must only run on accepted spots.
        yc = rng.uniform(0.58, 0.95)
        xc = rng.uniform(0.15, 0.85)
        frac = 0.025 + (0.12 - 0.025) * (yc - 0.58) / (0.95 - 0.58)
        tw = max(8, int(round(W * frac * rng.uniform(0.75, 1.25))))
        th = max(4, int(tw * 0.45))  # squashed-pothole estimate; exact box re-checked below
        cx, cy = int(xc * W), int(yc * H)
        bb = (cx - tw // 2, cy - th // 2, cx + tw // 2, cy + th // 2)
        if bb[0] < 0 or bb[1] < 0 or bb[2] > W or bb[3] > H:
            continue
        if any(iou_overlap(bb, b) for b in boxes_done):
            continue
        if road_frac(ii, bb, W, H) < 0.9:  # only paste onto road-looking pixels
            continue
        name, im, box = rng.choice(srcs)
        cut = cut_pothole(im, box, rng)
        if cut is None:
            continue
        wp = warp_dashcam(cut[0], cut[1], rng)
        if wp is None:
            continue
        crop, a = wp
        th = max(4, min(int(round(tw * crop.shape[0] / crop.shape[1])), int(tw * 0.8)))
        x0, y0 = cx - tw // 2, cy - th // 2
        x1, y1 = x0 + tw, y0 + th
        if x0 < 0 or y0 < 0 or x1 > W or y1 > H:
            continue
        bb = (x0, y0, x1, y1)
        if any(iou_overlap(bb, b) for b in boxes_done) or road_frac(ii, bb, W, H) < 0.85:
            continue
        mx, my = tw // 2, th // 2 + 4
        px0, py0, px1, py1 = max(0, x0 - mx), max(0, y0 - my), min(W, x1 + mx), min(H, y1 + my)
        patch = frame[py0:py1, px0:px1]
        rc = cv2.resize(crop, (tw, th), interpolation=cv2.INTER_AREA)
        ra = cv2.resize(a, (tw, th), interpolation=cv2.INTER_AREA)
        rc = reinhard(rc, ra, patch)
        dv = lap_var(cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY))
        sig = 0.0
        while sig < 3.0:
            g = cv2.cvtColor(np.clip(cv2.GaussianBlur(rc, (0, 0), sig) if sig else rc, 0, 255).astype(np.uint8), cv2.COLOR_BGR2GRAY)
            if lap_var(g) <= dv:
                break
            sig += 0.25
        if sig:
            rc = cv2.GaussianBlur(rc, (0, 0), sig)
            ra = cv2.GaussianBlur(ra, (0, 0), min(sig, 1.0))
        rc = rc + np.random.default_rng(rng.randrange(1 << 30)).normal(0, 2.0, rc.shape)
        roi = frame[y0:y1, x0:x1].astype(np.float32)
        frame[y0:y1, x0:x1] = np.clip(roi * (1 - ra[..., None]) + rc * ra[..., None], 0, 255).astype(np.uint8)
        ys, xs = np.where(ra > 0.5)
        if len(xs) < 2:
            continue
        bx0, bx1, by0, by1 = x0 + xs.min(), x0 + xs.max() + 1, y0 + ys.min(), y0 + ys.max() + 1
        boxes_done.append(bb)
        return (bx0, by0, bx1, by1), name, round(sig, 2)
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src-images"); ap.add_argument("--src-labels")
    ap.add_argument("--pair", nargs=2, action="append", default=[], metavar=("IMG", "LAB"))
    ap.add_argument("--dest-images", required=True); ap.add_argument("--dest-labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--n-out", type=int, default=600)
    ap.add_argument("--per-frame", type=int, default=2, choices=[1, 2, 3])
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    pairs = list(a.pair)
    if a.src_images and a.src_labels:
        pairs.append((a.src_images, a.src_labels))
    srcs = load_sources(pairs)
    if not srcs:
        raise SystemExit("no source potholes found")
    dests = [(f, os.path.splitext(os.path.basename(f))[0]) for f, lab in list_pairs(a.dest_images, a.dest_labels)
             if not read_boxes(lab)]
    if not dests:
        raise SystemExit("no empty-label destination frames")
    os.makedirs(os.path.join(a.out, "images"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "labels"), exist_ok=True)
    kcount, meta, written, pasted, failed = {}, [], 0, 0, 0
    order = []
    attempts = 0
    while written < a.n_out and attempts < a.n_out * 6:
        if not order:
            order = dests[:]; rng.shuffle(order)
        f, stem = order.pop()
        attempts += 1
        frame = cv2.imread(f)
        if frame is None:
            continue
        ii = road_mask_integral(frame)
        H, W = frame.shape[:2]
        done, res = [], []
        for _ in range(rng.randint(1, a.per_frame)):
            r = paste_one(frame, ii, srcs, done, rng)
            if r:
                res.append(r)
        if not res:
            failed += 1
            continue
        k = kcount.get(stem, 0); kcount[stem] = k + 1
        name = f"citypaste__{stem}__{k}"
        q = rng.randint(70, 85)
        ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, q])
        frame = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        cv2.imwrite(os.path.join(a.out, "images", name + ".jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 95])
        with open(os.path.join(a.out, "labels", name + ".txt"), "w") as fh:
            for (x0, y0, x1, y1), src, sig in res:
                fh.write(f"0 {(x0+x1)/2/W:.6f} {(y0+y1)/2/H:.6f} {(x1-x0)/W:.6f} {(y1-y0)/H:.6f}\n")
                meta.append(dict(image=name, box=[int(x0), int(y0), int(x1), int(y1)], src=src, blur=sig, wfrac=round((x1 - x0) / W, 4), yc=round((y0 + y1) / 2 / H, 3)))
        written += 1
        pasted += len(res)
        if written % 50 == 0:
            print(f"  {written}/{a.n_out} images, {pasted} pastes, {failed} frames failed", flush=True)
        # keep the frame (pre-write) for samples
        for m in meta[-len(res):]:
            m["_frame"] = frame
    # samples grid
    pick = rng.sample(meta, min(16, len(meta)))
    tiles = []
    for m in pick:
        fr = m["_frame"].copy(); x0, y0, x1, y1 = m["box"]
        H, W = fr.shape[:2]
        half = max(80, int((x1 - x0) * 3))
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        wx0, wy0 = int(np.clip(cx - half, 0, max(0, W - 2 * half))), int(np.clip(cy - half, 0, max(0, H - 2 * half)))
        t = fr[wy0:wy0 + 2 * half, wx0:wx0 + 2 * half].copy()
        t = cv2.resize(t, (256, 256), interpolation=cv2.INTER_CUBIC)
        s = 256 / (2 * half)
        cv2.rectangle(t, (int((x0 - wx0) * s) - 2, int((y0 - wy0) * s) - 2), (int((x1 - wx0) * s) + 2, int((y1 - wy0) * s) + 2), (0, 255, 0), 1)
        tiles.append(t)
    while len(tiles) < 16:
        tiles.append(np.zeros((256, 256, 3), np.uint8))
    grid = np.vstack([np.hstack(tiles[i * 4:(i + 1) * 4]) for i in range(4)])
    cv2.imwrite(os.path.join(a.out, "samples.png"), grid)
    for m in meta:
        m.pop("_frame", None)
    ws = [m["wfrac"] for m in meta]
    summ = dict(n_sources=len(srcs), n_dest_frames=len(dests), n_images=written, n_pastes=pasted,
                frames_failed=failed, width_frac_mean=round(float(np.mean(ws)), 4) if ws else None,
                width_frac_min=min(ws) if ws else None, width_frac_max=max(ws) if ws else None,
                mean_blur_sigma=round(float(np.mean([m["blur"] for m in meta])), 2) if meta else None, seed=a.seed)
    json.dump(summ, open(os.path.join(a.out, "summary.json"), "w"), indent=2)
    json.dump(meta, open(os.path.join(a.out, "pastes.json"), "w"))
    print(json.dumps(summ, indent=2))


if __name__ == "__main__":
    main()
