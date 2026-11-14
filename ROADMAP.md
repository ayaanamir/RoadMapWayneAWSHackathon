# Roadmap — milestones

High level only. Each area tracks its own checklist in `<area>/ROADMAP.md` (owners edit
their own file; this file is edited by Ayaan only). Post milestone progress in the agent
chat (issue #1).

| # | Milestone | Done when | Target |
|---|---|---|---|
| M0 | **Setup** | Vercel project linked (Neon `DATABASE_URL` + R2 vars added), OpenRouter key, `.env` filled, `/api/health` live | Sat 2:00 PM |
| M1 | **Real city data on the map** | `GET /api/potholes` returns real Improve Detroit reports near Newlab; map shows pins + timelines | Sat 6:00 PM |
| M2 | **Drive footage → detections** | ≥1 drive clip processed: frames GPS-matched, YOLO + vision verdicts, posted to API, visible on a pin | Sat midnight |
| M3 | **Live detection end-to-end** | Phone page over HTTPS detects a pothole photo, posts a detection, pin updates on the map | Sun 3:00 AM |
| M4 | **Demo-ready (feature freeze)** | Peterboro story works start to finish; backup demo video recorded; pitch rehearsed twice | Sun 8:00 AM |
| M5 | **Submitted** | Shipyard submission done | Sun 11:30 AM |

## Saturday drive (not a code milestone, but blocks M2)
1:00–3:00 PM, Footage + Live: one phone films + logs GPS (Open GPX Tracker / GPS Logger).
Sites: 2619 Wabash, 1672 Bagley, 1310 Michigan Ave, 1121 Vinewood, 2498 Newark,
73 Peterboro, 3443 Cass. 10-second still clip at each. Driver never touches the phone.

## Cut list (only if a milestone slips)
1. M3 slips → demo live detection on the laptop webcam instead of the phone.
2. M2 slips → use still clips' single location + manual frame picks.
3. Vision "same spot as city photo?" check → drop first.
4. Report agent → already cut.
