# Pothole model — status report (Muq, Sat 14 Nov, ~4:30 PM ET)

**TL;DR:** We have two trained YOLO11n models. On their own validation sets they look fine
(0.85 and 0.70 mAP50), but on **real dash-cam / Detroit footage they're bad**: they **box shadows,
manhole covers and house siding**, and **miss obvious potholes**, especially ones more than ~10 m
ahead. The data and the evaluation are both weak. Need a redrafted plan.

Everything below is reproducible from the notebooks in `pipeline/train/` (on branch
`claude/tender-brahmagupta-x3znga`; `train_pothole.ipynb` is also on `main` via #65).

---

## 1. Models trained so far

### v1 — "phone" model (live default today)
- **Notebook:** `pipeline/train/train_pothole.ipynb` · free Colab T4 · ~15 min
- **Arch:** YOLO11n (COCO-pretrained `yolo11n.pt`), 1 class `pothole`, imgsz 640, 60 epochs, batch auto
- **Data:** Roboflow `brad-dwyer/pothole-voxrl` v1 (665 imgs, mostly close-up/handheld) +
  `work-5qhak/potholes-ptvvw` v2 `dashcam_832` (730 imgs, dash-cam angle), merged, all labels → class 0
- **Validation (merged val split, ~same distribution as train):**

  | epoch | P | R | mAP50 | mAP50-95 |
  |---|---|---|---|---|
  | best (58) | 0.842 | 0.747 | **0.854** | 0.513 |
  | final (60) | 0.854 | 0.748 | 0.847 | 0.512 |

- **Deployed:** exported ONNX 640 → R2 `models/pothole.onnx` → `/live` default (Ado, #39 / PR #85)

### v2 — "dashcam" model (candidate for `/live?m=dashcam`, NOT shipped)
- **Notebook:** `pipeline/train/train_dashcam.ipynb` · Colab A100 · ~13 min training
- **Arch:** fine-tuned from **v1 best.pt**, 1 class, **imgsz 960**, 30 epochs, patience 10, close_mosaic 5
- **Data (dash-cam only):** Figshare "Potholes dataset with YOLO annotations" (article 21214400,
  2000+ Full HD dash-cam frames) split **contiguously by file name** 80/10/10 (keeps near-identical
  neighbouring frames out of test) + Roboflow `potholes-ptvvw` v2 dashcam. Empty-label frames kept as backgrounds.
- **Validation (dash-cam val split — harder, far/small potholes):**

  | epoch | P | R | mAP50 | mAP50-95 |
  |---|---|---|---|---|
  | 1 | 0.601 | 0.424 | 0.475 | 0.206 |
  | 9 | 0.636 | 0.553 | 0.603 | 0.273 |
  | 13 | 0.653 | 0.399 | 0.483 | 0.208 |
  | 20 | 0.721 | 0.603 | 0.679 | 0.316 |
  | **24 (best)** | 0.710 | 0.629 | **0.699** | 0.336 |
  | 30 (final) | 0.751 | 0.612 | 0.684 | 0.337 |

  Noisy mid-run (lr still high), plateaued ~0.68–0.70 in the last 10 epochs.
  **Best F1 = 0.67 at confidence 0.324** (`results/v2_dashcam/BoxF1_curve.png`) — i.e. even at the
  best threshold it misses ~1 in 3 potholes or boxes non-potholes ~1 in 3 times on dash-cam frames.
- **Old-vs-new on the same held-out dash-cam frames:** printed in Colab step 6 but **not captured**
  (runtime disconnected). Needs re-running.
- **Exports:** `handoff_dashcam/` → `pothole.onnx` (640, for phone), `pothole_960.onnx`, `best.pt`

## 2. Tests on data the models never saw

| Test | Model | Result | Notes |
|---|---|---|---|
| Roboflow `potholes-gfbhh/road-damage-ormqn` v2, **test split = 6 images** (heavily augmented, black cut-outs) | v1 @ conf 0.3 | mAP50 **0.516**, P **0.552**, R **0.823** | Finds most potholes; false box on a **car bumper** (0.71). Too few images to trust. |
| Figshare dash-cam frames (visual, 8 random) | v1 @ conf 0.3 | — | **No false boxes, but many misses**: roads full of visible potholes → 0 boxes; hits only at conf 0.37–0.48. Far potholes are a few px wide after 1920→640 resize. |
| Figshare dash-cam full score (`DASHCAM UNSEEN` cell) | v1 | **not captured** | |
| 3 Detroit CROWD dash-cam clips (Ayaan) | v1 (live) | — | **Boxes manhole covers and house siding, misses real damage** (Ayaan, chat 21:04 UTC) |
| Muq's own viewing | v2 dashcam | — | **Reads shadows as potholes a lot; misses obvious potholes** |
| `/test` page (recall/precision on marked Detroit frames) | v1 vs v2 | **not done** | blocked on getting clips (YouTube blocks Colab; local download pending) |

## 3. What's wrong (our diagnosis)
1. **Domain gap.** Most training images are close-ups/handheld; the drive and the demo are forward
   dash-cam frames (wide FOV, hood + sky, potholes small and far, Detroit November light).
2. **No hard negatives.** Nothing in training says "this dark patch is a shadow / manhole / patch /
   siding, not a pothole" → exactly the false positives we see.
3. **Small, far objects at 640.** Full HD → 640 shrinks distant potholes to a few pixels → misses.
   (960 training helped on val, but the phone runs 640.)
4. **Mixed labelling styles** across datasets (some box every distant pothole, some only obvious ones)
   → unconfident model (hits at 0.37–0.48).
5. **Weak evaluation.** Each val set is different, test sets are tiny (6 imgs) or uncaptured, and we
   have **no labelled Detroit test set** — so no number tells us how it'll do on the demo footage.

## 4. Built but NOT run yet
- **`pipeline/train/train_dashcam_rdd.ipynb`** — Ayaan's plan (chat 21:04 UTC): start from
  `dronefreak/rdd2022-yolov8s` (AGPL-3.0), data = Roboflow voxrl + ptvvw + `hiteshram/object-detection-bounding-box-ftfs5` v1
  + `vit-76kid/pothole-detection-project-3yiqt` v1 + Figshare; **two-pass hard-negative mining** from
  Detroit clips in Drive `test-videos/` (current model fires → save frame → human deletes real
  potholes → rest become empty-label training images); Ayaan's hyperparams (640, 60 ep, lr0 0.002,
  warmup 1, hsv_v 0.5, hsv_s 0.7); old-vs-new on held-out dash-cam frames; **ByteTrack demo video**
  with distinct-pothole count; exports `pothole-dashcam.onnx` (640). Dataset build tested offline only.
- **Bake-off cell** (in chat, not run): ours vs `peterhdd/pothole-detection-yolov8` (YOLOv8s, 1 class)
  vs RDD2022 v8s D40, each at 640 / 960 / TTA on the same held-out dash-cam frames.

## 5. Ideas collected (not done)
- **Hard negatives** (biggest lever for shadows/manholes): mine from Detroit footage; add Roboflow
  `pothole-detection-xldvi/potholes-with-negative-ddata`; synthetic shadow augmentation.
- **SAHI tiled inference** for the offline drive pipeline (small/far potholes); TTA; 960–1280 for offline.
- **Temporal filtering:** shadows slide across the road as the car moves, potholes don't — require
  ≥3 tracked frames / same GPS spot before counting.
- **Label 100–200 real Detroit dash-cam frames** in Roboflow (pre-label with the model, fix boxes)
  → a real Detroit **test set** (and fine-tune data).
- Server-side vision check (#88) already turns YOLO false positives into `shadow` and keeps them
  off the map — so recall matters more than precision for the map; precision matters for the live demo look.
- Don't use: keremberke pothole-seg weights (HF flags one file unsafe); MuhammadMoinFaisal repos
  (no weights); RF-DETR (output format doesn't fit Ado's `detector.js`).

## 6. Constraints for any new plan
- **Phone (`/live`)**: ONNX, input 640, YOLO-style output `[1, 4+nc, N]`, 1 class `pothole` (or Ado
  filters by label). YOLO11n ≈ 31 ms WebGPU / 311 ms WASM on laptop; YOLOv8s ≈ 47 ms WebGPU.
  Slots: `models/pothole.onnx` (default) and `models/pothole-dashcam.onnx` (`?m=dashcam`).
- **Drive pipeline (offline, laptop/Colab)**: any size/resolution; server does the vision check.
- **Compute:** Colab Pro, ~90 units left (A100 ≈ 12 units/h, L4 ≈ 5/h). Free T4 also available.
- **Time:** feature freeze Sun 8 AM.

## 7. Where everything is
| What | Where |
|---|---|
| Notebooks | `pipeline/train/train_pothole.ipynb`, `train_dashcam.ipynb`, `train_dashcam_rdd.ipynb` |
| **Committed results** (in this repo) | `pipeline/train/results/v1_phone/` → `results.csv` (per-epoch metrics), `pothole.onnx` (live model) · `pipeline/train/results/v2_dashcam/` → `results.csv`, `args.yaml` (exact training config), `results.png`, `BoxPR_curve.png`, `BoxF1_curve.png`, `confusion_matrix.png`, `pothole.onnx` (640), `pothole_960.onnx`. (`best.pt` files stay in Drive.) |
| v1 weights / ONNX | Muq's Drive `still-there-potholes/handoff/` · ONNX shared: https://drive.google.com/file/d/11DNBg3HDgjZyrn-fL25Ae9iDvJfbTYuY/view |
| v2 weights / ONNX | `still-there-potholes/handoff_dashcam/` · 640 ONNX shared: https://drive.google.com/file/d/16YD6mbM0wf6UMP3pkVGjQa70wpLa9BlR/view |
| Training logs (results.csv, curves, confusion matrix) | `still-there-potholes/runs/y11n_merged/`, `runs/y11n_dashcam960/` (ask Muq to share) |
| Detroit CROWD video ids (from `mapping.csv`, 2 Detroit rows) | sv8WNIh-_w8 jhfGDbwL5MM PXqxzSgdyzU GLZcBdEgfUk PMv1KWDkXE4 44Z4T_wRVmM at_PYHSMu2E 1ICEZAO-lqw Mpe768joUWg |

## 8. Datasets & weights — what was used where
| Dataset / weights | Source | Size / angle | Used in | Role |
|---|---|---|---|---|
| `brad-dwyer/pothole-voxrl` v1 | [Roboflow](https://universe.roboflow.com/brad-dwyer/pothole-voxrl/dataset/1) | 665 imgs (465/133/67), mostly close-up/handheld | **v1** train+val | positives |
| `work-5qhak/potholes-ptvvw` v2 `dashcam_832` | [Roboflow](https://universe.roboflow.com/work-5qhak/potholes-ptvvw/dataset/2) | 730 imgs (550/111/69), dash-cam, 832×832 | **v1** + **v2** train+val | positives |
| Figshare "Potholes dataset with YOLO annotations" | [Figshare 21214400](https://figshare.com/articles/figure/Potholes_dataset_with_YOLO_annotations/21214400) | 2000+ Full HD dash-cam frames, ~1 GB zip | **v2** train/val/test (contiguous 80/10/10), empty labels = backgrounds | positives + backgrounds |
| `potholes-gfbhh/road-damage-ormqn` v2 | [Roboflow](https://universe.roboflow.com/potholes-gfbhh/road-damage-ormqn/dataset/2) | 151 imgs, phone photos | test only (6-img test split) | eval |
| `hiteshram/object-detection-bounding-box-ftfs5` v1 | Roboflow (via [mounishvatti/pothole_detection_yolov8](https://github.com/mounishvatti/pothole_detection_yolov8), MIT) | ? | planned (RDD notebook) | positives |
| `vit-76kid/pothole-detection-project-3yiqt` v1 | Roboflow (same source) | ? | planned (RDD notebook) | positives |
| `pothole-detection-xldvi/potholes-with-negative-ddata` | [Roboflow](https://universe.roboflow.com/pothole-detection-xldvi/potholes-with-negative-ddata) | ? | idea only | negatives |
| RDD2022 (`D40` = pothole) | [sekilab/RoadDamageDetector](https://github.com/sekilab/RoadDamageDetector), CC BY-SA 4.0 | 47k imgs, car-mounted, 6 countries; US subset 424 MB, VOC XML | idea only (#61) | positives |
| CROWD dash-cam videos | [crowd-dataset/crowd](https://github.com/crowd-dataset/crowd) `mapping.csv` → YouTube ids (§7) | real Detroit dash-cam | Ayaan's qualitative test; planned hard negatives | eval / negatives |
| `yolo11n.pt` (COCO) | Ultralytics, AGPL-3.0 | — | **v1** start weights | weights |
| `dronefreak/rdd2022-yolov8s` | [HF](https://huggingface.co/dronefreak/rdd2022-yolov8s), AGPL-3.0, self-reported mAP50 61.5 (4 classes) | — | planned start weights | weights |
| `peterhdd/pothole-detection-yolov8` | [HF](https://huggingface.co/peterhdd/pothole-detection-yolov8), YOLOv8s 1-class, 100 ep | — | bake-off candidate | weights |
