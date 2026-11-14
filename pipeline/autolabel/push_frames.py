#!/usr/bin/env python3
"""Upload crowd frames to R2 via the API, register them in /api/labels, optionally run the teacher.

Usage:
  python3 push_frames.py --manifest OUT/manifest.csv --api https://wayneawshackathon.vercel.app \
      [--concurrency 6] [--teach] [--limit N] [--dry-run]

frame_id = "crowd_" + image file stem. Resumable via OUT/push_state.json {frame_id: image_url}
(OUT = directory of the manifest). Stdlib only.
"""
import argparse, csv, json, os, sys, threading, time, urllib.error, urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed


def call(method, url, data=None, headers=None, timeout=90, retries=4):
    """HTTP with retry/backoff on 429/5xx/network errors. Returns parsed JSON."""
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode() or "{}")
        except urllib.error.HTTPError as e:
            body = e.read().decode(errors="replace")[:300]
            last = "HTTP %d %s" % (e.code, body)
            if e.code != 429 and e.code < 500:
                raise RuntimeError(last)
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            last = "network: %s" % e
        if attempt < retries:
            time.sleep(min(2 ** attempt, 15))
    raise RuntimeError(last)


def post_json(api, body):
    return call("POST", api + "/api/labels", json.dumps(body).encode(), {"Content-Type": "application/json"})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--api", required=True)
    ap.add_argument("--concurrency", type=int, default=6)
    ap.add_argument("--teach", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    api = a.api.rstrip("/")
    out = os.path.dirname(os.path.abspath(a.manifest))
    state_path = os.path.join(out, "push_state.json")
    state = {}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)

    with open(a.manifest, newline="") as f:
        rows = list(csv.DictReader(f))
    if a.limit:
        rows = rows[:a.limit]
    frames = []
    for r in rows:
        p = r["path"]
        if not os.path.isabs(p):
            p = os.path.join(out, p) if os.path.exists(os.path.join(out, p)) else os.path.abspath(p)
        fid = "crowd_" + os.path.splitext(os.path.basename(p))[0]
        frames.append(dict(frame_id=fid, path=p, split=r["split"], video_id=r["video_id"], t_sec=float(r["t_sec"])))
    todo = [fr for fr in frames if fr["frame_id"] not in state]
    print("manifest: %d frames; already uploaded: %d; to upload: %d" % (len(frames), len(frames) - len(todo), len(todo)))
    if a.dry_run:
        for fr in todo[:5]:
            print("  would upload %s -> %s/api/upload?name=%s.jpg" % (fr["path"], api, fr["frame_id"]))
        print("  would POST add for %d frames in batches of 100" % len(frames))
        if a.teach:
            print("  would run teach loop (GET /api/labels?todo=teach&limit=200) with %d workers" % a.concurrency)
        return

    # 1. upload
    lock = threading.Lock()
    up_err = defaultdict(list)

    def upload(fr):
        if not os.path.exists(fr["path"]):
            raise RuntimeError("missing file " + fr["path"])
        with open(fr["path"], "rb") as f:
            data = f.read()
        if len(data) >= 4 * 1024 * 1024:
            raise RuntimeError("image >= 4 MB")
        res = call("POST", "%s/api/upload?name=%s.jpg" % (api, fr["frame_id"]), data, {"Content-Type": "image/jpeg"})
        if not res.get("image_url"):
            raise RuntimeError("no image_url in response: %s" % res)
        return res["image_url"]

    done = 0
    with ThreadPoolExecutor(a.concurrency) as ex:
        futs = {ex.submit(upload, fr): fr for fr in todo}
        for fu in as_completed(futs):
            fr = futs[fu]
            try:
                url = fu.result()
                with lock:
                    state[fr["frame_id"]] = url
                    with open(state_path, "w") as f:
                        json.dump(state, f)
                done += 1
            except Exception as e:
                up_err[str(e)].append(fr["frame_id"])
            n = done + sum(len(v) for v in up_err.values())
            if n % 25 == 0:
                print("  upload %d/%d" % (n, len(todo)), flush=True)
    print("uploaded %d, upload errors %d" % (done, sum(len(v) for v in up_err.values())))
    for msg, ids in up_err.items():
        print("  [%d] %s (e.g. %s)" % (len(ids), msg, ids[0]))

    # 2. add
    ready = [fr for fr in frames if fr["frame_id"] in state]
    added = 0
    for i in range(0, len(ready), 100):
        batch = [dict(frame_id=fr["frame_id"], image_url=state[fr["frame_id"]], split=fr["split"],
                      video_id=fr["video_id"], t_sec=fr["t_sec"]) for fr in ready[i:i + 100]]
        res = post_json(api, {"action": "add", "frames": batch})
        added += res.get("added", 0)
    print("registered via add: %d frames (server reported added=%d)" % (len(ready), added))

    # 3. teach
    if a.teach:
        taught, errors, failed_passes, prev_failed = 0, defaultdict(list), 0, None
        seen = 0
        while True:
            ids = call("GET", api + "/api/labels?todo=teach&limit=200").get("frame_ids", [])
            if not ids:
                break

            def teach(fid):
                res = post_json(api, {"action": "teach", "frame_id": fid})
                fr = res.get("frame") or {}
                if fr.get("teacher_error"):
                    raise RuntimeError(fr["teacher_error"])
                return fid

            failed = set()
            with ThreadPoolExecutor(a.concurrency) as ex:
                futs = {ex.submit(teach, fid): fid for fid in ids}
                for fu in as_completed(futs):
                    fid = futs[fu]
                    try:
                        fu.result()
                        taught += 1
                    except Exception as e:
                        failed.add(fid)
                        errors[str(e)[:200]].append(fid)
                    seen += 1
                    if seen % 25 == 0:
                        print("  teach %d done (%d ok, %d failed)" % (seen, taught, seen - taught), flush=True)
            if failed and failed == prev_failed or (failed and len(failed) == len(ids)):
                failed_passes += 1
                if failed_passes >= 2:
                    print("same frames keep failing; stopping teach loop")
                    break
            else:
                failed_passes = 0
            prev_failed = failed
        print("teach: taught %d, errors %d (last-pass failures may have been retried successfully)"
              % (taught, sum(len(v) for v in errors.values())))
        for msg, ids in errors.items():
            print("  [%d] %s (e.g. %s)" % (len(ids), msg, ids[0]))
        try:
            print("stats:", json.dumps(call("GET", api + "/api/labels?stats=1")))
        except Exception as e:
            print("stats unavailable:", e)


if __name__ == "__main__":
    main()
