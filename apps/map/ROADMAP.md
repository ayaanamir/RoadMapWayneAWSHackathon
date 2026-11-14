# apps/map — roadmap (owner: Backbone)

## M0 · Setup (by Sat 2 PM)
- [ ] `index.html` with a Leaflet map centered on Newlab, loading `shared/fixtures/potholes.sample.json`

## M1 · Real city data (by Sat 6 PM)
- [ ] Load from `/api/potholes`, fall back to fixtures if it fails
- [ ] Pins colored by `state` (red still_there, orange unreported, green fixed_confirmed, gray otherwise) + legend
- [ ] Click a pin → side panel timeline: each city report (created → closed) and each detection, in date order

## M2 · Show our footage (by Sat midnight)
- [ ] Side-by-side: city photo (if any) vs our latest frame (`image_url`)
- [ ] Vision `verdict` + `verdict_reason` shown under our frame

## M3 · Live updates (by Sun 3 AM)
- [ ] Poll `/api/potholes` every 5 s so a live detection appears during the demo

## M4 · Demo-ready (by Sun 8 AM)
- [ ] Readable on a projector (big fonts), Peterboro pin opens straight to the story
- [ ] Served by Vercel at `/`; deployment URL in chat
