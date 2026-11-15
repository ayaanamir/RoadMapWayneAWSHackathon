# Cross-area requests

Append only. One line each: `- [From → To] what you need`. Mark done with `✅` when shipped.

- [Backbone → Footage] Drive footage comes from our dash cam, not a phone, so its GPS is embedded in each video. Per clip: `exiftool -ee -p gpx.fmt CLIP.MP4 > CLIP.gpx` (gpx.fmt ships with exiftool), then the existing GPX match works unchanged. Check one clip first with `exiftool -ee "-gps*" CLIP.MP4`; if it prints no GPS lines the camera isn't recording GPS. Dash cams split into 1–3 min files and often keep local time, so match on the GPX's GPS timestamps, not CreateDate.
- [Footage → Backbone] Add an `owner` field to each pothole in `GET /api/potholes`: `{ key: "city"|"state", agency, short, via, route, reason }`, worked out server-side with the same rules as `apps/map/agency.js` (later: Act 51 road-ownership lookup, plus Wayne County / other cities). Then `pipeline/drive_report.py` and the map show the same "report it to" answer instead of keeping two copies. New field only, nothing renamed (contract bump). ✅
