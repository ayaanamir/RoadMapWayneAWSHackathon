#!/usr/bin/env python3
"""Label dash-cam frames with a big vision model (the "teacher") for YOLO training.

Usage:
  export OPENROUTER_API_KEY=...
  python3 teacher_label.py --images frames/ --out labeled/ [--limit 50]
  python3 teacher_label.py --images frames/ --out labeled/ --dry-run   # no API, fake teacher

Writes OUT/labels/<rel>.txt (YOLO, class 0), OUT/cache/<rel>.json (raw replies,
reruns skip cached images), OUT/summary.csv and OUT/review.html.
Stdlib only.
"""
import argparse, base64, csv, hashlib, html, json, os, re, struct, sys, time
import urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

PROMPT = """You are labelling dash-cam road images for a pothole detector. Be strict.

Definitions:
- POTHOLE: an open hole or broken-out depression in the road surface with visible edges and depth. ANY size counts, including small or distant ones.
- NOT potholes (list them as lookalikes): patched or filled areas, manholes, drains, shadows, puddles, cracks without a hole, siding/seams, anything else.

Reply with ONLY this JSON, no prose, no code fences:
{"potholes":[{"box_2d":[ymin,xmin,ymax,xmax],"confidence":0.0,"note":"short reason"}],
 "lookalikes":[{"box_2d":[ymin,xmin,ymax,xmax],"kind":"manhole|patch|shadow|crack|puddle|siding|other"}],
 "road_visible": true}

box_2d values are integers normalised to 0-1000 (ymin, xmin, ymax, xmax). confidence is 0-1.
If there is no pothole use an empty "potholes" list. Set road_visible false if no road surface is visible."""

EXTS = (".jpg", ".jpeg", ".png")


def find_images(root):
    out = []
    for d, _, files in os.walk(root):
        for f in files:
            if f.lower().endswith(EXTS):
                out.append(os.path.join(d, f))
    return sorted(out)


def image_size(path):
    """(w, h) from JPEG/PNG header, stdlib only."""
    with open(path, "rb") as f:
        head = f.read(26)
        if head[:8] == b"\x89PNG\r\n\x1a\n":
            return struct.unpack(">II", head[16:24])
        if head[:2] == b"\xff\xd8":
            f.seek(2)
            while True:
                b = f.read(1)
                while b and b != b"\xff":
                    b = f.read(1)
                while b == b"\xff":
                    b = f.read(1)
                if not b:
                    break
                m = b[0]
                if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                    continue
                ln = struct.unpack(">H", f.read(2))[0]
                if 0xC0 <= m <= 0xCF and m not in (0xC4, 0xC8, 0xCC):
                    d = f.read(5)
                    h, w = struct.unpack(">HH", d[1:5])
                    return w, h
                f.seek(ln - 2, 1)
    raise ValueError("cannot read image size: " + path)


def extract_json(text):
    """Pull the first JSON object out of text (handles ```json fences and prose)."""
    if not text:
        raise ValueError("empty reply")
    cands = [text]
    m = re.search(r"```(?:json)?\s*(.*?)```", text, re.S | re.I)
    if m:
        cands.insert(0, m.group(1))
    for c in cands:
        c = c.strip()
        try:
            return json.loads(c)
        except ValueError:
            pass
        start = c.find("{")
        while start != -1:
            depth, in_str, esc = 0, False, False
            for i in range(start, len(c)):
                ch = c[i]
                if in_str:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_str = False
                elif ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        try:
                            return json.loads(c[start:i + 1])
                        except ValueError:
                            break
            start = c.find("{", start + 1)
    raise ValueError("no JSON object found in reply")


def fake_teacher(path):
    """Deterministic fake reply for --dry-run, keyed on the file name."""
    h = int(hashlib.md5(os.path.basename(path).encode()).hexdigest(), 16)
    k = h % 4
    res = {"potholes": [], "lookalikes": [], "road_visible": True}
    if k == 0:
        x, y = 200 + h // 7 % 400, 500 + h // 11 % 200
        res["potholes"].append({"box_2d": [y, x, y + 120, x + 160], "confidence": 0.9, "note": "fake pothole"})
    elif k == 1:
        res["potholes"].append({"box_2d": [600, 100, 700, 200], "confidence": 0.3, "note": "fake low conf"})
        res["lookalikes"].append({"box_2d": [550, 500, 650, 600], "kind": "manhole"})
    elif k == 2:
        res["lookalikes"].append({"box_2d": [700, 300, 800, 450], "kind": "shadow"})
    return {"text": json.dumps(res), "tokens_in": 0, "tokens_out": 0}


def call_teacher(path, args, key):
    """Return {"text", "tokens_in", "tokens_out"}; retries 429/5xx with backoff."""
    mime = "image/png" if path.lower().endswith(".png") else "image/jpeg"
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode()
    body = json.dumps({
        "model": args.model, "temperature": 0,
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": PROMPT},
            {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mime, b64)}}]}],
    }).encode()
    url = args.base_url.rstrip("/") + "/chat/completions"
    last = None
    for attempt in range(5):  # first try + max 4 retries
        req = urllib.request.Request(url, data=body, headers={
            "Authorization": "Bearer " + key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                d = json.loads(r.read().decode())
            text = d["choices"][0]["message"]["content"]
            if isinstance(text, list):
                text = "".join(p.get("text", "") for p in text if isinstance(p, dict))
            u = d.get("usage") or {}
            return {"text": text, "tokens_in": u.get("prompt_tokens", 0), "tokens_out": u.get("completion_tokens", 0)}
        except urllib.error.HTTPError as e:
            last = "HTTP %d" % e.code
            if e.code != 429 and e.code < 500:
                raise RuntimeError(last + ": " + e.read().decode("utf-8", "replace")[:200])
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            last = "network: %s" % e
        except (KeyError, IndexError, ValueError) as e:
            raise RuntimeError("bad API reply: %s" % e)
        if attempt < 4:
            time.sleep(2 ** attempt)
    raise RuntimeError("gave up after retries: %s" % last)


def yolo_lines(potholes, w, h, min_conf):
    lines = []
    for p in potholes:
        try:
            if float(p.get("confidence", 0)) < min_conf:
                continue
            ymin, xmin, ymax, xmax = [float(v) for v in p["box_2d"]]
        except (KeyError, TypeError, ValueError):
            continue
        x1, x2 = sorted((min(max(xmin, 0), 1000), min(max(xmax, 0), 1000)))
        y1, y2 = sorted((min(max(ymin, 0), 1000), min(max(ymax, 0), 1000)))
        bw, bh = (x2 - x1) / 1000 * w, (y2 - y1) / 1000 * h
        if bw < 4 or bh < 4:
            continue
        lines.append("0 %.6f %.6f %.6f %.6f" % ((x1 + x2) / 2000, (y1 + y2) / 2000, (x2 - x1) / 1000, (y2 - y1) / 1000))
    return lines


def process(path, rel, args, key):
    """Get (cached or fresh) reply for one image; returns a result dict."""
    base = os.path.splitext(rel)[0]
    cpath = os.path.join(args.out, "cache", base + ".json")
    res = {"rel": rel, "path": path, "error": "", "parsed": None, "tokens_in": 0, "tokens_out": 0, "cached": False}
    try:
        if os.path.exists(cpath):
            with open(cpath) as f:
                c = json.load(f)
            res["cached"] = True
        else:
            c = fake_teacher(path) if args.dry_run else call_teacher(path, args, key)
            os.makedirs(os.path.dirname(cpath), exist_ok=True)
            with open(cpath, "w") as f:
                json.dump(c, f)
        res["tokens_in"], res["tokens_out"] = c.get("tokens_in", 0), c.get("tokens_out", 0)
        res["parsed"] = extract_json(c["text"])
    except Exception as e:  # keep going, record the error
        res["error"] = str(e).replace("\n", " ")[:200]
    return res


def write_review(out, results):
    cards = []
    for r in results:
        p = r["parsed"] or {}
        pot = p.get("potholes") or []
        look = p.get("lookalikes") or []
        kinds = []
        if any(float(x.get("confidence", 0) or 0) >= r["min_conf"] for x in pot if isinstance(x, dict)):
            kinds.append("pothole")
        if look:
            kinds.append("lookalike")
        if not kinds:
            kinds.append("empty")
        boxes = []

        def box(b, cls, label):
            try:
                y1, x1, y2, x2 = [float(v) / 10 for v in b["box_2d"]]
            except (KeyError, TypeError, ValueError):
                return
            boxes.append('<div class="b %s" style="left:%.2f%%;top:%.2f%%;width:%.2f%%;height:%.2f%%"><span>%s</span></div>'
                         % (cls, x1, y1, x2 - x1, y2 - y1, html.escape(label)))
        for x in pot:
            if isinstance(x, dict):
                box(x, "pot", "%.2f" % float(x.get("confidence", 0) or 0))
        for x in look:
            if isinstance(x, dict):
                box(x, "look", str(x.get("kind", "other")))
        src = html.escape(os.path.relpath(r["path"], out).replace(os.sep, "/"), quote=True)
        err = '<div class="err">%s</div>' % html.escape(r["error"]) if r["error"] else ""
        cards.append('<div class="card" data-k="%s"><div class="im"><img loading="lazy" src="%s">%s</div>'
                     '<div class="cap">%s</div>%s</div>' % (" ".join(kinds), src, "".join(boxes), html.escape(r["rel"]), err))
    page = """<!doctype html><meta charset="utf-8"><title>Teacher labels review</title>
<style>body{font:13px sans-serif;background:#111;color:#ddd;margin:8px}
button{margin:0 4px 8px 0;padding:4px 10px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:8px}
.im{position:relative;line-height:0}.im img{width:100%%}.b{position:absolute;box-sizing:border-box}
.b.pot{border:2px solid #fc0}.b.look{border:2px dashed #999}.b span{position:absolute;top:0;left:0;background:#000a;color:#fff;font-size:10px;line-height:1.2;padding:0 2px}
.cap{font-size:11px;word-break:break-all}.err{color:#f66}.card.hide{display:none}</style>
<div id="f"><button data-f="all">all</button><button data-f="pothole">has pothole</button>
<button data-f="lookalike">has lookalike</button><button data-f="empty">empty</button> <span id="n"></span></div>
<div class="grid">%s</div>
<script>var cs=[].slice.call(document.querySelectorAll('.card'));
function sh(f){var n=0;cs.forEach(function(c){var ok=f=='all'||c.dataset.k.split(' ').indexOf(f)>=0;c.classList.toggle('hide',!ok);if(ok)n++});document.getElementById('n').textContent=n+' shown'}
document.getElementById('f').onclick=function(e){if(e.target.dataset.f)sh(e.target.dataset.f)};sh('all');</script>""" % "\n".join(cards)
    with open(os.path.join(out, "review.html"), "w") as f:
        f.write(page)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--images", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--model", default="google/gemini-4-carbon")
    ap.add_argument("--base-url", default="https://openrouter.ai/api/v1")
    ap.add_argument("--concurrency", type=int, default=8)
    ap.add_argument("--min-conf", type=float, default=0.5)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--dry-run", action="store_true", help="no API calls, deterministic fake teacher")
    ap.add_argument("--price-in", type=float, default=2.0, help="USD per 1M input tokens")
    ap.add_argument("--price-out", type=float, default=10.0, help="USD per 1M output tokens")
    args = ap.parse_args()

    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not args.dry_run and not key:
        sys.exit("error: set OPENROUTER_API_KEY (or use --dry-run)")
    if not os.path.isdir(args.images):
        sys.exit("error: --images is not a directory: " + args.images)
    imgs = find_images(args.images)
    if args.limit:
        imgs = imgs[:args.limit]
    if not imgs:
        sys.exit("error: no .jpg/.png images under " + args.images)
    os.makedirs(args.out, exist_ok=True)

    jobs = [(p, os.path.relpath(p, args.images)) for p in imgs]
    with ThreadPoolExecutor(max_workers=max(1, args.concurrency)) as ex:
        results = list(ex.map(lambda j: process(j[0], j[1], args, key), jobs))

    rows, no_road = [], []
    tot = dict(images=len(results), cached=0, errors=0, labeled=0, with_pothole=0, boxes=0, empty=0, tin=0, tout=0)
    for r in results:
        r["min_conf"] = args.min_conf
        tot["tin"] += r["tokens_in"]
        tot["tout"] += r["tokens_out"]
        tot["cached"] += r["cached"]
        p = r["parsed"]
        if p is None:
            tot["errors"] += 1
            rows.append([r["rel"], "", "", "", "", r["tokens_in"], r["tokens_out"], r["error"]])
            continue
        pot = [x for x in (p.get("potholes") or []) if isinstance(x, dict)]
        look = [x for x in (p.get("lookalikes") or []) if isinstance(x, dict)]
        road = p.get("road_visible", True) is not False
        w, h = image_size(r["path"])
        lines = yolo_lines(pot, w, h, args.min_conf)
        rows.append([r["rel"], len(lines), len(look), "|".join(str(x.get("kind", "other")) for x in look),
                     str(road).lower(), r["tokens_in"], r["tokens_out"], ""])
        if not road and not lines:
            no_road.append(r["rel"])
            continue
        lp = os.path.join(args.out, "labels", os.path.splitext(r["rel"])[0] + ".txt")
        os.makedirs(os.path.dirname(lp), exist_ok=True)
        with open(lp, "w") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))
        tot["labeled"] += 1
        tot["boxes"] += len(lines)
        tot["with_pothole" if lines else "empty"] += 1

    with open(os.path.join(args.out, "summary.csv"), "w", newline="") as f:
        w_ = csv.writer(f)
        w_.writerow(["image", "n_potholes", "n_lookalikes", "lookalike_kinds", "road_visible", "tokens_in", "tokens_out", "error"])
        w_.writerows(rows)
    with open(os.path.join(args.out, "no_road.txt"), "w") as f:
        f.write("\n".join(no_road) + ("\n" if no_road else ""))
    write_review(args.out, results)

    cost = tot["tin"] / 1e6 * args.price_in + tot["tout"] / 1e6 * args.price_out
    print("images: %(images)d (from cache: %(cached)d, errors: %(errors)d)" % tot)
    print("labels written: %(labeled)d  (with pothole: %(with_pothole)d, empty/background: %(empty)d, boxes: %(boxes)d)" % tot)
    print("no_road (skipped, listed in no_road.txt): %d" % len(no_road))
    print("tokens in/out: %d / %d   est. cost: $%.4f%s" % (tot["tin"], tot["tout"], cost, " (dry run)" if args.dry_run else ""))
    print("out: " + args.out)


if __name__ == "__main__":
    main()
