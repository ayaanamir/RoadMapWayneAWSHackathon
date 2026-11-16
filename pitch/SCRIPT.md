# Pitch script v1 (#47)

> **The hackathon ended on Sunday, November 15, 2026.** This is the Saturday draft, kept as a record. The `[fill]` spots waited on a Peterboro drive that was dropped; the final demo used the Corktown drive instead (see the root `README.md`).

Target: under 3 minutes. Now about 445 spoken words, which is right at 3 minutes at a
normal pace. If it runs long, cut section 5 first. Numbers come from `STATS.md`.
Lines in _italics_ are notes for the speaker, not words to say.
`[fill]` = waiting on the drive or the deploy. Do not say a number we have not checked.

---

## 1. The problem (about 40 s)

> The city closes pothole reports in days. We check whether they actually got fixed.
>
> Here is 73 Peterboro Street, a few blocks from where we are sitting.
> On September 13th someone reported a pothole. The next day, the city marked it closed.
> A month later, someone reported a pothole at the same address. Closed again, five days later.
>
> And that is not one unlucky street. In the last year, near Newlab, one in four closed
> pothole reports came back. 91 spots were marked fixed, and then someone reported a
> pothole there again.
>
> "Closed" means someone closed a ticket. It does not mean anyone checked the road.

## 2. The demo (about 60 s)

_Map on the projector. Peterboro pin is yellow. Click path: `DEMO.md`._

> This is Still There. Every pin is a pothole the city has a record for.
> Yellow means the city says it is fixed, and we saw it is still there.
>
> _Click Peterboro._ Here is its whole history: reported, closed, reported again,
> closed again. And here is today: [fill: our frame from the drive], next to the photo
> from the original report. Our model looked at it and said: [fill: verdict reason].
>
> We drove [fill: number] of these sites this afternoon. [fill: X] were still there.
>
> _Phone in hand, point it at a pothole photo on the laptop._
> And anyone can add to it. This is a phone in a web page, no app to install.
> It spots the pothole and grabs the location. Before it goes on the map, the vision model
> checks the photo, so a shadow never makes a pin. _(pin appears)_ There it is on the map.

## 3. How it works (about 40 s)

> Three steps.
>
> One: we pull every pothole report from Improve Detroit, the city's own public data,
> and group reports that are the same spot.
>
> Two: we look at the road. A small detection model runs right on the phone, so it keeps
> up with a moving car and works on a weak signal.
>
> Three: a bigger vision model double checks every hit, from the car and from the phone.
> The small model is fast, but it
> mixes up potholes with shadows and patched asphalt. The big one makes that call and
> writes one sentence on why, so a person can trust the result.

## 4. Why it is different (about 15 s)

> Today, apps like the city's let you report a pothole. Nothing checks whether the fix
> held. We are the follow-up: we compare what the city says with what the road shows.

## 5. Under the hood (about 20 s)

> The detector is YOLO, running in the browser, so there is nothing to install, and only the
> frames with a pothole in them get sent. The judgment calls go to a vision model through OpenRouter.
> The site and API run on Vercel with a Postgres database on Neon, so what you are
> seeing is live, not a recording.

## 6. Close (about 15 s)

> Every closed ticket in Detroit could get a second look, from anyone with a phone,
> or from a city vehicle that is already driving the route.
>
> The city closes pothole reports in days. We are the ones who check.

---

_Rules from `pitch/AGENTS.md`: plain words, no legal terms, say how we are different in
one sentence (section 4), explain the stack and why (sections 3 and 5)._
