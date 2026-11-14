# Pitch numbers (#48)

Pulled 2026-11-14 from the public Improve Detroit data with
`python3 pitch/stats/repeat_reports.py`. Rerun before the pitch so the numbers are fresh.

"Our area" = box around Newlab, Corktown, Midtown and Southwest Detroit.
"Reported again" = a pothole report was marked Closed, and after that day someone filed a
new pothole report within 50 m.

## The numbers

| | Our area, last 12 months | Our area, last 120 days | All Detroit, last 120 days |
|---|---|---|---|
| Pothole reports | 589 | 147 | 954 |
| Marked Closed | 588 | 146 | 944 |
| Median days to close | 2.3 | 1.9 | 1.9 |
| Closed, then reported again | **155 (26%)** | 14 (10%) | 75 (8%) |
| Different spots | **91** | 10 | 59 |
| Median days from "closed" to new report | 45 | 12 | 14 |

**Line for the pitch:** "In the last year, near Newlab, 1 in 4 closed pothole reports
came back. 91 spots were marked fixed, and then someone reported a pothole there again."

Use the 12-month numbers. The 120-day window is too short: a report closed last week has
not had time to be reported again yet.

## Peterboro (the story)

73 Peterboro St, all real city records (see `shared/fixtures/potholes.sample.json`):

| Report | Filed | Closed | Days open |
|---|---|---|---|
| 22762324 | Sep 13 | Sep 14 | 1 |
| 22762325 | Sep 13 (same day, duplicate) | Sep 14 | 1 |
| 23029294 | Oct 15, a month after it was "fixed" | Oct 20 | 5 |

What we saw on Nov 14: _fill in after the drive (#35)_.

## Honest limits (say these if a judge asks)

- A new report within 50 m might be a different pothole on the same block. That is why
  we go look: the number tells us where to drive, the camera tells us what is there.
- City locations can be 10 to 50 m off, so 50 m is the tightest fair match.
- All of these were "Closed". None were "Archived" (the status the city also uses for
  duplicates), so duplicates are not inflating the count.

Most re-reported spots near us, last 12 months: 3930 Cass Ave (11 reports),
4119 Cass Ave (9), Cass Ave & Selden St (7), 4784 Hammond St (6), 1240 Springwells St (6).
