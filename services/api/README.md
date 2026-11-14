# services/api

City ingest, pothole history and the REST API. Contract: `shared/CONTRACTS.md`.
Rules: `AGENTS.md` here + at repo root. Progress: `ROADMAP.md`.

## Run / deploy
_Owner fills this in as it's built:_
- Local: `npm install && vercel dev` (needs `DATABASE_URL` in `.env`; without it `/api/potholes` serves the fixture)
- Deploy: merge to `main` (Vercel auto-deploys)
- Live URL: https://wayneawshackathon.vercel.app (`/api/health`, `/api/potholes`)
