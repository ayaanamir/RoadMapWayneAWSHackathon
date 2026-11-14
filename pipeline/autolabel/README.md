
## eval_models.py

One scoreboard for every candidate pothole model, scored on the same labelled frames
(YOLO-format `--images` / `--labels`, class 0 = pothole, missing/empty label = no pothole).

```
python eval_models.py --images DIR --labels DIR --out DIR \
    --model rdd2022.pt:3 --model live.onnx [--modes 640,960,road2x] [--device cpu]
```

- `MODEL[:ids]` = which predicted class ids count as pothole (default all).
- Modes: `640`, `960` (plain predict, conf 0.01) and `road2x` (crop y 35%-95%, two tiles with 15% overlap at 640, merged with NMS 0.5).
- Box TP = IoU >= 0.3, greedy by score; conf swept 0.05-0.90. Frame-level P/R too.
- Outputs: `report.md` (sorted table + verdict), `results.json` (all curves), `worst_errors.html` (top model: 30 worst false positives and missed GT boxes; open it from the out dir, image paths are relative).
- Needs ultralytics, opencv, numpy. Note: ONNX models are fixed-size, so the 960 mode may just be letterboxed to the export size.
