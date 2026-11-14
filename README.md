# Still There? — BuilderWars 2026

**The city closes pothole reports in days. We check whether they actually got fixed.**

Detroit's Improve Detroit reports + drive footage + live phone detection → one map where
every pothole has a timeline: reported → closed → **still there** or **fixed, confirmed**.

## Who owns what

Fill in your GitHub handle. One owner per area — see `AGENTS.md` for the rules.

| Role | Person | GitHub | Areas you write in |
|---|---|---|---|
| Backbone | | | `services/api/`, `apps/map/` |
| Footage | | | `pipeline/` |
| Live + pitch | | | `apps/live/`, `pitch/` |

## Layout

```
apps/
  live/        phone page: camera + YOLO in browser + GPS        (Live)
  map/         map + timeline demo screen                         (Backbone)
services/
  api/         city ingest, history matching, REST API (Lambda)   (Backbone)
pipeline/      drive footage → detections, Bedrock verify         (Footage)
pitch/         script, slides, backup video                       (Live)
shared/        CONTRACTS.md, schemas, fixtures  — LOCKED          (everyone)
docs/          WORKFLOW.md, REQUESTS.md
```

## Start here

0. **Project board:** `python3 scripts/board.py` (or [all issues](https://github.com/ayaanamir/RoadMapWayneAWSHackathon/issues)).
   Claim before you work: `python3 scripts/board.py claim <#> "<you>/<agent>"`.
   **Agent chat:** [issue #1](https://github.com/ayaanamir/RoadMapWayneAWSHackathon/issues/1).
   Read it: `python3 scripts/chat.py read` · post: `python3 scripts/chat.py post "[api] START — …"`
1. Read `docs/WORKFLOW.md` (2 minutes) — how to run your agent without stepping on others.
   Milestones: `ROADMAP.md` (overall) and `<your area>/ROADMAP.md` (your checklist).
2. Read `shared/CONTRACTS.md` — the data shapes every area agrees on.
3. Copy `.env.example` to `.env` and fill in values (never commit `.env`).
4. Open your agent **in your own area folder** and point it at that folder's `AGENTS.md`.

## Checkpoints

| When | Must be true |
|---|---|
| Sat 6:00 PM | Map shows real city reports with timelines (fixtures OK until then) |
| Sat midnight | At least one drive clip processed onto a pin |
| Sun 8:00 AM | Feature freeze. Bug fixes + backup demo video only |
| Sun 11:30 AM | Submitted on Shipyard (hard deadline 12:00) |
