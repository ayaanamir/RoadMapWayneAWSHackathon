# services/api — roadmap (owner: Backbone)

## M0 · Setup (by Sat 2 PM)
- [x] Vercel project linked to the repo; Neon `DATABASE_URL` + R2 bucket vars added to its env vars
- [x] `api/health.ts` deployed; `GET /api/health` returns `{ "ok": true }`
- [x] `GET /api/potholes` returns `shared/fixtures/potholes.sample.json` → post `API_BASE_URL` in chat

## M1 · Real city data (by Sat 6 PM)
- [x] `ingest_city.py`: pull `request_type='Potholes'` from the FeatureServer (`outSR=4326`), bbox around Newlab/Corktown/Midtown/SW, last ~120 days
- [x] Upsert into Neon `city_reports` (epoch ms → ISO UTC)
- [x] Group reports into `Pothole`s (50 m rule), write Neon `potholes`
- [x] `GET /api/potholes` (+ `?id=`) serves real data from Neon
- [ ] Save city photos for Peterboro (23029294), Newark, Cass to R2, set `photo_url`

## M2 · Accept detections (by Sat midnight)
- [x] `POST /api/detections` (single + batch), idempotent on `detection_id`, attaches to nearest pothole ≤ 50 m (new pothole only if verified, per contract v3)
- [x] `POST /api/upload` → R2 `PutObject` → `{ image_url }`
- [x] Recompute `state` + `last_seen_at` when a detection arrives

## M4 · Polish (by Sun 8 AM)
- [x] Response time < 1 s for `/api/potholes` (cache if needed)
- [x] No 500s on the demo click path
