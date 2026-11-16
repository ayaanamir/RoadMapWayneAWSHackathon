# Still There?

![The live phone page boxes a pothole on a real Detroit drive, then the vision check confirms it and it goes on the map](pitch/media/demo.gif)

**The city closes pothole reports in days. We check whether they actually got fixed.**

Detroit marks most pothole reports closed within about two days, but nobody goes back to look at the road. Still There? pulls the city's public pothole reports, scans the road with a phone on the windshield, and shows each pothole's history on one map: reported, closed, and then still there or fixed.

Built in 24 hours by a team of three at the Wayne AWS Hackathon, November 14 to 15, 2026.

## Links

- Map: https://wayneawshackathon.vercel.app/
- Phone camera page: https://wayneawshackathon.vercel.app/live
- Test drive write-up, with video and the full drive report: https://still-there-drives.vercel.app/

## Results

- **The problem is real.** Near Newlab, 155 of 588 closed pothole reports (26%) were reported again at the same spot within a year. That is 91 different spots. Source and method: `pitch/STATS.md`.
- **The check works on a real drive.** On a 7 minute, 1.6 mile drive through Corktown, the phone sent 105 sightings. The vision check confirmed 1 new pothole the city had no report for, labeled 22 as old repairs, and rejected 82 as cracks, paint, or shadows.

## How It Works

1. **City data.** We pull pothole reports from Improve Detroit, the city's open data, and group reports within 50 m into one pothole.
2. **Detection.** A small YOLO model runs in the phone's browser with ONNX Runtime Web, so it keeps up with a moving car. Only frames with a box are sent, along with GPS.
3. **Second check.** A larger vision model on the server reviews each frame and answers pothole, patched, or not a pothole, with a one-line reason. Only a confirmed pothole changes the map.
4. **Map and report.** Each pin shows its timeline. Any pin can become a repair request addressed to the road owner: the City of Detroit, or the state (MDOT) for state routes and freeways.

```
Improve Detroit reports            Phone or dash cam
          |                               |
          | services/api/ingest_city.py   | YOLO in the browser (apps/live)
          v                               v
   +---------------------- API on Vercel (api/) ----------------------+
   |  photo     -> Cloudflare R2                                      |
   |  sighting  -> vision check (OpenRouter): pothole, patch, shadow  |
   |  all data  -> Neon Postgres                                      |
   +-------------------------------------------------------------------+
                                  |
                                  v
                Map, timeline, and repair request (apps/map)
```

## Team

| Role | Person | GitHub | Folders |
|---|---|---|---|
| Backend, database, map | Ayaan | [@ayaanamir](https://github.com/ayaanamir) | `api/`, `services/api/`, `apps/map/` |
| Drive footage and model training | Muq | [@MuqC](https://github.com/MuqC) | `pipeline/` |
| Phone page and pitch | Ado | [@ado11231](https://github.com/ado11231) | `apps/live/`, `pitch/` |

## Tech Stack

- Pothole model: YOLO11, run in the browser with ONNX Runtime Web (WebGPU, WASM fallback)
- Vision check: OpenRouter
- Hosting and API: Vercel Functions (TypeScript)
- Database: Neon Postgres
- Images: Cloudflare R2
- Map: Leaflet with CARTO and OpenStreetMap tiles
- City data: Improve Detroit open data

## Project Layout

```
api/            REST API (Vercel Functions)
apps/live/      phone camera page, drive recorder, drive report
apps/map/       map, repair request, labeling and model test pages
services/api/   database schema, city data import, API tests
pipeline/       drive footage processing, model training and evaluation
pitch/          pitch script, demo plan, stats, demo reel tool
shared/         data contracts, JSON schemas, sample data
docs/           team workflow and cross-area requests
```

## Run It Locally

1. Copy `.env.example` to `.env` and fill in the values. Never commit `.env`.
2. Install packages: `npm install`
3. Start the site and API: `npx vercel dev`
4. Open `http://localhost:3000` for the map and `http://localhost:3000/live` for the phone page.

Without `DATABASE_URL`, `/api/potholes` serves the sample data in `shared/fixtures/`. The map and phone page are static files, so `python3 -m http.server 8000` from the repo root also works for a quick look.

More detail per area:

- API, ingest, and tests: `services/api/README.md` (unit tests: `node --test services/api/tests/*.test.ts`)
- Phone page: `apps/live/README.md`
- Drive pipeline and models: `pipeline/README.md`, `pipeline/MODEL_REPORT.md`
- Data shapes shared by every part: `shared/CONTRACTS.md`

## How We Worked

Three people each ran their own AI coding agents in parallel. To keep them from overwriting each other, every area had one owner, areas talked only through the API and `shared/CONTRACTS.md`, tasks lived on a GitHub issue board, and the agents posted progress in a shared chat issue. The rules are in `AGENTS.md` and `docs/WORKFLOW.md`, and the helper scripts are in `scripts/`.
