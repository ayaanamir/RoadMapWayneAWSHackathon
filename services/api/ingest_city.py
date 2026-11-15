#!/usr/bin/env python3
"""City ingest (#5-#8): Improve Detroit pothole reports -> Neon.

    python3 services/api/ingest_city.py            # last 120 days, our area
    python3 services/api/ingest_city.py --days 365
    python3 services/api/ingest_city.py --dry-run  # fetch + group, write nothing
    python3 services/api/ingest_city.py --dry-run --check   # also run the model check, print verdicts
    python3 services/api/ingest_city.py --recheck  # re-run the model check on every report

Standard library only (no pip install). Reads DATABASE_URL (and OPENROUTER_API_KEY)
from the environment or the repo's .env, and talks to Neon over its HTTPS SQL endpoint.

What it does:
1. Pulls request_type='Potholes' from the city FeatureServer inside our box.
1b. Report check: the city's 'Potholes' type also holds sidewalk, curb, debris and bike-lane
   reports. For each report not checked yet, it reads the SeeClickFix text + photo and asks a
   small OpenRouter model (CITY_CHECK_MODEL) "is this a pothole / broken road surface?".
   Verdict is stored on city_reports (check_verdict/_reason/_model). 'not_pothole' reports are
   kept with pothole_id = NULL (not shown, like rejected detections). No key or a failed call =
   unchecked, shown as before. Also fills photo_url from the SeeClickFix photo.
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
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

FEATURESERVER = os.environ.get(
    "CITY_FEATURESERVER",
    "https://services2.arcgis.com/qvkbeam7Wirps6zC/arcgis/rest/services/improve_detroit/FeatureServer/0",
)
# Newlab / Corktown / Midtown / Southwest (west, south, east, north). Same box as pitch/stats.
BOX = (-83.13, 42.30, -83.04, 42.36)
SAME_SPOT_M = 50
PAGE = 2000
SCF_ISSUE = "https://seeclickfix.com/api/v2/issues/{}"
UA = "still-there-ingest/1.0"
CHECK_MODEL = os.environ.get("CITY_CHECK_MODEL") or "google/gemini-3.5-flash-lite"
CHECK_PROMPT = """You sort Detroit 311 reports that were filed under "Potholes".
Decide if this report is about a pothole or broken road surface where cars drive.

City's current category: {summary}
Address: {address}
Reporter's text: {text}
{photo}
Answer with ONLY this JSON, nothing else:
{{"verdict": "pothole" | "not_pothole", "reason": "<one short sentence>"}}

- "pothole": a hole, broken or missing asphalt, sinkhole, sunken or buckled pavement in a
  street, alley, intersection, bike lane or driveway entrance.
- "not_pothole": sidewalk, curb, something blocking the road (barrel, debris, trash, cars),
  weeds, lights, signs, flooding, or anything that isn't damage to the driving surface.
If the text is empty or only says pothole/hole and the photo doesn't show something else,
say "pothole"."""


# ---------- config ----------

def env_var(name):
    if os.environ.get(name):
        return os.environ[name]
    env = pathlib.Path(__file__).resolve().parents[2] / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].split("#")[0].strip().strip('"').strip("'") or None
    return None


def database_url():
    return env_var("DATABASE_URL") or sys.exit("DATABASE_URL not set (env var or .env at the repo root)")


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


# ---------- report check (SeeClickFix text + photo -> small model) ----------

def scf_issue(issue_id):
    """SeeClickFix's public record for a report: category, text, photo. None if unavailable."""
    req = urllib.request.Request(SCF_ISSUE.format(issue_id),
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            d = json.load(r)
    except Exception as e:
        print(f"  seeclickfix {issue_id}: {e}")
        return None
    return {
        "summary": (d.get("summary") or "").strip(),
        "text": (d.get("description") or "").strip(),
        "photo": (d.get("media") or {}).get("image_full"),
    }


def parse_check(text):
    """{"verdict","reason"} from a model reply, or None."""
    text = text or ""
    i, j = text.find("{"), text.rfind("}")
    verdict = reason = ""
    if i >= 0 and j > i:
        try:
            obj = json.loads(text[i:j + 1])
            verdict = str(obj.get("verdict", "")).strip().lower()
            reason = str(obj.get("reason", "")).strip()
        except ValueError:
            pass
    if not verdict:
        low = text.lower()
        verdict = "not_pothole" if "not_pothole" in low else ("pothole" if "pothole" in low else "")
    if verdict not in ("pothole", "not_pothole"):
        return None
    return {"verdict": verdict, "reason": (reason or verdict)[:300]}


def ask_model(key, prompt, photo):
    content = [{"type": "text", "text": prompt}]
    if photo:
        content.append({"type": "image_url", "image_url": {"url": photo}})
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps({"model": CHECK_MODEL, "temperature": 0, "max_tokens": 150,
                         "messages": [{"role": "user", "content": content}]}).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        reply = json.load(r)["choices"][0]["message"]["content"]
    return parse_check(reply if isinstance(reply, str) else json.dumps(reply))


def check_report(r, key):
    """Fills r's check_verdict/_reason/_model (+ photo_url). Leaves them unset on any failure."""
    scf = scf_issue(r["issue_id"])
    if not scf:
        return r
    if scf["photo"]:
        r["photo_url"] = scf["photo"]
    base = dict(summary=scf["summary"] or "Potholes", address=r.get("address") or "unknown",
                text=scf["text"][:1500] or "(none)")
    got = None
    # Try with the photo first; if OpenRouter can't load it, ask again on the text alone.
    for photo in ([scf["photo"], None] if scf["photo"] else [None]):
        prompt = CHECK_PROMPT.format(**base, photo="The reporter's photo is attached." if photo else "No photo.")
        try:
            got = ask_model(key, prompt, photo)
            if got:
                break
        except Exception as e:
            print(f"  check {r['issue_id']}: {e}")
    if got:
        r["check_verdict"], r["check_reason"], r["check_model"] = got["verdict"], got["reason"], CHECK_MODEL
    return r


def check_reports(reports, key, recheck=False):
    todo = [r for r in reports if recheck or not r.get("check_verdict")]
    if not todo:
        return
    print(f"checking {len(todo)} reports with {CHECK_MODEL} ...")
    with ThreadPoolExecutor(3) as ex:  # gentle on SeeClickFix
        list(ex.map(lambda r: check_report(r, key), todo))
    bad = [r for r in todo if r.get("check_verdict") == "not_pothole"]
    done = sum(1 for r in todo if r.get("check_verdict"))
    print(f"checked {done}/{len(todo)}: {len(bad)} not a pothole")
    for r in bad:
        print(f"  x {r['issue_id']} {r.get('address', '')[:40]}: {r['check_reason']}")


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
    ap.add_argument("--check", action="store_true", help="with --dry-run: also run the model check")
    ap.add_argument("--recheck", action="store_true", help="re-run the model check on every report")
    args = ap.parse_args()

    fresh = fetch_city(args.days)
    print(f"city: {len(fresh)} pothole reports in the box, last {args.days} days")

    url = None if args.dry_run else database_url()
    ts = lambda c: f"to_char({c} AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')"
    old = [] if args.dry_run else sql(url, f"""
        SELECT issue_id, address, lat, lon, status, {ts('created_at')} AS created_at,
               {ts('closed_at')} AS closed_at, issue_url, photo_url, pothole_id,
               check_verdict, check_reason, check_model FROM city_reports""")
    for r in old:
        r["lat"], r["lon"] = float(r["lat"]), float(r["lon"])

    # Fresh data wins; older reports already in Neon stay in the grouping.
    merged = {r["issue_id"]: r for r in old}
    merged.update({r["issue_id"]: {**merged.get(r["issue_id"], {}), **r} for r in fresh})
    reports = list(merged.values())

    key = env_var("OPENROUTER_API_KEY")
    if key and (not args.dry_run or args.check):
        check_reports(reports, key, args.recheck)
    elif not args.dry_run or args.check:
        print("OPENROUTER_API_KEY not set: skipping the report check (new reports shown unchecked)")

    # Reports the check rejected are kept but join no pothole (not shown on the map).
    kept = [r for r in reports if r.get("check_verdict") != "not_pothole"]
    assign = group(kept, {r["issue_id"]: r.get("pothole_id") for r in old})
    for r in reports:
        r["pothole_id"] = assign.get(r["issue_id"])

    members = {}
    for r in kept:
        members.setdefault(r["pothole_id"], []).append(r)
    print(f"{len(kept)} of {len(reports)} reports kept; grouped into {len(members)} potholes "
          f"({sum(len(v) > 1 for v in members.values())} with 2+ reports)")
    if args.dry_run:
        top = sorted(members.items(), key=lambda kv: -len(kv[1]))[:5]
        for pid, rs in top:
            print(f"  {pid}: {len(rs)} reports, {rs[0]['address']}")
        return

    # Upsert city_reports.
    cols = ("issue_id", "address", "lat", "lon", "status", "created_at", "closed_at", "issue_url",
            "photo_url", "pothole_id", "check_verdict", "check_reason", "check_model")
    sql(url, """
        INSERT INTO city_reports (issue_id, address, lat, lon, status, created_at, closed_at, issue_url,
                                  photo_url, pothole_id, check_verdict, check_reason, check_model)
        SELECT issue_id, address, lat, lon, status, created_at, closed_at, issue_url,
               photo_url, pothole_id, check_verdict, check_reason, check_model
          FROM jsonb_to_recordset($1::jsonb) AS x(issue_id text, address text, lat float8, lon float8,
               status text, created_at timestamptz, closed_at timestamptz, issue_url text,
               photo_url text, pothole_id text, check_verdict text, check_reason text, check_model text)
        ON CONFLICT (issue_id) DO UPDATE SET
          address = EXCLUDED.address, lat = EXCLUDED.lat, lon = EXCLUDED.lon, status = EXCLUDED.status,
          created_at = EXCLUDED.created_at, closed_at = EXCLUDED.closed_at,
          issue_url = EXCLUDED.issue_url, pothole_id = EXCLUDED.pothole_id,
          photo_url = coalesce(EXCLUDED.photo_url, city_reports.photo_url),
          check_verdict = coalesce(EXCLUDED.check_verdict, city_reports.check_verdict),
          check_reason = coalesce(EXCLUDED.check_reason, city_reports.check_reason),
          check_model = coalesce(EXCLUDED.check_model, city_reports.check_model)""",
        [json.dumps([{k: r.get(k) for k in cols} for r in reports])])

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

    # The API's state rule lives in SQL (recompute_pothole() in schema.sql). Re-run it so
    # the ingest and POST /api/detections never disagree about a pothole's state.
    sql(url, "SELECT recompute_pothole(pothole_id) FROM potholes")
    counts = {r["state"]: int(r["n"]) for r in
              sql(url, "SELECT state, count(*) AS n FROM potholes GROUP BY state")}
    print(f"wrote {len(reports)} city_reports, {len(rows)} potholes; states: {counts}")


if __name__ == "__main__":
    main()
