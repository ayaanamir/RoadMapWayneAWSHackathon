# Area: `apps/map/` — owner: Backbone

Also read the root `AGENTS.md`. You write only here and in `services/api/`.

## Job
The demo screen judges look at. One page:
- Leaflet map of Detroit, one pin per `Pothole`, colored by `state`
  (`still_there` red, `fixed_confirmed` green, `reported_only` gray, `unknown` gray).
- Click a pin → side panel with the **timeline** (city reports + detections in date
  order) and **side-by-side photos**: city photo (if any) vs our latest frame.
- Big, readable, works on a laptop projected to judges.

## Stack
Static `index.html` + one JS file + Leaflet from a CDN. No build step, no framework.
Data from `API_BASE_URL/potholes`; if the API is down or unset, fall back to
`../../shared/fixtures/potholes.sample.json` so the demo never shows a blank screen.

## Check before you finish
Open `index.html` locally (`python -m http.server` from the repo root) and click every pin.
