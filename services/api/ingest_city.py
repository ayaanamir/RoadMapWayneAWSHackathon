#!/usr/bin/env python3
"""City ingest (#5 #6 #7): Improve Detroit pothole reports -> Neon.

    pip install -r services/api/requirements.txt
    DATABASE_URL=... python3 services/api/ingest_city.py            # last 120 days
    python3 services/api/ingest_city.py --days 365                  # longer window
    python3 services/api/ingest_city.py --dry-run                   # fetch + summary, no DB
    python3 services/api/ingest_city.py --sql out.sql               # write the SQL instead

Steps:
  1. pull request_type='Potholes' from CITY_FEATURESERVER (lat/lon in WGS84) inside the box
     around Newlab / Corktown / Midtown / Southwest, created in the last --days days
  2. upsert into city_reports (epoch ms -> ISO UTC). pothole_id is never overwritten.
  3. SELECT group_city_reports()  -- 50 m grouping + state, see services/api/schema.sql

Re-running is safe. DATABASE_URL is read from the environment or the repo-root .env.
"""
import argparse
import json
import os
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

FEATURESERVER = os.environ.get(
    "CITY_FEATURESERVER",
    "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/improve_detroit/FeatureServer/0",
)
# (west, south, east, north) — same box as pitch/stats/repeat_reports.py
AREA = (-83.13, 42.30, -83.04, 42.36)
PAGE = 2000
STATUSES = {"Open", "Closed", "Archived"}  # anything else the city sends counts as Open

UPSERT_SQL = """
INSERT INTO city_reports (issue_id, address, lat, lon, status, created_at, closed_at, issue_url)
SELECT issue_id, address, lat, lon, status, created_at, closed_at, issue_url
  FROM jsonb_to_recordset(%s::jsonb) AS x(issue_id text, address text, lat float8, lon float8,
       status text, created_at timestamptz, closed_at timestamptz, issue_url text)
ON CONFLICT (issue_id) DO UPDATE SET
  address = EXCLUDED.address, lat = EXCLUDED.lat, lon = EXCLUDED.lon, status = EXCLUDED.status,
  created_at = EXCLUDED.created_at, closed_at = EXCLUDED.closed_at, issue_url = EXCLUDED.issue_url
"""


def iso(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(ms / 1000, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def fetch(days, area=AREA):
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    west, south, east, north = area
    params = {
        # The server's geometry filter returns nothing for this layer, so filter on the
        # city's own latitude/longitude columns (same as pitch/stats).
        "where": (
            f"request_type = 'Potholes' AND created_at >= DATE '{since}'"
            f" AND latitude BETWEEN {south} AND {north} AND longitude BETWEEN {west} AND {east}"
        ),
        "outFields": "issue_id,address,status,created_at,closed_at,issue_url,latitude,longitude",
        "returnGeometry": "false",
        "outSR": "4326",
        "orderByFields": "ObjectId",
        "f": "json",
    }
    rows, offset = [], 0
    while True:
        q = {**params, "resultOffset": offset, "resultRecordCount": PAGE}
        url = FEATURESERVER.rstrip("/") + "/query?" + urllib.parse.urlencode(q)
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.load(r)
        if "error" in data:
            sys.exit(f"city API error: {data['error']}")
        page = [f["attributes"] for f in data.get("features", [])]
        rows += page
        if not data.get("exceededTransferLimit") and len(page) < PAGE:
            return [clean(a) for a in rows if a.get("latitude") and a.get("longitude")]
        offset += len(page)


def clean(a):
    issue_id = str(a["issue_id"])
    status = a.get("status") if a.get("status") in STATUSES else "Open"
    return {
        "issue_id": issue_id,
        "address": (a.get("address") or "").strip(),
        "lat": float(a["latitude"]),
        "lon": float(a["longitude"]),
        "status": status,
        "created_at": iso(a.get("created_at")),
        # A closed_at without Closed/Archived would confuse the state rule.
        "closed_at": iso(a.get("closed_at")) if status != "Open" else None,
        "issue_url": a.get("issue_url") or f"https://seeclickfix.com/issues/{issue_id}",
    }


def database_url():
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    env = Path(__file__).resolve().parents[2] / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].split("#")[0].strip().strip('"')
    return None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--days", type=int, default=120)
    ap.add_argument("--dry-run", action="store_true", help="fetch and summarise, don't touch the DB")
    ap.add_argument("--sql", metavar="FILE", help="write the SQL to FILE instead of running it")
    args = ap.parse_args()

    reports = [r for r in fetch(args.days) if r["created_at"]]
    by_status = {}
    for r in reports:
        by_status[r["status"]] = by_status.get(r["status"], 0) + 1
    print(f"fetched {len(reports)} pothole reports from the last {args.days} days: {by_status}")
    if args.dry_run or not reports:
        return

    payload = json.dumps(reports)
    if args.sql:
        literal = "'" + payload.replace("'", "''") + "'"
        Path(args.sql).write_text(
            "BEGIN;\n" + UPSERT_SQL.replace("%s", literal) + ";\nSELECT group_city_reports();\nCOMMIT;\n"
        )
        print(f"wrote {args.sql}")
        return

    url = database_url()
    if not url:
        sys.exit("DATABASE_URL not set (env or repo-root .env). Use --dry-run or --sql FILE.")
    import psycopg  # only needed for the real run

    with psycopg.connect(url) as conn, conn.cursor() as cur:
        cur.execute(UPSERT_SQL, (payload,))
        cur.execute("SELECT group_city_reports()")
        created = cur.fetchone()[0]
        cur.execute("SELECT state, count(*) FROM potholes GROUP BY state ORDER BY state")
        states = dict(cur.fetchall())
    print(f"upserted {len(reports)} reports, created {created} new potholes; potholes by state: {states}")


if __name__ == "__main__":
    main()
