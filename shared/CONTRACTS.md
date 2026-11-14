# Contracts — version 1

> Changelog: v1 — initial contract.
>
> LOCKED. Change only when your human says "change the contract". Add fields; never
> rename or remove. Bump the version above and add a changelog line.

Everything that crosses between areas is defined here. If it's not here, it's private
to one area.

## Conventions

- Coordinates: WGS84 decimal degrees, `lat` / `lon` (floats).
- Times: ISO 8601 UTC strings, e.g. `"2026-11-14T19:05:12Z"`.
- IDs: strings. City report IDs are the SeeClickFix `issue_id` as a string.
- Units: meters, seconds.

## Data shapes

JSON Schemas live in `shared/schema/`. Examples live in `shared/fixtures/`.

### CityReport — one Improve Detroit pothole report
| field | type | notes |
|---|---|---|
| `issue_id` | string | SeeClickFix id |
| `address` | string | as given by the city (often an intersection) |
| `lat`, `lon` | float | city geocode — **rough, can be 10–50 m off** |
| `status` | string | `Open` \| `Closed` \| `Archived` |
| `created_at` | string | ISO time |
| `closed_at` | string \| null | ISO time |
| `issue_url` | string | `https://seeclickfix.com/issues/<id>` |
| `photo_url` | string \| null | city/reporter photo if we found one |

### Detection — one sighting of a possible pothole by us
| field | type | notes |
|---|---|---|
| `detection_id` | string | uuid4, created by whoever makes the detection |
| `source` | string | `live` (phone page) \| `drive` (pipeline) |
| `lat`, `lon` | float | from phone GPS / GPX match |
| `captured_at` | string | ISO time the frame was taken |
| `confidence` | float | YOLO score 0–1 |
| `bbox` | [x, y, w, h] | pixels in the stored image |
| `image_key` | string | S3 key of the frame (see S3 layout) |
| `verdict` | string | `pothole` \| `shadow` \| `patch` \| `unverified` (Bedrock result) |
| `verdict_reason` | string \| null | one sentence from Bedrock |

### Pothole — what the map shows (built by Backbone from the two above)
| field | type | notes |
|---|---|---|
| `pothole_id` | string | stable id |
| `lat`, `lon` | float | best location |
| `address` | string | |
| `city_reports` | CityReport[] | sorted by `created_at` |
| `detections` | Detection[] | sorted by `captured_at` |
| `state` | string | `still_there` \| `fixed_confirmed` \| `reported_only` \| `unknown` |
| `last_seen_at` | string \| null | latest `pothole` verdict time |

**State rule (Backbone owns the logic, this is the meaning):**
- `still_there` — newest city report is Closed/Archived **and** a `pothole` detection exists after `closed_at`.
- `fixed_confirmed` — closed, and our latest pass after `closed_at` found no pothole / verdict `patch`.
- `reported_only` — city reports but no detections yet.
- `unknown` — anything else.

**Matching rule:** a detection belongs to a pothole if it's within **50 m** of it.
(City geocodes are rough — don't tighten this without telling everyone.)

## API (Backbone serves it; base URL in `.env` as `API_BASE_URL`)

| method | path | body / returns | used by |
|---|---|---|---|
| `GET` | `/potholes` | `{ "potholes": Pothole[] }` (detections may be omitted for speed) | map |
| `GET` | `/potholes/{pothole_id}` | `Pothole` with everything | map |
| `POST` | `/detections` | body: `Detection` (or `{ "detections": Detection[] }`) → `{ "ok": true, "pothole_id": "…"\|null }` | live, pipeline |
| `POST` | `/uploads/presign` | body: `{ "key": "<s3 key>", "content_type": "image/jpeg" }` → `{ "url": "…" }` | live |
| `GET` | `/health` | `{ "ok": true }` | everyone |

- JSON in, JSON out. CORS open (`*`) — it's a hackathon.
- `POST /detections` must be idempotent on `detection_id` (retries are safe).
- Until the API is live, read `shared/fixtures/*.json` instead.

## S3 layout (bucket in `.env` as `S3_BUCKET`)

```
raw/drive/<YYYY-MM-DD>/<clip>.mov       original drive videos     (Footage writes)
raw/drive/<YYYY-MM-DD>/<clip>.gpx       GPS logs                  (Footage writes)
frames/<detection_id>.jpg               frame for each detection  (Footage, Live write)
city/photos/<issue_id>.jpg              saved city photos         (Backbone writes)
```

## DynamoDB (Backbone owns; others never write directly — use the API)

| table (env var) | partition key | holds |
|---|---|---|
| `DDB_CITY_REPORTS` | `issue_id` | CityReport |
| `DDB_DETECTIONS` | `detection_id` | Detection |
| `DDB_POTHOLES` | `pothole_id` | Pothole without nested arrays (ids only) |

## Bedrock (Footage owns the prompts; others may call via the pipeline's verify step only)

- Model id in `.env` as `BEDROCK_MODEL_ID`, region `AWS_REGION`.
- Input: frame crop (+ optional city photo for "same spot?" check).
- Output written into `Detection.verdict` / `verdict_reason`.
