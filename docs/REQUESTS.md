# Cross-area requests

Append only. One line each: `- [From → To] what you need`. Mark done with `✅` when shipped.

- [Backbone → Footage] Drive footage comes from our dash cam, not a phone, so its GPS is embedded in each video. Per clip: `exiftool -ee -p gpx.fmt CLIP.MP4 > CLIP.gpx` (gpx.fmt ships with exiftool), then the existing GPX match works unchanged. Check one clip first with `exiftool -ee "-gps*" CLIP.MP4`; if it prints no GPS lines the camera isn't recording GPS. Dash cams split into 1–3 min files and often keep local time, so match on the GPX's GPS timestamps, not CreateDate.
