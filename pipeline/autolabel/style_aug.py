#!/usr/bin/env python3
"""Footage-style offline augmentation: make clean training images look like our YouTube/phone
dash-cam footage. All effects are photometric, so YOLO boxes are copied unchanged.

Effects (random subset, random strength, applied in this order):
  grey   — November grey: desaturate, slight blue-grey cast, lower contrast/brightness
  wet    — wet/dark road: darkened cool lower band + faint vertical "reflection" smear
  glare  — low sun: warm radial blob in the upper half, screen-blended
  haze   — distance haze: whitish veil growing with height in the upper band
  motion — linear motion blur (5-17 px, random angle)
  jpeg   — JPEG artefacts: final re-encode at q 35-75 (always applied)

  python3 style_aug.py --pair IMAGES LABELS [--pair I2 L2] --out DIR \
      [--frac 1.0] [--effects grey,wet,glare,haze,motion,jpeg] [--seed 0]

Writes OUT/images/<stem>__aug.jpg + OUT/labels/<stem>__aug.txt, samples.png (before/after
grid), summary.json (effect counts + recommended Ultralytics hyperparams for training with
this offline aug: keep the trainer's own photometric aug modest so effects don't double up).
"""
import argparse, glob, json, os, random
import cv2
import numpy as np

IMG_EXT = (".jpg", ".jpeg", ".png")

RECOMMENDED = dict(imgsz=640, hsv_h=0.008, hsv_s=0.4, hsv_v=0.25, degrees=0.0, translate=0.05,
                   scale=0.15, fliplr=0.5, mosaic=1.0, close_mosaic=10, erasing=0.0, mixup=0.0,
                   copy_paste=0.0)


def fx_grey(im, rng):
    f = rng.uniform(0.25, 0.5)
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)[..., None]
    out = im.astype(np.float32) * (1 - f) + g * f
    out[..., 0] += rng.uniform(3, 10)   # blue-grey cast
    out[..., 2] -= rng.uniform(2, 8)
    out = (out - 128) * rng.uniform(0.85, 1.0) + 128 * rng.uniform(0.85, 1.05)
    return out


def fx_wet(im, rng):
    H, W = im.shape[:2]
    out = im.astype(np.float32)
    y0 = int(H * rng.uniform(0.42, 0.6))
    band = out[y0:]
    dark = rng.uniform(0.6, 0.85)
    band *= dark
    band[..., 0] *= 1.06  # cool tint
    band[..., 2] *= 0.96
    if y0 > H // 6:  # cheap reflection: flipped upper strip, screened in faintly
        sh = min(H - y0, y0)
        refl = cv2.flip(out[y0 - sh:y0], 0)
        refl = cv2.GaussianBlur(refl, (0, 0), 6)
        a = rng.uniform(0.05, 0.14)
        band[-sh:] = band[-sh:] * (1 - a) + np.maximum(band[-sh:], refl) * a + refl * a * 0.3
    return out


def fx_glare(im, rng):
    H, W = im.shape[:2]
    out = im.astype(np.float32)
    cx, cy = rng.uniform(0.15, 0.85) * W, rng.uniform(-0.05, 0.35) * H
    r = rng.uniform(0.25, 0.6) * max(H, W)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    d2 = ((xx - cx) ** 2 + (yy - cy) ** 2) / (r * r)
    blob = np.clip(1 - d2, 0, 1) ** 2 * rng.uniform(90, 200)
    warm = np.dstack([blob * 0.85, blob * 0.95, blob])  # warm white
    return 255 - (255 - np.clip(out, 0, 255)) * (255 - warm) / 255  # screen blend


def fx_haze(im, rng):
    H, W = im.shape[:2]
    a = (rng.uniform(0.04, 0.16) * (1 - np.arange(H) / H) ** 1.5)[:, None, None]
    veil = np.array([255, 252, 248], np.float32)
    return im.astype(np.float32) * (1 - a) + veil * a


def fx_motion(im, rng):
    n = rng.randint(5, 17) | 1
    ang = rng.uniform(0, 180)
    k = np.zeros((n, n), np.float32)
    c = n // 2
    dx, dy = int(round(np.cos(np.radians(ang)) * c)), int(round(np.sin(np.radians(ang)) * c))
    cv2.line(k, (c - dx, c - dy), (c + dx, c + dy), 1.0, 1)
    k /= k.sum()
    return cv2.filter2D(im, -1, k).astype(np.float32)


def fx_jpeg(im, rng):
    q = rng.randint(35, 75)
    ok, buf = cv2.imencode(".jpg", np.clip(im, 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, q])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR).astype(np.float32)


FX = dict(grey=fx_grey, wet=fx_wet, glare=fx_glare, haze=fx_haze, motion=fx_motion, jpeg=fx_jpeg)
ORDER = ["grey", "wet", "glare", "haze", "motion", "jpeg"]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pair", nargs=2, action="append", required=True, metavar=("IMG", "LAB"))
    ap.add_argument("--out", required=True)
    ap.add_argument("--frac", type=float, default=1.0, help="share of input images to augment")
    ap.add_argument("--effects", default=",".join(ORDER[:-1]), help="comma list; jpeg is always added last")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rng = random.Random(a.seed)
    want = [e for e in a.effects.split(",") if e in FX]
    os.makedirs(os.path.join(a.out, "images"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "labels"), exist_ok=True)

    pairs = []
    for idir, ldir in a.pair:
        for f in sorted(glob.glob(os.path.join(idir, "*"))):
            if f.lower().endswith(IMG_EXT):
                pairs.append((f, os.path.join(ldir, os.path.splitext(os.path.basename(f))[0] + ".txt")))
    rng.shuffle(pairs)
    keep = [p for p in pairs if rng.random() < a.frac]
    print(f"{len(pairs)} inputs -> augmenting {len(keep)}")

    counts = {e: 0 for e in ORDER}
    samples = []
    for i, (f, lab) in enumerate(keep):
        im = cv2.imread(f)
        if im is None:
            continue
        before = im.copy()
        out = im.astype(np.float32)
        chosen = [e for e in ORDER[:-1] if e in want and rng.random() < {"grey": 0.7, "wet": 0.4, "glare": 0.35, "haze": 0.35, "motion": 0.45}[e]]
        for e in chosen + ["jpeg"]:
            out = FX[e](out, rng)
            counts[e] += 1
        stem = os.path.splitext(os.path.basename(f))[0] + "__aug"
        cv2.imwrite(os.path.join(a.out, "images", stem + ".jpg"), np.clip(out, 0, 255).astype(np.uint8),
                    [cv2.IMWRITE_JPEG_QUALITY, 92])
        if os.path.exists(lab):
            with open(lab) as src, open(os.path.join(a.out, "labels", stem + ".txt"), "w") as dst:
                dst.write(src.read())
        else:
            open(os.path.join(a.out, "labels", stem + ".txt"), "w").close()
        if len(samples) < 8 and rng.random() < 0.3:
            samples.append((before, np.clip(out, 0, 255).astype(np.uint8), chosen))
        if (i + 1) % 500 == 0:
            print(f"  {i+1}/{len(keep)}", flush=True)

    tiles = []
    for b, af, ch in samples:
        pair = np.hstack([cv2.resize(b, (256, 256)), cv2.resize(af, (256, 256))])
        cv2.putText(pair, ",".join(ch) or "jpeg", (4, 250), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 0), 1)
        tiles.append(pair)
    while len(tiles) < 8:
        tiles.append(np.zeros((256, 512, 3), np.uint8))
    cv2.imwrite(os.path.join(a.out, "samples.png"),
                np.vstack([np.hstack(tiles[r * 2:(r + 1) * 2]) for r in range(4)]))
    summ = dict(inputs=len(pairs), augmented=len(keep), effects=counts, seed=a.seed,
                recommended_ultralytics=RECOMMENDED)
    json.dump(summ, open(os.path.join(a.out, "summary.json"), "w"), indent=2)
    print(json.dumps(summ, indent=2))


if __name__ == "__main__":
    main()
