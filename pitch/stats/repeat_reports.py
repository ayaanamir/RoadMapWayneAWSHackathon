#!/usr/bin/env python3
"""Pitch stat (#48): how many pothole reports near us were closed, then reported again.

Uses the public Improve Detroit data (no key needed). Standard library only.

    python3 pitch/stats/repeat_reports.py              # our area, last 120 days
    python3 pitch/stats/repeat_reports.py --days 365   # longer window
    python3 pitch/stats/repeat_reports.py --citywide   # all of Detroit

What counts as "reported again":
    A pothole report was marked Closed, and AFTER the day it was closed, someone filed a
    new pothole report within 50 m of it. 50 m is the same distance our matching rule
    uses (shared/CONTRACTS.md), because city locations can be 10 to 50 m off.

Two reports filed the same afternoon (before any closing) do NOT count. Those are just
duplicates, not proof the fix failed.

This is a pitch number only. It does not write to the database; Backbone's ingest
(services/api/) is the source of truth for the app.
"""
import argparse
import json
import math
import statistics
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

FEATURESERVER = (
    "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/"
    "improve_detroit/FeatureServer/0/query"
)

# Box around Newlab / Corktown / Midtown / Southwest Detroit (west, south, east, north).
OUR_AREA = (-83.13, 42.30, -83.04, 42.36)

SAME_SPOT_METERS = 50
PAGE_SIZE = 2000


def fetch_reports(days, box):
    """Download pothole reports created in the last `days` days, inside `box` if given."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    params = {
        "where": f"request_type = 'Potholes' AND created_at >= DATE '{since}'",
        "outFields": "issue_id,address,status,created_at,closed_at,latitude,longitude",
        "returnGeometry": "false",
        "orderByFields": "ObjectId",
        "f": "json",
    }
    if box:
        # Filter on the city's own latitude/longitude columns. (The map-shape filter
        # the server offers returned nothing for this layer.)
        west, south, east, north = box
        params["where"] += (
            f" AND latitude BETWEEN {south} AND {north}"
            f" AND longitude BETWEEN {west} AND {east}"
        )

    reports, offset = [], 0
    while True:
        page = {**params, "resultOffset": offset, "resultRecordCount": PAGE_SIZE}
        url = FEATURESERVER + "?" + urllib.parse.urlencode(page)
        with urllib.request.urlopen(url, timeout=60) as r:
            data = json.load(r)
        if "error" in data:
            raise SystemExit(f"City data error: {data['error']}")
        rows = [f["attributes"] for f in data.get("features", [])]
        reports += [clean(r) for r in rows if r.get("latitude") and r.get("longitude")]
        if not data.get("exceededTransferLimit") and len(rows) < PAGE_SIZE:
            return reports
        offset += len(rows)


def clean(row):
    """City dates are milliseconds since 1970. Turn them into real dates."""
    def when(ms):
        return datetime.fromtimestamp(ms / 1000, timezone.utc) if ms else None

    return {
        "id": str(int(row["issue_id"])),
        "address": row.get("address") or "",
        "status": row.get("status") or "",
        "created": when(row.get("created_at")),
        "closed": when(row.get("closed_at")),
        "lat": row["latitude"],
        "lon": row["longitude"],
    }


def meters_apart(a, b):
    """Distance between two reports in meters (good enough at city scale)."""
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    dx = math.radians(b["lon"] - a["lon"]) * math.cos(lat) * 6_371_000
    dy = math.radians(b["lat"] - a["lat"]) * 6_371_000
    return math.hypot(dx, dy)


def find_repeats(reports):
    """For each closed report, look for a later report at the same spot."""
    closed = [r for r in reports if r["closed"] and r["status"] in ("Closed", "Archived")]
    repeats = []
    for old in closed:
        later = [
            new for new in reports
            if new["created"] > old["closed"] and meters_apart(old, new) <= SAME_SPOT_METERS
        ]
        if later:
            first_again = min(later, key=lambda n: n["created"])
            repeats.append((old, first_again))
    return closed, repeats


def count_spots(pairs):
    """Group repeat reports that are within 50 m of each other into one 'spot'."""
    spots = []
    for old, _ in pairs:
        if not any(meters_apart(old, s) <= SAME_SPOT_METERS for s in spots):
            spots.append(old)
    return spots


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--days", type=int, default=120)
    parser.add_argument("--citywide", action="store_true")
    args = parser.parse_args()

    box = None if args.citywide else OUR_AREA
    where = "all of Detroit" if args.citywide else "Newlab / Corktown / Midtown / Southwest"
    reports = fetch_reports(args.days, box)
    closed, repeats = find_repeats(reports)
    spots = count_spots(repeats)

    days_to_close = [(r["closed"] - r["created"]).total_seconds() / 86400 for r in closed]
    days_until_again = [(new["created"] - old["closed"]).days for old, new in repeats]

    print(f"Area: {where}, last {args.days} days")
    print(f"Pothole reports filed:             {len(reports)}")
    print(f"Marked Closed/Archived:            {len(closed)}")
    if days_to_close:
        print(f"Median days to close:              {statistics.median(days_to_close):.1f}")
    share = 100 * len(repeats) / len(closed) if closed else 0
    print(f"Closed, then reported again:       {len(repeats)}  ({share:.0f}% of closed)")
    print(f"Distinct spots reported again:     {len(spots)}")
    if days_until_again:
        print(f"Median days from closed to new report: {statistics.median(days_until_again):.0f}")

    # The worst spots make good examples for the pitch.
    by_spot = {}
    for old, new in repeats:
        key = next(s["id"] for s in spots if meters_apart(old, s) <= SAME_SPOT_METERS)
        by_spot.setdefault(key, set()).update({old["id"], new["id"]})
    worst = sorted(by_spot.items(), key=lambda kv: -len(kv[1]))[:5]
    print("\nMost re-reported spots (reports involved):")
    for spot_id, ids in worst:
        spot = next(s for s in spots if s["id"] == spot_id)
        print(f"  {len(ids):>2}  {spot['address']}")


if __name__ == "__main__":
    main()
