# Shipyard submission draft (#52)

> **The hackathon ended on Sunday, November 15, 2026.** Kept as a record. The two `[fill]` spots are now filled with what actually happened.

Copy each part into the matching field on the Shipyard form. Field names may differ;
the parts are the usual ones. `[fill]` = waiting on the drive (#35) or the final numbers.
Before submitting: rerun `python3 pitch/stats/repeat_reports.py --days 365` and update
the numbers if they changed.

Deadline: submit by **Sun 11:30 AM** (hard deadline 12:00).

---

## Project name

Still There?

## Tagline (one line)

The city closes pothole reports in days. We check whether they actually got fixed.

## Short description (about 50 words)

Detroit marks most pothole reports closed within two days, but nobody checks the road
afterwards. Still There? pulls the city's own reports, looks at the road with a phone
camera and a dash cam, and shows every pothole's history on one map: reported, closed,
and then either still there or fixed.

## Full description

### The problem

When you report a pothole to Detroit, the ticket usually closes within about two days.
"Closed" means someone closed a ticket. It does not mean anyone checked the road.

We pulled a year of the city's public pothole reports around Newlab, Corktown, Midtown
and Southwest Detroit. Of 588 closed reports, 155 (26%) had someone report a pothole at
the same spot again after it was closed. That is 91 different spots.

One of them is 73 Peterboro Street, a few blocks from Newlab. Reported on September 13,
closed the next day. Reported again on October 15, closed five days later.
We did not get to drive past it. Instead, a 7 minute drive through Corktown on November 15 sent 105 sightings: the vision check confirmed 1 new pothole the city had no report for, labeled 22 as old repairs, and rejected 82.

### What it does

- **One map of every pothole the city has on file** in our area, built from Improve
  Detroit's public data. Reports at the same spot are grouped into one pin.
- **Each pin has a timeline:** every report, every "closed", and every time we looked.
- **We look at the road.** Dash cam footage from a drive is matched to GPS, a pothole
  detector finds candidates, and a vision model decides: pothole, patch, or just a shadow,
  with one sentence on why.
- **Pins change color** when we see a pothole after the city closed it ("still there"),
  or confirm it is patched ("fixed").
- **Anyone can add sightings from a phone.** A web page, nothing to install: it runs the
  detector on the phone, and sends the frame and GPS when it sees a pothole.

### How we built it

- **Detector:** a small YOLO11 model trained on pothole images. It runs in the browser
  with ONNX Runtime Web (WebGPU, with WASM as a backup), so the phone keeps up in real
  time and only frames with a pothole are sent. On an iPhone 16 in Safari it checks
  about 7 frames per second.
- **Second opinion:** a vision model through OpenRouter looks at each drive hit and
  decides pothole, patch, or shadow. The small model is fast but mixes these up.
- **Data:** Improve Detroit reports (City of Detroit open data), grouped into potholes
  within 50 m, since city locations can be 10 to 50 m off.
- **App:** map and API on Vercel, data in Neon Postgres, images in Cloudflare R2.

### Challenges

- **Phones are picky.** WebGPU hung on iPhone Safari on the first run, and a stuck run
  blocked the backup engine too. The page now detects this, remembers it for that phone,
  and reloads into the backup engine.
- **City locations are rough.** Reports for the same pothole can be 50 m apart, so we
  match by distance, not address.
- **Not every dark patch is a pothole.** Shadows and patched asphalt fool a fast
  detector, which is why every drive hit gets a second look from a bigger model.

### What's next

- Put it on vehicles that already drive every street (buses, garbage trucks) so every
  closed ticket gets checked automatically.
- A one-tap "report again" with our photo as evidence, sent to Improve Detroit.

## Built with

YOLO11, ONNX Runtime Web, WebGPU, OpenRouter, Vercel, Neon Postgres, Cloudflare R2,
Leaflet, Improve Detroit open data, JavaScript, TypeScript, Python

## Links

| Field | Link |
|---|---|
| Live demo | https://wayneawshackathon.vercel.app/ |
| Phone page | https://wayneawshackathon.vercel.app/live |
| Code | https://github.com/ayaanamir/RoadMapWayneAWSHackathon |
| Video | https://still-there-drives.vercel.app/ (drive video and drive report) |

## Team

- **Ayaan:** API, database, map
- **Muq:** drive footage, detector training, vision check
- **Ado:** phone page, pitch

## Screenshots to attach

Take these the morning of submission, after the drive data is in.

1. Map of the whole area, with yellow pins visible: https://wayneawshackathon.vercel.app/
2. Peterboro panel open, timeline and both photos: https://wayneawshackathon.vercel.app/?id=ph_peterboro_73
3. Phone page with a box on a pothole and the stats box showing "Sent".
4. Optional: a "shadow, not a pothole" verdict, to show the second opinion at work.

## Before you hit submit

- [ ] Every `[fill]` replaced, or the sentence removed.
- [ ] Numbers match `STATS.md` after a fresh rerun.
- [ ] Links open in a private browser window (not just on our laptops).
- [ ] Screenshots attached.
- [ ] Repo is public and the README explains how to run it.
