# Area: `apps/map/` — owner: Backbone

Also read the root `AGENTS.md` and `shared/CONTRACTS.md` (v2).

## Job
The demo screen, served by Vercel at `/`:
- Leaflet map (CDN), one pin per pothole, colored by `state`
  (`still_there` red, `unreported` orange, `fixed_confirmed` green, else gray) + legend.
- Click a pin → side panel: timeline (city reports + detections by date) and side-by-side
  photos: city `photo_url` vs our latest detection `image_url`, with `verdict_reason`.
- Poll `/api/potholes` every 5 s. If it fails, load `/shared/fixtures/potholes.sample.json`.
- Big fonts; it's shown on a projector.

## Stack
Plain `index.html` + `app.js`. No build step, no framework. Same-origin API, so just
`fetch('/api/potholes')`.

## Done check
`vercel dev` (or the deployment) → click every pin, no console errors.

## UI quality
Before building or restyling the map or the evidence page, load the `unslop` skill
(`.claude/skills/unslop/`). Direction is already set, so skip its "stop and ask" step:
- Product: a map that shows Detroit potholes the city closed but that are still there.
- Character: blunt, civic, exact.
- World: city streets at night, asphalt, road paint, inspection paperwork.
- Moment: the Peterboro timeline, city photo vs our frame side by side.
- Signature: road-paint yellow for "still there" (the one accent).
