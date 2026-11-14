# Area: `services/api/` — owner: Backbone

Also read the root `AGENTS.md`. You write only here and in `apps/map/`.

## Job
1. **City ingest:** pull pothole reports (`request_type = 'Potholes'`) from the Improve
   Detroit FeatureServer (`CITY_FEATURESERVER` in `.env`), focus on the area around
   Newlab/Corktown/Midtown, store as `CityReport` in DynamoDB.
2. **History:** group city reports + detections into `Pothole`s (50 m rule) and compute
   `state` exactly as defined in `shared/CONTRACTS.md`.
3. **API:** serve the endpoints in `shared/CONTRACTS.md` (Lambda + API Gateway or a
   Lambda function URL). CORS `*`.

## Stack
Python 3.12, `boto3`, no web framework needed (plain Lambda handler). Deps in
`services/api/requirements.txt`.

## Useful query (ArcGIS)
`<CITY_FEATURESERVER>/query?where=request_type='Potholes'&outFields=*&outSR=4326&f=json`
— add `outSR=4326` so geometry comes back as lat/lon. Fields: `issue_id, address,
status, created_at, closed_at, issue_url, latitude, longitude` (dates are epoch ms).

## Rules for this area
- `POST /detections` is idempotent on `detection_id`.
- Never change the response shapes — they're the contract the map and the other two
  areas rely on. Need a change? `docs/REQUESTS.md` + ask the humans.
- Ship `GET /potholes` early, even if it just returns `shared/fixtures/potholes.sample.json`,
  so the map and others can integrate right away.

## Check before you finish
`python -m pytest services/api -q` (add tests as you go) and hit `/health`.
