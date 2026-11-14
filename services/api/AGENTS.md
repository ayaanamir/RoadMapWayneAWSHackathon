# Area: Backbone — `api/`, `services/api/`, `apps/map/` (owner: Ayaan)

Also read the root `AGENTS.md` and `shared/CONTRACTS.md` (v2).

## `api/` — Vercel Functions (TypeScript)
One file per endpoint, exactly the paths in the contract:
`api/health.ts`, `api/potholes.ts`, `api/upload.ts`, `api/detections.ts`.
- DB: `import { neon } from '@neondatabase/serverless'; const sql = neon(process.env.DATABASE_URL!)`
- Images: `import { put } from '@vercel/blob'` → `put(name, body, { access: 'public' })` → return `url`.
- `detections`: upsert on `detection_id`; nearest pothole ≤ 50 m (haversine in SQL) else new
  pothole; recompute `state` + `last_seen_at` per the contract's state rule.
- CORS `*` on every response (handle `OPTIONS`).
- Deps go in the root `package.json` (`@neondatabase/serverless`, `@vercel/blob`).

## `services/api/` — scripts run locally
- `schema.sql`: the live DDL (already applied to Neon). Keep it in sync if you change the DB.
- `ingest_city.py`: pull `request_type='Potholes'` from `CITY_FEATURESERVER`
  (`outSR=4326`, bbox around Corktown/Midtown/Southwest, last ~120 days) → upsert
  `city_reports` → group into `potholes` (50 m) → set `pothole_id`. Uses `psycopg` + `DATABASE_URL`.

## Done check
`curl $API_BASE_URL/api/health` → `{"ok":true}`; `curl $API_BASE_URL/api/potholes` returns
the seeded potholes; `vercel dev` runs locally.
