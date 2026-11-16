# pitch

Pitch script, demo click path, submission text. Progress: `ROADMAP.md`.
What is being worked on right now: `WORKLOG.md`.

| File | What it is |
|---|---|
| `SCRIPT.md` | The 3-minute pitch, word for word. |
| `DEMO.md` | The demo: links, setup checklist, click path, who does what, what to do if it breaks. |
| `SUBMISSION.md` | Shipyard submission text, ready to paste, plus the screenshot list and a final checklist. |
| `STATS.md` | The numbers the pitch uses, and where they came from. |
| `media/demo.gif` | The README GIF: the live page boxing a real pothole on the Corktown drive, then the vision check confirming it. |
| `tools/make_reel.py` | Runs the dash-cam model on a folder of road clips and stitches them into one looping MP4 for the demo, plus short GIFs. New clips added to the folder go to the end of the reel. Needs `pip install onnxruntime opencv-python-headless numpy` and `ffmpeg`. |
| `stats/repeat_reports.py` | Pulls the "closed, then reported again" numbers from public city data. No install needed: `python3 pitch/stats/repeat_reports.py --days 365` |
