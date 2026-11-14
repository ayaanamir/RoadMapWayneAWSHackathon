# Demo plan (#49)

Goes with `SCRIPT.md`. The demo is the middle minute of the pitch.
Names in **bold** are who does it. Swap them if the team decides otherwise.

## Links

| What | Link |
|---|---|
| Map, opened on Peterboro | https://wayneawshackathon.vercel.app/?id=ph_peterboro_73 |
| Map, whole area | https://wayneawshackathon.vercel.app/ |
| Phone page | https://wayneawshackathon.vercel.app/live |
| Backup video | _add link after #50_ |

## Setup (10 minutes before)

- [ ] Laptop on the projector. Map open on Peterboro (first link). Browser full screen.
- [ ] Zoom the browser so the side panel is easy to read from the back of the room.
- [ ] Peterboro pin is **yellow** ("Seen after the city closed it"). If it is gray, the
      drive footage is not in yet: use the backup video for that part.
- [ ] Phone: `/live` open, camera started, boxes showing. Location allowed.
- [ ] Phone page shows GPS (for example "±10 m"), not "waiting".
- [ ] Second screen or tablet with a pothole photo, full screen, for the phone to look at.
- [ ] Phone hotspot turned on and tested, in case the venue Wi-Fi dies.
- [ ] Backup video downloaded on the laptop (not just a link).
- [ ] Phone on Do Not Disturb. Laptop notifications off.

## Click path

| Time | Who | Do | Say (short version, full words in `SCRIPT.md`) |
|---|---|---|---|
| 0:00 | **Ado** | Nothing, map is already up | The problem: Peterboro, reported, closed, reported again. 1 in 4 near here come back. |
| 0:40 | **Ayaan** | Point at the yellow pins | "Yellow means the city closed it and we saw it still there." |
| 0:50 | **Ayaan** | Peterboro panel is already open. Scroll the timeline slowly | "Reported, closed next day. Reported again a month later. Closed again." |
| 1:05 | **Ayaan** | Point at the two photos: city photo and our frame | "Here is what we saw today, and what our model said about it." |
| 1:20 | **Ado** | Hold the phone to the pothole photo for 3 seconds | "Anyone can add to it. A web page on a phone, nothing to install." |
| 1:30 | **Ayaan** | Watch the map. A new pin shows within about 5 seconds | "There it is on the map." |
| 1:40 | **Ado** | Back to the script | How it works, why it is different, the stack. |

Hold the phone still for at least 3 seconds. The phone sends at most one sighting per
second, and a new spot only becomes a pin after the 2nd sighting within 50 m.

## What the live part can and cannot show

- Phone sightings go in as "not verified". They add to the timeline and can make a new
  pin, but they do **not** turn a pin yellow. Only the drive footage (checked by the
  vision model) does that. Do not promise a color change from the phone.
- The phone only sends **potholes**. This needs the pothole model (#39). With the stock
  model it sends nothing, so cut the live part if #39 is not in.
- **Check in rehearsal:** where the new pin shows up and what color it is. We are at
  Newlab, so the pin lands at Newlab, not on Peterboro.
- Rehearsals leave real test pins on the map. Ask Ayaan to clear them before the
  real demo.

## If something breaks

| Problem | Do this |
|---|---|
| Venue Wi-Fi dies | Laptop and phone onto the phone hotspot. Reload the map. Keep talking while it loads. |
| Map loads but no pins | The API is down. The map falls back to saved sample data on its own, so Peterboro still shows. Carry on. |
| Phone page stuck loading | Skip the phone. Use the laptop webcam: open `/live` in a new tab, point the laptop camera at the pothole photo. |
| No new pin after 10 seconds | Say "it takes a moment to sync" once, then move on. Do not wait in silence. |
| Nothing works | Play the backup video from the laptop (not from the link). |

## Rehearsal checklist (#51)

- [ ] Full run with a timer, under 3 minutes. Twice.
- [ ] Run once on the phone hotspot only.
- [ ] Run once with the phone part skipped, to practice the fallback line.
- [ ] Check what the new pin from the phone looks like, then have it cleared.
