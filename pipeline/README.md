# pipeline

Drive footage + GPS → verified `Detection`s → API.
Rules: `AGENTS.md` here + at repo root. Progress: `ROADMAP.md`.

## Run
_Owner fills in:_
- Install: `pip install -r pipeline/requirements.txt` (+ system `ffmpeg`, `exiftool`)
- Process a clip: `…`

## Training notebooks (Colab)
- `train/train_pothole.ipynb` — v1, YOLO11n on Roboflow voxrl + ptvvw (live default).
- `train/train_dashcam.ipynb` — v2, dash-cam fine-tune (Figshare + ptvvw, 960).
- `train/train_dashcam_detroit.ipynb` — v3, + human-reviewed Detroit frames, 640.
- `train/train_v4.ipynb` — v4, Detroit v4 set (`autolabel/build_v4_data.py`) + RDD2022 US, v1 weight blends, Detroit exam + crack check.
- Results and metrics: `MODEL_REPORT.md`, `train/results/`.

## Data credits
- RDD2022 (Arya et al.), CC BY-SA 4.0, via the Hugging Face mirror `dronefreak/RDD2022` (United States subset; pothole = D40).
- Figshare "Potholes dataset with YOLO annotations" (article 21214400).
- Roboflow Universe: `brad-dwyer/pothole-voxrl`, `work-5qhak/potholes-ptvvw` (see each page for license).
- Detroit dash-cam frames from the CROWD dataset (YouTube; frames not redistributed), labels reviewed by the team.
