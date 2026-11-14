# services/api — roadmap (owner: Backbone)

## M0 · Setup (by Sat 2 PM)
- [ ] DynamoDB tables created (names from `.env.example`), S3 bucket created
- [ ] Lambda + function URL (or API Gateway) deployed; `GET /health` returns `{ "ok": true }`
- [ ] `GET /potholes` returns `shared/fixtures/potholes.sample.json` → post `API_BASE_URL` in chat

## M1 · Real city data (by Sat 6 PM)
- [ ] `ingest_city.py`: pull `request_type='Potholes'` from the FeatureServer (`outSR=4326`), bbox around Newlab/Corktown/Midtown/SW, last ~120 days
- [ ] Store as `CityReport` in `DDB_CITY_REPORTS` (epoch ms → ISO UTC)
- [ ] Group reports into `Pothole`s (50 m rule), write `DDB_POTHOLES`
- [ ] `GET /potholes` + `GET /potholes/{id}` serve real data
- [ ] Save city photos for Peterboro (23029294), Newark, Cass to S3 `city/photos/`

## M2 · Accept detections (by Sat midnight)
- [ ] `POST /detections` (single + batch), idempotent on `detection_id`, attaches to nearest pothole ≤ 50 m
- [ ] `POST /uploads/presign` for frame uploads
- [ ] Recompute `state` + `last_seen_at` when a detection arrives

## M4 · Polish (by Sun 8 AM)
- [ ] Response time < 1 s for `/potholes` (cache if needed)
- [ ] No 500s on the demo click path
