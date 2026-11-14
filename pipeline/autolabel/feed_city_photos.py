#!/usr/bin/env python3
"""Keep the /label review queue fed with REAL Detroit pothole photos (Improve Detroit / SeeClickFix),
spending teacher money only when reviewers are actually short of work.

    python3 feed_city_photos.py --api https://wayneawshackathon.vercel.app --out DIR [--max-photos 400]

Loop: if fewer than --low-water frames are labelled-but-unreviewed, take the next --batch city pothole
reports (newest first, all of Detroit, last --days days), download each report photo from SeeClickFix
(one request per 1.5 s), upload it to R2 via /api/upload, register it (split "train" — the test set stays
dash-cam frames) and run the server-side teacher once. Stops after --max-photos photos (cost cap:
~$0.003 per photo with the default Gemini teacher). Resumable: DIR/feed_state.json. Stdlib only.

These are close-up/handheld photos: good, real Detroit positives; not the dash-cam angle.
"""
import argparse, json, os, sys, time, urllib.parse, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from push_frames import call, post_json  # noqa: E402  (same folder)

FEATURESERVER = ("https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/"
                 "improve_detroit/FeatureServer/0/query")
UA = {"User-Agent": "still-there-hackathon/1.0"}


def city_reports(days):
    """Detroit pothole report ids, newest first."""
    since = time.strftime("%Y-%m-%d", time.gmtime(time.time() - days * 86400))
    ids, offset = [], 0
    while True:
        q = urllib.parse.urlencode({
            "where": f"request_type = 'Potholes' AND created_at >= DATE '{since}'",
            "outFields": "issue_id", "returnGeometry": "false", "orderByFields": "created_at DESC",
            "resultOffset": offset, "resultRecordCount": 2000, "f": "json"})
        data = call("GET", f"{FEATURESERVER}?{q}", headers=UA, timeout=60)
        rows = [str(f["attributes"]["issue_id"]) for f in data.get("features", [])]
        ids += rows
        if not data.get("exceededTransferLimit") and len(rows) < 2000:
            return ids
        offset += len(rows)


def photo_url(issue_id):
    d = call("GET", f"https://seeclickfix.com/api/v2/issues/{issue_id}", headers=UA, timeout=30)
    return (d.get("media") or {}).get("image_full")


def download(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(), r.headers.get("Content-Type", "")


def backlog(api):
    s = call("GET", f"{api}/api/labels?stats=1")
    return s.get("test_left", 0) + s.get("train_left", 0) + s.get("new", 0), s


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--api", required=True)
    ap.add_argument("--out", required=True, help="folder for feed_state.json")
    ap.add_argument("--days", type=int, default=365)
    ap.add_argument("--max-photos", type=int, default=400, help="cost cap: stop after this many photos")
    ap.add_argument("--low-water", type=int, default=60, help="top up when fewer frames than this await review")
    ap.add_argument("--batch", type=int, default=20)
    ap.add_argument("--poll", type=int, default=60, help="seconds between queue checks")
    ap.add_argument("--once", action="store_true", help="one top-up then exit")
    a = ap.parse_args()
    api = a.api.rstrip("/")
    os.makedirs(a.out, exist_ok=True)
    state_path = os.path.join(a.out, "feed_state.json")
    state = json.load(open(state_path)) if os.path.exists(state_path) else {"done": {}, "no_photo": []}
    seen = set(state["done"]) | set(state["no_photo"])

    def save():
        json.dump(state, open(state_path + ".tmp", "w")); os.replace(state_path + ".tmp", state_path)

    reports = [i for i in city_reports(a.days) if i not in seen]
    print(f"{len(reports)} Detroit pothole reports not yet used; cap {a.max_photos}, "
          f"already fed {len(state['done'])}", flush=True)

    while reports and len(state["done"]) < a.max_photos:
        waiting, stats = backlog(api)
        if waiting >= a.low_water:
            if a.once:
                break
            print(f"queue has {waiting} waiting (reviewed {stats.get('reviewed')}) — sleeping {a.poll}s", flush=True)
            time.sleep(a.poll)
            continue

        new_frames = []
        while reports and len(new_frames) < a.batch and len(state["done"]) + len(new_frames) < a.max_photos:
            issue = reports.pop(0)
            try:
                url = photo_url(issue)
                time.sleep(1.5)  # be polite to SeeClickFix
                if not url:
                    state["no_photo"].append(issue)
                    continue
                img, ctype = download(url)
                if not ctype.startswith("image/jpeg") or len(img) > 3_900_000:
                    state["no_photo"].append(issue)
                    continue
                fid = f"crowd_scf-{issue}_0"
                up = call("POST", f"{api}/api/upload?name={fid}.jpg", img, {"Content-Type": "image/jpeg"})
                new_frames.append({"frame_id": fid, "image_url": up["image_url"], "split": "train",
                                   "video_id": f"scf-{issue}", "t_sec": 0})
            except Exception as e:  # one bad report never stops the feed
                print(f"  skip {issue}: {e}", flush=True)
                state["no_photo"].append(issue)
        if not new_frames:
            continue
        post_json(api, {"action": "add", "frames": new_frames})

        def teach(f):
            try:
                post_json(api, {"action": "teach", "frame_id": f["frame_id"]})
                return None
            except Exception as e:
                return str(e)[:120]

        with ThreadPoolExecutor(4) as ex:
            errors = [e for e in ex.map(teach, new_frames) if e]
        for f in new_frames:
            state["done"][f["frame_id"]] = f["image_url"]
        save()
        print(f"fed {len(new_frames)} photos (total {len(state['done'])}/{a.max_photos}, "
              f"teach errors {len(errors)}{': ' + errors[0] if errors else ''})", flush=True)
        if a.once:
            break
    save()
    print(f"stopped: fed {len(state['done'])} photos, {len(state['no_photo'])} reports without a usable photo", flush=True)


if __name__ == "__main__":
    main()
