#!/usr/bin/env python3
"""Drive report: one HTML page for one recorded drive.

Reads what run_drive.py wrote (pipeline/out/<drive>/detections.json + summary.json),
the drive's GPX, and the city's previous pothole reports (GET /api/potholes), then
writes pipeline/out/<drive>/report.html:
  - the route on a map, every sighting on it, and the city's earlier reports nearby
  - each sighting: photo with the box, time, model confidence, vision check verdict,
    and the nearest earlier city report (address, how many reports, when it was closed)

  python pipeline/run_drive.py --drive ~/drives/today          # first (or --dry-run)
  python pipeline/drive_report.py --drive ~/drives/today       # then this
  open pipeline/out/today/report.html
"""
import argparse
import base64
import html
import json
import math
import os
import sys
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
NEAR_M = 50        # a sighting this close to a city report counts as "at" it
PASSED_M = 25      # a city report this close to the route counts as "driven past"


def haversine_m(la1, lo1, la2, lo2):
    p1, p2 = math.radians(la1), math.radians(la2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2)
    return 2 * 6371000 * math.asin(math.sqrt(a))


def parse_iso(s):
    d = datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def load_gpx(drive):
    pts = []
    for fn in sorted(os.listdir(drive)):
        if not fn.lower().endswith(".gpx"):
            continue
        for el in ET.parse(os.path.join(drive, fn)).getroot().iter():
            if el.tag.split("}")[-1] != "trkpt":
                continue
            t = next((c.text for c in el if c.tag.split("}")[-1] == "time"), None)
            if t:
                pts.append((parse_iso(t), float(el.get("lat")), float(el.get("lon"))))
    pts.sort()
    return pts


def fetch_potholes(api):
    req = urllib.request.Request(f"{api}/api/potholes", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)["potholes"]


def img_src(url):
    """R2 URLs stay links; local files (dry run) are embedded so the page travels."""
    if url.startswith("http"):
        return url
    if url and os.path.exists(url):
        return "data:image/jpeg;base64," + base64.b64encode(open(url, "rb").read()).decode()
    return ""


def fmt_local(dt):
    # Detroit is UTC-5 in November (EST); good enough for a one-day report.
    from datetime import timedelta
    return (dt - timedelta(hours=5)).strftime("%-I:%M:%S %p")


def fmt_date(s):
    return parse_iso(s).strftime("%b %-d, %Y") if s else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--drive", required=True, help="folder with the recorder files (for the GPX)")
    ap.add_argument("--out", help="run_drive output folder (default pipeline/out/<drive folder name>)")
    ap.add_argument("--api", default="https://wayneawshackathon.vercel.app")
    a = ap.parse_args()

    drive = a.drive.rstrip("/")
    out = a.out or os.path.join("pipeline", "out", os.path.basename(os.path.abspath(drive)))
    det_path = os.path.join(out, "detections.json")
    if not os.path.exists(det_path):
        sys.exit(f"{det_path} not found: run pipeline/run_drive.py --drive {drive} first")
    dets = json.load(open(det_path))
    summary = json.load(open(os.path.join(out, "summary.json"))) if os.path.exists(os.path.join(out, "summary.json")) else {}
    pts = load_gpx(drive)
    if not pts:
        sys.exit("no GPS points in the drive folder (.gpx)")
    potholes = fetch_potholes(a.api.rstrip("/"))

    # Route length, duration
    dist = sum(haversine_m(p[1], p[2], q[1], q[2]) for p, q in zip(pts, pts[1:]))
    start, end = pts[0][0], pts[-1][0]
    mins = (end - start).total_seconds() / 60

    # City reports the route went past
    step = max(1, len(pts) // 2000)
    route = pts[::step]
    passed = []
    for p in potholes:
        d = min(haversine_m(p["lat"], p["lon"], r[1], r[2]) for r in route)
        if d <= PASSED_M:
            passed.append(p)

    # Each sighting -> nearest earlier city report
    rows, owners = [], []
    for d in dets:
        best, bd = None, 1e9
        for p in potholes:
            if not p["city_reports"]:
                continue
            m = haversine_m(d["lat"], d["lon"], p["lat"], p["lon"])
            if m < bd:
                best, bd = p, m
        near = best if bd <= NEAR_M else None
        # Who owns the road here: the nearest pothole of any kind (usually the one this
        # sighting made) carries `owner` from the API (City of Detroit or MDOT).
        own = near or min(potholes, key=lambda p: haversine_m(d["lat"], d["lon"], p["lat"], p["lon"]), default=None)
        if own and haversine_m(d["lat"], d["lon"], own["lat"], own["lon"]) > NEAR_M:
            own = None
        owners.append((own or {}).get("owner"))
        rows.append((d, near, bd))

    confirmed = [r for r in rows if r[0]["verdict"] == "pothole"]
    patched = [r for r in rows if r[0]["verdict"] == "patch"]
    rejected = [r for r in rows if r[0]["verdict"] == "shadow"]
    unchecked = [r for r in rows if r[0]["verdict"] not in ("pothole", "patch", "shadow")]
    at_prev = [r for r in rows if r[1]]
    back_after_close = [r for r in confirmed if r[1] and any(
        c.get("closed_at") and c["closed_at"] < r[0]["captured_at"] for c in r[1]["city_reports"])]
    seen_ids = {r[1]["pothole_id"] for r in at_prev}

    VLABEL = {"pothole": ("Pothole", "v-pothole"), "patch": ("Patched", "v-patch"),
              "shadow": ("Not a pothole", "v-shadow"), "unverified": ("Model only, not checked", "v-unv")}

    def card(i, k, d, near, dist_m):
        lab, cls = VLABEL.get(d["verdict"], VLABEL["unverified"])
        src = img_src(d.get("image_url", ""))
        img = f'<img src="{html.escape(src)}" alt="Frame {i}" loading="lazy">' if src else '<div class="noimg">no photo</div>'
        when = fmt_local(parse_iso(d["captured_at"]))
        if near:
            reps = sorted(near["city_reports"], key=lambda c: c["created_at"])
            closed = [c for c in reps if c.get("closed_at")]
            last_close = max((c["closed_at"] for c in closed), default=None)
            line = (f'<b>{dist_m:.0f} m from an earlier city report</b> at {html.escape(near.get("address") or "")}: '
                    f'{len(reps)} report{"s" if len(reps) != 1 else ""}, first {fmt_date(reps[0]["created_at"])}')
            if last_close:
                days = (parse_iso(d["captured_at"]) - parse_iso(last_close)).days
                line += f', last closed {fmt_date(last_close)} ({days} days before this drive)'
            links = " ".join(f'<a href="{html.escape(c["issue_url"])}" target="_blank" rel="noopener">#{html.escape(c["issue_id"])}</a>'
                             for c in reps if c.get("issue_url"))
            prev = f'<p class="prev">{line}. {links}</p>'
        else:
            prev = f'<p class="new">No city report within {NEAR_M} m. Never reported.</p>'
        owner = owners[k]
        if owner and d["verdict"] != "shadow":
            prev += (f'<p class="to">Report to <b>{html.escape(owner["short"])}</b>, through {html.escape(owner["via"])}. '
                     f'<span>{html.escape(owner["reason"])}</span></p>')
        return (f'<article class="card" id="s{i}"><div class="ph">{img}</div><div class="body">'
                f'<div class="top"><span class="num">#{i}</span><span class="verdict {cls}">{lab}</span>'
                f'<span class="meta">{when} · model {d["confidence"]:.2f} · {d["lat"]:.5f}, {d["lon"]:.5f}</span></div>'
                f'{prev}</div></article>')

    # Confirmed first, then the rest in time order
    order = sorted(range(len(rows)), key=lambda k: (rows[k][0]["verdict"] != "pothole", rows[k][0]["captured_at"]))
    cards = "\n".join(card(n + 1, k, *rows[k]) for n, k in enumerate(order))
    idx = {k: n + 1 for n, k in enumerate(order)}

    mapdata = {
        "route": [[round(p[1], 6), round(p[2], 6)] for p in route],
        "sightings": [{"n": idx[k], "lat": r[0]["lat"], "lon": r[0]["lon"], "v": r[0]["verdict"]}
                      for k, r in enumerate(rows)],
        "prev": [{"lat": p["lat"], "lon": p["lon"], "addr": p.get("address") or "",
                  "n": len(p["city_reports"]), "seen": p["pothole_id"] in seen_ids}
                 for p in potholes
                 if any(haversine_m(p["lat"], p["lon"], r[1], r[2]) <= 300 for r in route[::5] or route)],
    }

    checked = not summary.get("dry_run", False)
    headline = (f"{len(confirmed)} pothole{'s' if len(confirmed) != 1 else ''} confirmed"
                if checked else f"{len(rows)} possible pothole{'s' if len(rows) != 1 else ''} (not checked yet)")

    stats = [
        (f"{dist / 1609.34:.1f} mi", f"driven in {mins:.0f} min"),
        (str(summary.get("frames", "–")), "frames scanned"),
        (str(len(rows)), "sightings by the model"),
        (str(len(confirmed)) if checked else "–", "confirmed by the vision check"),
        (str(len(at_prev)), f"within {NEAR_M} m of an earlier city report"),
        (str(len(back_after_close)) if checked else "–", "potholes back after the city closed it"),
    ]
    stat_html = "".join(f'<div class="stat"><b>{html.escape(v)}</b><span>{html.escape(l)}</span></div>' for v, l in stats)
    breakdown = (f"Vision check: {len(confirmed)} pothole, {len(patched)} patched, {len(rejected)} not a pothole"
                 + (f", {len(unchecked)} not checked" if unchecked else "")
                 + f". The route passed {len(passed)} spot{'s' if len(passed) != 1 else ''} the city has a report for"
                 + f"; we saw something at {len(seen_ids)}.")

    title_date = (start - __import__('datetime').timedelta(hours=5)).strftime("%a %b %-d, %Y · %-I:%M %p")
    page = TEMPLATE.replace("__TITLE__", html.escape(f"Drive report · {title_date}")) \
        .replace("__DATE__", html.escape(title_date)) \
        .replace("__HEADLINE__", html.escape(headline)) \
        .replace("__STATS__", stat_html) \
        .replace("__BREAKDOWN__", html.escape(breakdown)) \
        .replace("__CARDS__", cards or '<p class="empty">The model saw nothing on this drive.</p>') \
        .replace("__DATA__", json.dumps(mapdata))
    path = os.path.join(out, "report.html")
    open(path, "w").write(page)
    print(headline)
    print(breakdown)
    print(f"report: {os.path.abspath(path)}")


TEMPLATE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1c1c1a;--mute:#6b6a65;--line:#e3e1db;
--pothole:#d1452b;--patch:#c28a13;--shadow:#8a8984;--unv:#3b6fb6;--prev:#5a5a57}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151514;--card:#1f1f1d;--ink:#ecebe6;--mute:#9b9a94;--line:#33332f;--prev:#a9a8a2}}
:root[data-theme="dark"]{--bg:#151514;--card:#1f1f1d;--ink:#ecebe6;--mute:#9b9a94;--line:#33332f;--prev:#a9a8a2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.wrap{max-width:1100px;margin:0 auto;padding:24px 16px 64px}
header .k{color:var(--mute);font-size:13px}h1{font-size:30px;margin:4px 0 2px;letter-spacing:-.01em}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin:20px 0 8px}
.stat{background:var(--card);padding:14px 16px}.stat b{display:block;font-size:24px;font-variant-numeric:tabular-nums}.stat span{color:var(--mute);font-size:13px}
.breakdown{color:var(--mute);font-size:14px;margin:8px 0 20px}
#map{height:440px;border-radius:10px;border:1px solid var(--line)}
.legend{display:flex;flex-wrap:wrap;gap:16px;font-size:13px;color:var(--mute);margin:8px 0 28px}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:-1px}
h2{font-size:18px;margin:0 0 12px}
.card{display:grid;grid-template-columns:minmax(0,360px) 1fr;gap:16px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:12px}
.ph img{width:100%;border-radius:6px;display:block}.noimg{aspect-ratio:16/9;display:grid;place-items:center;color:var(--mute);background:var(--bg);border-radius:6px}
.top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px}.num{font-weight:700}
.verdict{font-size:13px;font-weight:600;padding:2px 8px;border-radius:99px;color:#fff}
.v-pothole{background:var(--pothole)}.v-patch{background:var(--patch)}.v-shadow{background:var(--shadow)}.v-unv{background:var(--unv)}
.meta{color:var(--mute);font-size:13px;font-variant-numeric:tabular-nums}
.prev,.new{margin:10px 0 0}.new{color:var(--mute)}a{color:var(--unv)}
.to{margin:6px 0 0}.to span{color:var(--mute)}
.empty{color:var(--mute)}
@media (max-width:640px){.card{grid-template-columns:1fr}h1{font-size:24px}#map{height:320px}}
@media print{#map{height:360px}.card{break-inside:avoid}}
</style></head><body><div class="wrap">
<header><div class="k">Drive report · __DATE__</div><h1>__HEADLINE__</h1></header>
<div class="stats">__STATS__</div>
<p class="breakdown">__BREAKDOWN__</p>
<div id="map"></div>
<div class="legend"><span><i style="background:var(--pothole)"></i>Pothole</span><span><i style="background:var(--patch)"></i>Patched</span><span><i style="background:var(--shadow)"></i>Not a pothole</span><span><i style="background:var(--unv)"></i>Not checked</span><span><i style="background:transparent;border:2px solid var(--prev)"></i>Earlier city report</span></div>
<h2>Sightings</h2>
__CARDS__
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const D = __DATA__;
const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const col = {pothole: css('--pothole'), patch: css('--patch'), shadow: css('--shadow')};
const map = L.map('map', {scrollWheelZoom: false});
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  {attribution: '&copy; OpenStreetMap contributors', maxZoom: 19}).addTo(map);
const line = L.polyline(D.route, {color: '#3b6fb6', weight: 4, opacity: .7}).addTo(map);
for (const p of D.prev) L.circleMarker([p.lat, p.lon], {radius: 7, color: css('--prev'), weight: p.seen ? 3 : 1.5, fill: false})
  .bindTooltip(`${p.addr}: ${p.n} city report${p.n === 1 ? '' : 's'}${p.seen ? ' · seen on this drive' : ''}`).addTo(map);
for (const s of D.sightings) L.circleMarker([s.lat, s.lon], {radius: 6, color: '#fff', weight: 1.5, fillColor: col[s.v] || css('--unv'), fillOpacity: 1})
  .bindTooltip('#' + s.n).on('click', () => document.getElementById('s' + s.n).scrollIntoView({behavior: 'smooth', block: 'center'})).addTo(map);
map.fitBounds(line.getBounds(), {padding: [24, 24]});
</script></body></html>
"""

if __name__ == "__main__":
    main()
