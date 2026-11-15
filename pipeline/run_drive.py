#!/usr/bin/env python3
"""Offline drive pipeline: recorder files (video segments + .json sidecars + .gpx)
-> pothole detections -> POST /api/upload + /api/detections (source "drive").

  python pipeline/run_drive.py --drive path/to/drive --dry-run      # model + conf default to the live dash-cam model
  python pipeline/run_drive.py --drive path/to/drive                # sends

Each sent sighting costs ~0.4 cents of server vision check; --max-sightings caps it.
"""
import argparse
import bisect
import json
import math
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import cv2
import numpy as np

VIDEO_EXT = (".mp4", ".webm", ".mov")
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
MAX_GPS_GAP_S = 10.0
UPLOAD_MAX_W = 1280
JPEG_Q = 80


# ---------- time / geo helpers ----------
def iso(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(ms) % 1000:03d}Z"


def parse_iso_ms(s):
    s = s.strip().replace("Z", "+00:00")
    d = datetime.fromisoformat(s)
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.timestamp() * 1000


def haversine_m(la1, lo1, la2, lo2):
    p1, p2 = math.radians(la1), math.radians(la2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


# ---------- inputs ----------
def stamp_ms(name):
    """drive_20261114T221530Z_seg1.mp4 -> epoch ms of the drive start (fallback)."""
    m = re.search(r"(\d{8}T\d{6}Z)", name)
    if not m:
        return None
    return datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp() * 1000


def find_segments(drive):
    segs = []
    for fn in sorted(os.listdir(drive)):
        if not fn.lower().endswith(VIDEO_EXT) or fn.startswith("."):
            continue
        path = os.path.join(drive, fn)
        side = os.path.splitext(path)[0] + ".json"
        start = end = None
        if os.path.exists(side):
            try:
                sc = json.load(open(side))
                start, end = sc.get("start_utc_ms"), sc.get("end_utc_ms")
            except Exception as e:
                print(f"WARN: bad sidecar {side}: {e}")
        if start is None:
            start = stamp_ms(fn)
            if start is None:
                print(f"WARN: {fn}: no sidecar and no timestamp in the name, skipped")
                continue
            print(f"WARN: {fn}: no usable sidecar, using filename timestamp (segment offset ignored)")
        segs.append({"path": path, "start_ms": float(start), "end_ms": end})
    return segs


def load_gpx(drive):
    pts = []
    for fn in sorted(os.listdir(drive)):
        if not fn.lower().endswith(".gpx"):
            continue
        root = ET.parse(os.path.join(drive, fn)).getroot()
        for el in root.iter():
            if el.tag.split("}")[-1] != "trkpt":
                continue
            t = next((c.text for c in el if c.tag.split("}")[-1] == "time"), None)
            if t:
                pts.append((parse_iso_ms(t), float(el.get("lat")), float(el.get("lon"))))
    pts.sort()
    return pts


def interp(pts, times, t_ms):
    """Linear lat/lon at t_ms, or None if > MAX_GPS_GAP_S from any GPS point."""
    if not pts:
        return None
    i = bisect.bisect_left(times, t_ms)
    if i < len(pts) and pts[i][0] == t_ms:
        return pts[i][1], pts[i][2]
    lo = pts[i - 1] if i > 0 else None
    hi = pts[i] if i < len(pts) else None
    if lo is None or hi is None:  # outside the track: only OK if near an end point
        p = hi or lo
        return (p[1], p[2]) if abs(p[0] - t_ms) <= MAX_GPS_GAP_S * 1000 else None
    if (t_ms - lo[0]) > MAX_GPS_GAP_S * 1000 and (hi[0] - t_ms) > MAX_GPS_GAP_S * 1000:
        return None
    if (t_ms - lo[0]) > MAX_GPS_GAP_S * 1000 or (hi[0] - t_ms) > MAX_GPS_GAP_S * 1000:
        # one side is far: use the nearer point only if it is within the limit
        p = lo if (t_ms - lo[0]) <= (hi[0] - t_ms) else hi
        return p[1], p[2]
    f = (t_ms - lo[0]) / (hi[0] - lo[0])
    return lo[1] + f * (hi[1] - lo[1]), lo[2] + f * (hi[2] - lo[2])


# ---------- model ----------
def nms(b, s, thr):
    order = s.argsort()[::-1]
    keep = []
    while len(order):
        i = order[0]
        keep.append(i)
        if len(order) == 1:
            break
        r = order[1:]
        xx1 = np.maximum(b[i, 0], b[r, 0]); yy1 = np.maximum(b[i, 1], b[r, 1])
        xx2 = np.minimum(b[i, 2], b[r, 2]); yy2 = np.minimum(b[i, 3], b[r, 3])
        inter = np.clip(xx2 - xx1, 0, None) * np.clip(yy2 - yy1, 0, None)
        a1 = (b[i, 2] - b[i, 0]) * (b[i, 3] - b[i, 1])
        a2 = (b[r, 2] - b[r, 0]) * (b[r, 3] - b[r, 1])
        order = r[inter / (a1 + a2 - inter + 1e-9) <= thr]
    return keep


def make_predictor(model_path, conf, road_band):
    from ultralytics import YOLO
    model = YOLO(model_path, task="detect")

    def predict(img):
        r = model.predict(img, imgsz=640, conf=conf, verbose=False)[0]
        if r.boxes is None or len(r.boxes) == 0:
            return np.zeros((0, 4)), np.zeros(0)
        return r.boxes.xyxy.cpu().numpy(), r.boxes.conf.cpu().numpy()

    def run(img):
        if not road_band:
            return predict(img)
        h, w = img.shape[:2]
        y0, y1 = int(h * 0.35), int(h * 0.95)
        bs, ss = [], []
        for x0, x1 in [(0, int(w * 0.575)), (int(w * 0.425), w)]:
            b, s = predict(img[y0:y1, x0:x1])
            b = b.copy()
            b[:, [0, 2]] += x0
            b[:, [1, 3]] += y0
            bs.append(b); ss.append(s)
        b, s = np.concatenate(bs), np.concatenate(ss)
        if len(b):
            k = nms(b, s, 0.5)
            b, s = b[k], s[k]
        return b, s
    return run


# ---------- scanning ----------
def scan(segs, pts, run, fps, stats):
    times = [p[0] for p in pts]
    hits = []
    for seg in segs:
        cap = cv2.VideoCapture(seg["path"])
        if not cap.isOpened():
            print(f"WARN: cannot open {seg['path']}")
            continue
        vfps = cap.get(cv2.CAP_PROP_FPS) or 30
        total = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
        dur_ms = total / vfps * 1000 if total > 0 else None
        step, t, n = 1000.0 / fps, 0.0, 0
        print(f"scanning {os.path.basename(seg['path'])} ({vfps:.0f} fps, "
              f"{dur_ms / 1000 if dur_ms else '?'} s)")
        while True:
            if dur_ms is not None and t > dur_ms:
                break
            cap.set(cv2.CAP_PROP_POS_MSEC, t)
            ok, frame = cap.read()
            if not ok:
                break
            # Use the decoder's actual timestamp when it reports one.
            pos = cap.get(cv2.CAP_PROP_POS_MSEC)
            tt = pos if pos and pos > 0 else t
            stats["frames"] += 1
            t_abs = seg["start_ms"] + tt
            g = interp(pts, times, t_abs)
            if g is None:
                stats["no_gps"] += 1
            else:
                stats["gps_matched"] += 1
                b, s = run(frame)
                if len(s):
                    k = int(np.argmax(s))
                    stats["raw_hits"] += 1
                    hits.append({"t_ms": t_abs, "lat": g[0], "lon": g[1], "conf": float(s[k]),
                                 "box": [float(v) for v in b[k]], "frame": frame})
            t += step
            n += 1
            if n % 100 == 0:
                print(f"  {n} frames, {len(hits)} raw hits")
        cap.release()
    return hits


def dedupe(hits, min_gap_m, min_gap_s):
    kept = []
    for h in sorted(hits, key=lambda x: -x["conf"]):
        if any(abs(h["t_ms"] - k["t_ms"]) / 1000 <= min_gap_s
               and haversine_m(h["lat"], h["lon"], k["lat"], k["lon"]) <= min_gap_m for k in kept):
            continue
        kept.append(h)
    return sorted(kept, key=lambda x: x["t_ms"])


# ---------- output ----------
def encode(frame):
    h, w = frame.shape[:2]
    scale = min(1.0, UPLOAD_MAX_W / w)
    img = cv2.resize(frame, (round(w * scale), round(h * scale))) if scale < 1 else frame
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_Q])
    if not ok:
        raise RuntimeError("jpeg encode failed")
    return buf.tobytes(), scale


def http(method, url, data, ctype, tries=5):
    for a in range(tries):
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={"Content-Type": ctype, "User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read() or b"{}")
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and a < tries - 1:
                wait = 2 ** a * 2
                print(f"  HTTP {e.code}, retry in {wait}s")
                time.sleep(wait)
                continue
            raise RuntimeError(f"HTTP {e.code} {url}: {e.read()[:200]!r}")
        except urllib.error.URLError as e:
            if a < tries - 1:
                time.sleep(2 ** a * 2)
                continue
            raise RuntimeError(f"network error {url}: {e}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--drive", required=True)
    # Defaults = the shipped dash-cam model (v5) and its threshold, picked on held-out real potholes (#118).
    ap.add_argument("--model", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "apps", "live", "model", "pothole-dashcam.onnx"))
    ap.add_argument("--conf", type=float, default=0.10)
    ap.add_argument("--fps", type=float, default=3)
    ap.add_argument("--api", default="https://wayneawshackathon.vercel.app")
    ap.add_argument("--out")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--max-sightings", type=int, default=200)
    ap.add_argument("--min-gap-m", type=float, default=15)
    ap.add_argument("--min-gap-s", type=float, default=3)
    ap.add_argument("--road-band", action="store_true", help="run on 2 road-band tiles (like eval_models road2x)")
    a = ap.parse_args()

    drive = a.drive.rstrip("/")
    out = a.out or os.path.join("pipeline", "out", os.path.basename(os.path.abspath(drive)))
    os.makedirs(os.path.join(out, "hits"), exist_ok=True)
    api = a.api.rstrip("/")

    segs = find_segments(drive)
    pts = load_gpx(drive)
    if not segs:
        sys.exit("no video segments found")
    if not pts:
        sys.exit("no GPS points found (.gpx with trkpt/time)")
    print(f"{len(segs)} segment(s), {len(pts)} GPS points")

    stats = {"segments": len(segs), "frames": 0, "no_gps": 0, "gps_matched": 0,
             "raw_hits": 0, "after_dedupe": 0, "sent": 0, "capped": 0, "failed": 0,
             "verdicts": {}, "dry_run": a.dry_run, "model": a.model, "conf": a.conf, "fps": a.fps}
    run = make_predictor(a.model, a.conf, a.road_band)
    hits = scan(segs, pts, run, a.fps, stats)
    kept = dedupe(hits, a.min_gap_m, a.min_gap_s)
    stats["after_dedupe"] = len(kept)
    if len(kept) > a.max_sightings:
        # keep the most confident, then restore time order
        kept = sorted(sorted(kept, key=lambda x: -x["conf"])[:a.max_sightings], key=lambda x: x["t_ms"])
        stats["capped"] = stats["after_dedupe"] - a.max_sightings
        print(f"cap: keeping top {a.max_sightings} by confidence")

    sent_path = os.path.join(out, "sent.json")
    sent = {} if a.dry_run or not os.path.exists(sent_path) else json.load(open(sent_path))

    dets = []
    for h in kept:
        jpg, scale = encode(h["frame"])
        did = str(uuid.uuid4())
        x1, y1, x2, y2 = h["box"]
        bbox = [round(x1 * scale), round(y1 * scale), round((x2 - x1) * scale), round((y2 - y1) * scale)]
        h.update(id=did, jpg=jpg, bbox=bbox)
        dets.append({"detection_id": did, "source": "drive", "camera": "dashcam", "lat": round(h["lat"], 7),
                     "lon": round(h["lon"], 7), "captured_at": iso(h["t_ms"]),
                     "confidence": round(h["conf"], 3), "bbox": bbox, "image_url": "",
                     "verdict": "unverified", "verdict_reason": None})

    if a.dry_run:
        for h, d in zip(kept, dets):
            img = cv2.imdecode(np.frombuffer(h["jpg"], np.uint8), cv2.IMREAD_COLOR)
            x, y, w, hh = d["bbox"]
            cv2.rectangle(img, (x, y), (x + w, y + hh), (0, 0, 255), 3)
            cv2.putText(img, f"{d['confidence']:.2f}", (x, max(20, y - 6)),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
            p = os.path.abspath(os.path.join(out, "hits", f"{d['captured_at'].replace(':', '')}_{d['detection_id'][:8]}.jpg"))
            cv2.imwrite(p, img, [cv2.IMWRITE_JPEG_QUALITY, 90])
            d["image_url"] = p
    else:
        # Resumable: a hit is identified by (time, rounded position); sent.json stores finished ones.
        todo = []
        for h, d in zip(kept, dets):
            key = f"{d['captured_at']}|{d['lat']:.5f}|{d['lon']:.5f}"
            if key in sent:
                stats["sent"] += 1
                for v in [sent[key].get("verdict")]:
                    stats["verdicts"][v] = stats["verdicts"].get(v, 0) + 1
                continue
            todo.append((key, h, d))
        print(f"sending {len(todo)} sighting(s) ({stats['sent']} already sent)")
        for key, h, d in todo:
            try:
                r = http("POST", f"{api}/api/upload?name={d['detection_id']}.jpg", h["jpg"], "image/jpeg")
                d["image_url"] = r["image_url"]
            except Exception as e:
                print(f"  upload failed: {e}")
                stats["failed"] += 1
        ready = [(k, d) for k, h, d in todo if d["image_url"]]
        for i in range(0, len(ready), 10):
            batch = ready[i:i + 10]
            try:
                r = http("POST", f"{api}/api/detections?verify=wait",
                         json.dumps({"detections": [d for _, d in batch]}).encode(), "application/json")
            except Exception as e:
                print(f"  post failed: {e}")
                stats["failed"] += len(batch)
                continue
            vmap = {v["detection_id"]: v.get("verdict") for v in (r.get("verified") or [])}
            for k, d in batch:
                v = vmap.get(d["detection_id"]) or "unverified"
                d["verdict"] = v if v in ("pothole", "shadow", "patch") else "unverified"
                sent[k] = {"detection_id": d["detection_id"], "verdict": d["verdict"], "image_url": d["image_url"]}
                stats["sent"] += 1
                stats["verdicts"][d["verdict"]] = stats["verdicts"].get(d["verdict"], 0) + 1
                print(f"  {d['captured_at']} conf={d['confidence']} -> {d['verdict']}")
            json.dump(sent, open(sent_path, "w"), indent=1)

    json.dump(dets, open(os.path.join(out, "detections.json"), "w"), indent=1)
    json.dump(stats, open(os.path.join(out, "summary.json"), "w"), indent=1)
    print("\n=== summary ===")
    print(f"frames sampled     {stats['frames']}")
    print(f"gps matched        {stats['gps_matched']}  (skipped, no GPS within {MAX_GPS_GAP_S:.0f}s: {stats['no_gps']})")
    print(f"raw hits           {stats['raw_hits']}")
    print(f"after dedupe       {stats['after_dedupe']}" + (f"  (capped, dropped {stats['capped']})" if stats["capped"] else ""))
    print(f"sent               {stats['sent']}" + ("  (dry run, nothing sent)" if a.dry_run else f"  failed: {stats['failed']}"))
    print(f"verdicts           {stats['verdicts']}")
    print(f"output             {out}")


if __name__ == "__main__":
    main()
