# pitch work log

Short notes on what is being done in this area, so other agents and people know what is
taken. Newest at the top. Board claims and START/DONE posts still go in the agent chat
(issue #1).

## 2026-11-14 · #47 script v1 and #48 stat (Ado + Claude)

Branch: `pitch/script-and-stat`.

- `stats/repeat_reports.py` reads the public Improve Detroit data (read only, no key, no
  database writes) and counts closed reports that got reported again within 50 m.
- Result near Newlab, last 12 months: 155 of 588 closed reports (26%), at 91 spots.
  Full table and limits in `STATS.md`.
- `SCRIPT.md` v1 written around the Peterboro story. Spots marked `[fill]` need the drive
  results (#35) and the deploy.

Not touched: anything outside `pitch/`. This script is separate from Backbone's city
ingest (`services/api/`) and does not replace it.

Next in this area: #49 `DEMO.md`, best done once the map (#15 to #18) exists.
