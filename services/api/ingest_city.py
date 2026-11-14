#!/usr/bin/env python3
"""City ingest (#5-#8): Improve Detroit pothole reports -> Neon.

    python3 services/api/ingest_city.py            # last 120 days, our area
    python3 services/api/ingest_city.py --days 365
    python3 services/api/ingest_city.py --dry-run  # fetch + group, write nothing

Standard library only (no pip install). Reads DATABASE_URL from the environment or
the repo's .env, and talks to Neon over its HTTPS SQL endpoint.

What it does:
1. Pulls request_type='Potholes' from the city FeatureServer inside our box.
2. Groups reports into potholes. A report keeps the pothole it already has in Neon
   (so the seeded Peterboro / Newark / Wabash ids and any detections on them stay
   put). Otherwise it joins the nearest pothole whose first report is within 50 m,
   or starts a new one with id ph_<issue_id>. IDs never change between runs.
3. Upserts city_reports and potholes (lat/lon = average of the pothole's reports,
   address = newest report's address). photo_url is never overwritten with null.
4. Recomputes state + last_seen_at for every pothole (rule in shared/CONTRACTS.md).

Safe to rerun any time.
"""
import argparse
import json
import math
import os
import pathlib
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

FEATURESERVER = os.environ.get(
    "CITY_FEATURESERVER",
    "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/improve_detroit/FeatureServer/0",
)
# Newlab / Corktown / Midtown / Southwest (west, south, east, north). Same box as pitch/stats.
BOX = (-83.13, 42.30, -83.04, 42.36)
SAME_SPOT_M = 50
PAGE = 2000


# ---------- config ----------

def database_url():
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env = pathlib.Path(__file__).resolve().parents[2] / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].split("#")[0].strip().strip('"').strip("'")
    sys.exit("DATABASE_URL not set (env var or .env at the repo root)")


# ---------- Neon over HTTPS ----------

def sql(url, query, params=()):
    """Run one statement on Neon's HTTP endpoint and return rows as dicts."""
    host = urllib.parse.urlparse(url).hostname
    req = urllib.request.Request(
        f"https://{host}/sql",
        data=json.dumps({"query": query, "params": list(params)}).encode(),
        headers={
            "Content-Type": "application/json",
            "Neon-Connection-String": url,
            "Neon-Raw-Text-Output": "true",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r).get("rows", [])
    except urllib.error.HTTPError as e:
        sys.exit(f"Neon error {e.code}: {e.read().decode()[:500]}")


# ---------- city data ----------

def iso(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch_city(days):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    west, south, east, north = BOX
    params = {
        # Filter on the city's own latitude/longitude columns; the geometry filter
        # returns nothing on this layer (found while building pitch/stats).
        "where": (
            f"request_type = 'Potholes' AND created_at >= DATE '{since}'"
            f" AND latitude BETWEEN {south} AND {north}"
            f" AND longitude BETWEEN {west} AND {east}"
        ),
        "outFields": "issue_id,address,status,created_at,closed_at,latitude,longitude",
        "returnGeometry": "false",
        "orderByFields": "ObjectId",
        "f": "json",
    }
    out, offset = [], 0
    while True:
        q = {**params, "resultOffset": offset, "resultRecordCount": PAGE}
        with urllib.request.urlopen(f"{FEATURESERVER}/query?{urllib.parse.urlencode(q)}", timeout=60) as r:
            data = json.load(r)
        if "error" in data:
            sys.exit(f"City API error: {data['error']}")
        rows = [f["attributes"] for f in data.get("features", [])]
        for a in rows:
            if a.get("latitude") and a.get("longitude") and a.get("issue_id"):
                out.append(clean(a))
        if not data.get("exceededTransferLimit") and len(rows) < PAGE:
            return out
        offset += len(rows)


def clean(a):
    status = a.get("status") or ""
    if status not in ("Closed", "Archived"):
        status = "Open"  # Acknowledged / Open / anything else the city uses
    issue_id = str(int(a["issue_id"]))
    return {
        "issue_id": issue_id,
        "address": (a.get("address") or "").strip(),
        "lat": float(a["latitude"]),
        "lon": float(a["longitude"]),
        "status": status,
        "created_at": iso(a.get("created_at")),
        "closed_at": iso(a.get("closed_at")) if status != "Open" else None,
        "issue_url": f"https://seeclickfix.com/issues/{issue_id}",
    }


# ---------- grouping ----------

def meters(a, b):
    lat = math.radians((a[0] + b[0]) / 2)
    dx = math.radians(b[1] - a[1]) * math.cos(lat) * 6_371_000
    dy = math.radians(b[0] - a[0]) * 6_371_000
    return math.hypot(dx, dy)


def group(reports, existing):
    """reports: all city reports (fresh + already in Neon). existing: issue_id -> pothole_id.
    Returns issue_id -> pothole_id. Existing assignments never change."""
    assign = {r["issue_id"]: existing[r["issue_id"]] for r in reports if existing.get(r["issue_id"])}
    by_time = sorted(reports, key=lambda r: r["created_at"] or "")
    # Anchor = location of each pothole's earliest report.
    anchors = {}
    for r in by_time:
        pid = assign.get(r["issue_id"])
        if pid and pid not in anchors:
            anchors[pid] = (r["lat"], r["lon"])
    for r in by_time:
        if r["issue_id"] in assign:
            continue
        here = (r["lat"], r["lon"])
        best, best_d = None, SAME_SPOT_M
        for pid, at in anchors.items():
            d = meters(here, at)
            if d <= best_d:
                best, best_d = pid, d
        if not best:
            best = f"ph_{r['issue_id']}"
            anchors[best] = here
        assign[r["issue_id"]] = best
    return assign


# ---------- state (shared/CONTRACTS.md v3) ----------

def state_for(reports, detections):
    """reports/detections for one pothole, ISO strings. Returns (state, last_seen_at)."""
    dets = sorted(detections, key=lambda d: d["captured_at"])
    last_seen = dets[-1]["captured_at"] if dets else None
    if not reports:
        hits = sum(d["verdict"] == "pothole" for d in dets)
        return ("unreported" if hits >= 1 or len(dets) >= 2 else "unknown"), last_seen
    if not dets:
        return "reported_only", last_seen
    latest = max(reports, key=lambda r: r["created_at"])
    if latest["status"] in ("Closed", "Archived") and latest["closed_at"]:
        after = [d for d in dets if d["captured_at"] > latest["closed_at"]]
        if any(d["verdict"] == "pothole" for d in after):
            return "still_there", last_seen
        if after and after[-1]["verdict"] == "patch":
            return "fixed_confirmed", last_seen
    return "unknown", last_seen


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    fresh = fetch_city(args.days)
    print(f"city: {len(fresh)} pothole reports in the box, last {args.days} days")

    url = None if args.dry_run else database_url()
    ts = lambda c: f"to_char({c} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"
    old = [] if args.dry_run else sql(url, f"""
        SELECT issue_id, address, lat, lon, status, {ts('created_at')} AS created_at,
               {ts('closed_at')} AS closed_at, issue_url, pothole_id FROM city_reports""")
    for r in old:
        r["lat"], r["lon"] = float(r["lat"]), float(r["lon"])

    # Fresh data wins; older reports already in Neon stay in the grouping.
    merged = {r["issue_id"]: r for r in old}
    merged.update({r["issue_id"]: {**merged.get(r["issue_id"], {}), **r} for r in fresh})
    reports = list(merged.values())
    assign = group(reports, {r["issue_id"]: r.get("pothole_id") for r in old})
    for r in reports:
        r["pothole_id"] = assign[r["issue_id"]]

    members = {}
    for r in reports:
        members.setdefault(r["pothole_id"], []).append(r)
    print(f"grouped into {len(members)} potholes "
          f"({sum(len(v) > 1 for v in members.values())} with 2+ reports)")
    if args.dry_run:
        top = sorted(members.items(), key=lambda kv: -len(kv[1]))[:5]
        for pid, rs in top:
            print(f"  {pid}: {len(rs)} reports, {rs[0]['address']}")
        return

    # Upsert city_reports.
    sql(url, """
        INSERT INTO city_reports (issue_id, address, lat, lon, status, created_at, closed_at, issue_url, pothole_id)
        SELECT issue_id, address, lat, lon, status, created_at, closed_at, issue_url, pothole_id
          FROM jsonb_to_recordset($1::jsonb) AS x(issue_id text, address text, lat float8, lon float8,
               status text, created_at timestamptz, closed_at timestamptz, issue_url text, pothole_id text)
        ON CONFLICT (issue_id) DO UPDATE SET
          address = EXCLUDED.address, lat = EXCLUDED.lat, lon = EXCLUDED.lon, status = EXCLUDED.status,
          created_at = EXCLUDED.created_at, closed_at = EXCLUDED.closed_at,
          issue_url = EXCLUDED.issue_url, pothole_id = EXCLUDED.pothole_id""",
        [json.dumps([{k: r[k] for k in ("issue_id", "address", "lat", "lon", "status", "created_at",
                                        "closed_at", "issue_url", "pothole_id")} for r in reports])])

    # Detections already attached, for state.
    dets = sql(url, f"""SELECT pothole_id, verdict, {ts('captured_at')} AS captured_at
                        FROM detections WHERE pothole_id IS NOT NULL""")
    dets_by = {}
    for d in dets:
        dets_by.setdefault(d["pothole_id"], []).append(d)

    rows = []
    for pid, rs in members.items():
        newest = max(rs, key=lambda r: r["created_at"])
        state, last_seen = state_for(rs, dets_by.get(pid, []))
        rows.append({
            "pothole_id": pid,
            "lat": sum(r["lat"] for r in rs) / len(rs),
            "lon": sum(r["lon"] for r in rs) / len(rs),
            "address": newest["address"],
            "state": state,
            "last_seen_at": last_seen,
        })
    sql(url, """
        INSERT INTO potholes (pothole_id, lat, lon, address, state, last_seen_at, updated_at)
        SELECT pothole_id, lat, lon, address, state, last_seen_at, now()
          FROM jsonb_to_recordset($1::jsonb) AS x(pothole_id text, lat float8, lon float8,
               address text, state text, last_seen_at timestamptz)
        ON CONFLICT (pothole_id) DO UPDATE SET
          lat = EXCLUDED.lat, lon = EXCLUDED.lon, address = EXCLUDED.address,
          state = EXCLUDED.state, last_seen_at = EXCLUDED.last_seen_at, updated_at = now()""",
        [json.dumps(rows)])

    counts = {}
    for r in rows:
        counts[r["state"]] = counts.get(r["state"], 0) + 1
    print(f"wrote {len(reports)} city_reports, {len(rows)} potholes; states: {counts}")


if __name__ == "__main__":
    main()
