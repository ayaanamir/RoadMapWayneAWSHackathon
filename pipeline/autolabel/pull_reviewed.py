#!/usr/bin/env python3
"""Download human-reviewed frames from /api/labels as a YOLO-format folder.

Usage:
  python3 pull_reviewed.py --api https://wayneawshackathon.vercel.app --out DIR

Writes DIR/{train,test}/images/<frame_id>.jpg and DIR/{train,test}/labels/<frame_id>.txt
(class 0, cx cy w h normalised; empty file = no pothole). Images are cached (skipped if present). Stdlib only.
"""
import argparse, json, os, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from push_frames import call


def clamp(v):
    return max(0.0, min(1.0, v))


def yolo_line(b):
    x0, y0 = clamp(b["x"]), clamp(b["y"])
    x1, y1 = clamp(b["x"] + b["w"]), clamp(b["y"] + b["h"])
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return None
    return "0 %.6f %.6f %.6f %.6f" % (x0 + w / 2, y0 + h / 2, w, h)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--concurrency", type=int, default=6)
    a = ap.parse_args()
    api = a.api.rstrip("/")
    frames = call("GET", api + "/api/labels?export=1").get("frames", [])
    stats = {s: dict(frames=0, pos=0, empty=0, boxes=0) for s in ("train", "test")}
    errs = []

    def one(fr):
        s = fr["split"]
        d = os.path.join(a.out, s)
        os.makedirs(os.path.join(d, "images"), exist_ok=True)
        os.makedirs(os.path.join(d, "labels"), exist_ok=True)
        ip = os.path.join(d, "images", fr["frame_id"] + ".jpg")
        if not os.path.exists(ip):
            with urllib.request.urlopen(fr["image_url"], timeout=60) as r, open(ip + ".part", "wb") as f:
                f.write(r.read())
            os.replace(ip + ".part", ip)
        lines = [l for l in (yolo_line(b) for b in (fr.get("boxes") or [])) if l]
        with open(os.path.join(d, "labels", fr["frame_id"] + ".txt"), "w") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))
        return s, len(lines)

    with ThreadPoolExecutor(a.concurrency) as ex:
        futs = [(fr, ex.submit(one, fr)) for fr in frames if fr.get("boxes") is not None and fr.get("split") in stats]
        for fr, fu in futs:
            try:
                s, n = fu.result()
                st = stats[s]
                st["frames"] += 1
                st["boxes"] += n
                st["pos" if n else "empty"] += 1
            except Exception as e:
                errs.append("%s: %s" % (fr["frame_id"], e))
    for s, st in stats.items():
        print("%-5s frames %d  with pothole %d  empty %d  boxes %d" % (s, st["frames"], st["pos"], st["empty"], st["boxes"]))
    if errs:
        print("%d errors:" % len(errs))
        for e in errs[:10]:
            print("  " + e)
    print("\nNext:")
    print("  python3 eval_models.py --images %s/test/images --labels %s/test/labels --out eval_out --model YOURS.pt" % (a.out, a.out))
    print("  python3 make_yolo_dataset.py --pair %s/train/images %s/train/labels --out dataset/ --copy" % (a.out, a.out))


if __name__ == "__main__":
    main()
