# Area: `apps/map/` — owner: Backbone

Also read the root `AGENTS.md` and `shared/CONTRACTS.md` (v2).

## Job
The demo screen, served by Vercel at `/`:
- Leaflet map (CDN), one pin per pothole, colored by `state`
  (`still_there` red, `fixed_confirmed` green, else gray) + legend.
- Click a pin → side panel: timeline (city reports + detections by date) and side-by-side
  photos: city `photo_url` vs our latest detection `image_url`, with `verdict_reason`.
- Poll `/api/potholes` every 5 s. If it fails, load `/shared/fixtures/potholes.sample.json`.
- Big fonts; it's shown on a projector.

## Stack
Plain `index.html` + `app.js`. No build step, no framework. Same-origin API, so just
`fetch('/api/potholes')`.

## Done check
`vercel dev` (or the deployment) → click every pin, no console errors.
