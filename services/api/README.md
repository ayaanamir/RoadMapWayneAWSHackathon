# services/api

City ingest, pothole history and the REST API. Contract: `shared/CONTRACTS.md`.
Rules: `AGENTS.md` here + at repo root. Progress: `ROADMAP.md`.

## Run / deploy
_Owner fills this in as it's built:_
- Local: `npm install && vercel dev` (needs `DATABASE_URL` in `.env`; without it `/api/potholes` serves the fixture)
- Deploy: merge to `main` (Vercel auto-deploys)
- Live URL: https://wayneawshackathon.vercel.app (`/api/health`, `/api/potholes`, `/api/upload`, `/api/detections`)
- City ingest: `pip install -r services/api/requirements.txt && python3 services/api/ingest_city.py`
  (`--dry-run` to just fetch, `--days N` for a longer window). Re-running is safe.
- State rule + 50 m grouping live in SQL (`recompute_pothole()`, `group_city_reports()` in `schema.sql`).

## Test locally (no Vercel deploy)
- Unit: `node --test services/api/tests/*.test.ts`
- End to end, every handler against a **Neon branch** (it writes `smoke-*` detections):
  `SMOKE_DATABASE_URL=<branch url> npx -y tsx services/api/tests/smoke.mts`
  Add the `R2_*` vars to also test a real upload.
- Batches: keep `POST /api/detections` to ≤ 100 per request (100 brand-new potholes ≈ 6.5 s).
