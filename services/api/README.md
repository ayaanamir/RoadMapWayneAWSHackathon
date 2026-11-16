# services/api

City ingest, pothole history and the REST API. Contract: `shared/CONTRACTS.md`.
Rules: `AGENTS.md` here + at repo root. Progress: `ROADMAP.md`.

## Run / deploy
- City ingest: `python3 services/api/ingest_city.py` (stdlib only, reads `DATABASE_URL` from env or `.env`; `--dry-run` to preview). Safe to rerun; last run Sat 2:31 PM: 147 reports → 130 potholes.
- Report check (#133): the city's "Potholes" type also holds sidewalk, curb, debris and bike-lane
  reports. After each ingest the script calls `POST /api/city-check` (internal), which reads each new
  report's SeeClickFix text + photo and asks a small model (`OPENROUTER_MODEL`, key stays on Vercel).
  `not_pothole` reports stay in `city_reports` with `pothole_id = NULL` (not shown). See what was
  rejected: `curl $API_BASE_URL/api/city-check`. Skip with `--no-check`.
- Local: `npm install && vercel dev` (needs `DATABASE_URL` in `.env`; without it `/api/potholes` serves the fixture)
- Deploy: merge to `main` (Vercel auto-deploys)
- Live URL: https://wayneawshackathon.vercel.app (`/api/health`, `/api/potholes`, `/api/upload`, `/api/detections`)
- State rule lives in SQL: `recompute_pothole()` in `schema.sql`, used by `POST /api/detections`
  and at the end of `ingest_city.py`. (`group_city_reports()` is an SQL-only regroup, not used by the script.)

## Server-side vision check
`POST /api/detections` answers right away, then (via `waitUntil`) sends up to 10 `unverified`
detections with a real `https` image to OpenRouter (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL`,
prompt in `api/_lib/verify.ts`), stores `pothole|patch|shadow` + a one-line reason, and re-matches.
A producer's own verdict is never overwritten. `?verify=wait` waits for it; `VERIFY_ON_SERVER=0` turns it off.
Failures leave the detection `unverified` (look for `verify:` in the Vercel logs).

## Test locally (no Vercel deploy)
- Unit: `node --test services/api/tests/*.test.ts`
- End to end, every handler against a **Neon branch** (it writes `smoke-*` detections):
  `SMOKE_DATABASE_URL=<branch url> npx -y tsx services/api/tests/smoke.mts`
  Add the `R2_*` vars to also test a real upload.
- Batches: keep `POST /api/detections` to ≤ 100 per request (100 brand-new potholes ≈ 6.5 s).
