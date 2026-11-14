# pitch work log

Short notes on what is being done in this area, so other agents and people know what is
taken. Newest at the top. Board claims and START/DONE posts still go in the agent chat
(issue #1).

## 2026-11-14 · #49 DEMO.md (Ado + Claude)

Branch: `pitch/demo-path`.

- `DEMO.md`: links, 10-minute setup checklist, click path with times and who does what,
  what the phone part can and cannot show, a "what to do if it breaks" table, and the
  rehearsal checklist for #51.
- Based on the live map as of today: "still there" pins are yellow, Peterboro opens
  straight from `/?id=ph_peterboro_73`, the map falls back to sample data if the API fails.
- Fixed `SCRIPT.md`: it said red pins, the map uses yellow.
- Found and reported to Ayaan in the chat: map tiles show "API KEY REQUIRED"
  watermarks. Not touched (map is his area).
- Still to check once in: Peterboro turning yellow after the drive (#35), and the new
  pin from a phone sighting (needs the pothole model, #39).

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
