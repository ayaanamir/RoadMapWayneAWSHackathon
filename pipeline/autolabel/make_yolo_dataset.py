#!/usr/bin/env python3
"""Build a YOLO dataset folder from (images_dir, labels_dir) pairs.

Usage:
  python3 make_yolo_dataset.py --pair frames/ labeled/labels --out dataset/ \
      [--pair more_frames/ more/labels] [--val-fraction 0.1] [--max-negative-ratio 0.3] [--copy] [--seed 0]

Images with no label file are ignored. Video id = filename up to the last "_";
whole videos go to train or val (deterministic hash). Empty-label images are capped to
--max-negative-ratio of the dataset (extras dropped deterministically). Stdlib only.
"""
import argparse, hashlib, os, shutil, sys

EXTS = (".jpg", ".jpeg", ".png")


def h(s):
    return int(hashlib.md5(s.encode()).hexdigest(), 16)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pair", nargs=2, action="append", metavar=("IMAGES", "LABELS"), required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--val-fraction", type=float, default=0.1)
    ap.add_argument("--max-negative-ratio", type=float, default=0.3)
    ap.add_argument("--copy", action="store_true", help="copy instead of symlink")
    ap.add_argument("--seed", default="0")
    a = ap.parse_args()

    items = []  # (name, image path, label path, is_empty)
    for pi, (idir, ldir) in enumerate(a.pair):
        for d, _, files in os.walk(idir):
            for f in sorted(files):
                if not f.lower().endswith(EXTS):
                    continue
                ip = os.path.join(d, f)
                rel = os.path.splitext(os.path.relpath(ip, idir))[0]
                lp = os.path.join(ldir, rel + ".txt")
                if not os.path.exists(lp):
                    continue
                with open(lp) as lf:
                    empty = not lf.read().strip()
                # unique flat name; pair index avoids collisions between sources
                name = "p%d_%s" % (pi, rel.replace(os.sep, "__"))
                items.append((name, os.path.abspath(ip), lp, empty, os.path.splitext(f)[1].lower()))
    if not items:
        sys.exit("error: no images with matching label files found")

    pos = [i for i in items if not i[3]]
    neg = sorted([i for i in items if i[3]], key=lambda i: h(a.seed + i[0]))
    r = a.max_negative_ratio
    max_neg = len(neg) if r >= 1 else int(len(pos) * r / (1 - r))
    dropped = len(neg) - min(len(neg), max_neg)
    keep = pos + neg[:max_neg]

    counts = {"train": [0, 0], "val": [0, 0]}  # [images, empty]
    for sub in ("images", "labels"):
        for sp in ("train", "val"):
            os.makedirs(os.path.join(a.out, sub, sp), exist_ok=True)
    for name, ip, lp, empty, ext in sorted(keep):
        vid = name.rsplit("_", 1)[0] if "_" in name else name
        split = "val" if (h(a.seed + vid) % 10000) / 10000 < a.val_fraction else "train"
        dst = os.path.join(a.out, "images", split, name + ext)
        if os.path.lexists(dst):
            os.remove(dst)
        if a.copy:
            shutil.copy2(ip, dst)
        else:
            os.symlink(ip, dst)
        shutil.copy2(lp, os.path.join(a.out, "labels", split, name + ".txt"))
        counts[split][0] += 1
        counts[split][1] += empty

    with open(os.path.join(a.out, "data.yaml"), "w") as f:
        f.write("path: %s\ntrain: images/train\nval: images/val\nnc: 1\nnames: [pothole]\n" % os.path.abspath(a.out))
    print("train: %d images (%d empty)  val: %d images (%d empty)  dropped extra negatives: %d"
          % (counts["train"][0], counts["train"][1], counts["val"][0], counts["val"][1], dropped))
    print("wrote " + os.path.join(a.out, "data.yaml"))


if __name__ == "__main__":
    main()
