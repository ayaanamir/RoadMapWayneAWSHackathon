# services/api — roadmap (owner: Backbone)

## M0 · Setup (by Sat 2 PM)
- [ ] Vercel project linked to the repo; Neon `DATABASE_URL` + Blob store added to its env vars
- [ ] `api/health.ts` deployed; `GET /api/health` returns `{ "ok": true }`
- [ ] `GET /api/potholes` returns `shared/fixtures/potholes.sample.json` → post `API_BASE_URL` in chat

## M1 · Real city data (by Sat 6 PM)
- [ ] `ingest_city.py`: pull `request_type='Potholes'` from the FeatureServer (`outSR=4326`), bbox around Newlab/Corktown/Midtown/SW, last ~120 days
- [ ] Upsert into Neon `city_reports` (epoch ms → ISO UTC)
- [ ] Group reports into `Pothole`s (50 m rule), write Neon `potholes`
- [ ] `GET /api/potholes` (+ `?id=`) serves real data from Neon
- [ ] Save city photos for Peterboro (23029294), Newark, Cass to Vercel Blob, set `photo_url`

## M2 · Accept detections (by Sat midnight)
- [ ] `POST /api/detections` (single + batch), idempotent on `detection_id`, attaches to nearest pothole ≤ 50 m
- [ ] `POST /api/upload` → Vercel Blob `put()` → `{ image_url }`
- [ ] Recompute `state` + `last_seen_at` when a detection arrives

## M4 · Polish (by Sun 8 AM)
- [ ] Response time < 1 s for `/api/potholes` (cache if needed)
- [ ] No 500s on the demo click path
