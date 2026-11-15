# Contracts — version 5

> Changelog: v5 — Pothole gets `owner` (who fixes the road, where to report it): `{ key: city|state,
> agency, short, via, route, reason }`. Nothing renamed or removed.
> v4 — Detection gets optional `camera` (`phone` | `dashcam`); dash-cam sightings get a
> vision check worded for small, far-away potholes. Nothing renamed or removed.
> v3 — images on Cloudflare R2 (public bucket) instead of Vercel Blob; new
> pothole state `unreported`; only verified detections create new potholes.
> v2 — stack moved off AWS to Vercel Functions + Neon Postgres + Vercel Blob +
> OpenRouter vision. `Detection.image_key` → `image_url` (Blob returns full URLs).
> API paths now live under `/api/*`. v1 — initial contract.
>
> LOCKED. Change only when your human says "change the contract". Add fields; never
> rename or remove. Bump the version above and add a changelog line.

## Stack

| Piece | Service | Owner |
|---|---|---|
| Pages (map at `/`, phone page at `/live`) | Vercel static hosting (HTTPS) | Backbone / Live |
| API | Vercel Functions in root `api/` (TypeScript, `@neondatabase/serverless`, `@aws-sdk/client-s3`) | Backbone |
| Database | Neon Postgres, project `still-there-builderwars` (schema: `services/api/schema.sql`) | Backbone |
| Images | Cloudflare R2 bucket (public read via `R2_PUBLIC_URL`), written only through `POST /api/upload` | Backbone |
| Vision verify | OpenRouter (OpenAI-compatible chat completions with image input) | Footage |
| Detector | YOLO11n pothole model (Python in pipeline, ONNX in browser) | Footage / Live |

## Conventions
- Coordinates: WGS84 decimal degrees `lat` / `lon`. Times: ISO 8601 UTC. IDs: strings.

## Data shapes (JSON Schemas in `shared/schema/`, examples in `shared/fixtures/`)

### CityReport
`issue_id`, `address`, `lat`, `lon` (city geocode, **rough: 10–50 m off**), `status`
(`Open|Closed|Archived`), `created_at`, `closed_at|null`, `issue_url`, `photo_url|null`.

### Detection
| field | type | notes |
|---|---|---|
| `detection_id` | string | uuid4, made by the producer (live page / pipeline) |
| `source` | `live` \| `drive` | |
| `lat`, `lon` | float | phone GPS / GPX match |
| `captured_at` | ISO string | when the frame was taken |
| `confidence` | float 0–1 | YOLO score |
| `bbox` | [x, y, w, h] | pixels in the uploaded image |
| `image_url` | string | public R2 URL returned by `POST /api/upload` |
| `verdict` | `pothole` \| `shadow` \| `patch` \| `unverified` | vision model result |
| `verdict_reason` | string \| null | one sentence |
| `camera` | `phone` \| `dashcam` \| omitted | v4, optional: model/camera that made it. `drive` sightings count as `dashcam` |

### Pothole (what the map shows)
`pothole_id`, `lat`, `lon`, `address`, `city_reports[]` (by `created_at`), `detections[]`
(by `captured_at`), `state` (`still_there|fixed_confirmed|reported_only|unknown`),
`last_seen_at|null`, `owner` (v5: `{ key: "city"|"state", agency, short, via, route|null, reason }`,
from the street name; state routes go to MDOT, everything else to the City of Detroit). State `unreported` = our verified detections, no city report.

**State rule:** `still_there` = latest city report Closed/Archived and a `pothole`
detection after its `closed_at`. `fixed_confirmed` = closed, and our latest detection after
`closed_at` is `patch` (or a pass with no hit). `reported_only` = reports, no detections.
`unreported` = no city reports and ≥1 `pothole` verdict (or ≥2 detections). `unknown` = anything else.
**Matching rule:** a detection joins the nearest pothole within **50 m**. If none is within
50 m it creates a new pothole **only if** its verdict is `pothole` or a second detection is
within 50 m; otherwise it's stored with `pothole_id = null` (kept, not shown).

## API (Vercel Functions; base URL = the Vercel deployment, `API_BASE_URL`)

| method | path | body → response | used by |
|---|---|---|---|
| GET | `/api/health` | → `{ "ok": true }` | all |
| GET | `/api/potholes` | → `{ "potholes": Pothole[] }` | map |
| GET | `/api/potholes?id=<pothole_id>` | → `Pothole` | map |
| POST | `/api/upload` | raw image body, header `Content-Type: image/jpeg`, query `?name=<detection_id>.jpg` → `{ "image_url": "<R2_PUBLIC_URL>/frames/<name>" }` | live, pipeline |
| POST | `/api/detections` | `Detection` or `{ "detections": Detection[] }` → `{ "ok": true, "pothole_ids": ["…"] }` | live, pipeline |

- JSON in/out, CORS `*`. Images must be < 4 MB (Function body limit is 4.5 MB): send
  JPEG at quality ~80, max 1280 px wide.
- `POST /api/detections` upserts on `detection_id` (retries are safe), assigns
  `pothole_id`, recomputes the pothole's `state` / `last_seen_at`.
- Until the API is live, read `shared/fixtures/*.json`.

## Database (Neon) — Backbone owns; everyone else goes through the API
Tables: `potholes`, `city_reports` (+`pothole_id`), `detections` (+`pothole_id`). Exact DDL:
`services/api/schema.sql`. Connection string: `DATABASE_URL` (Vercel env + local `.env`,
never committed).

## Vision verify (Footage owns prompts in `pipeline/prompts/`)
OpenRouter `POST https://openrouter.ai/api/v1/chat/completions`, model from
`OPENROUTER_MODEL`, key `OPENROUTER_API_KEY`. Input: frame crop (+ optional city photo).
Output must parse to `{ "verdict": "...", "reason": "..." }` → `Detection.verdict`,
`verdict_reason`.
