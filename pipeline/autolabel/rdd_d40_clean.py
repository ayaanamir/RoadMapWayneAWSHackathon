#!/usr/bin/env python3
"""Extract CLEAN D40 (pothole-only) labels + images from the original RDD2022 release.

Why: the HF mirror `dronefreak/RDD2022` merged D43/D44/D50 (crosswalk blur, lane-line blur,
manhole...) into its "pothole" class for Japan/India, so those labels are contaminated. The
original VOC XMLs in the Figshare release (file 38030910, a 13 GB zip of per-country zips,
all STORED) have the true per-class boxes. This script reads everything REMOTELY with HTTP
range requests (zip central directories + per-file reads) — no 13 GB download.

Keeps D40 boxes only. Images with at least one D40 box are written as a flat YOLO set:
OUT/images/<Country>_<id>.jpg, OUT/labels/<Country>_<id>.txt (class 0), plus data.yaml,
samples.png (eyeball grid) and summary.json.

  python3 rdd_d40_clean.py --out rdd_d40_clean [--countries Japan India] [--workers 24] \
      [--limit 0] [--max-per-country 0] [--seed 0]
"""
import argparse, io, json, os, random, struct, sys, zlib
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import requests

FIGSHARE = "https://ndownloader.figshare.com/files/38030910"
UA = {"User-Agent": "Mozilla/5.0 (still-there rdd-d40-clean)"}
CHUNK = 8 << 20  # read-ahead granularity for central directories


def resolve():
    r = requests.get(FIGSHARE, allow_redirects=False, timeout=30, headers=UA)
    if r.status_code == 429:
        raise RuntimeError("figshare 429")
    r.raise_for_status()
    return r.headers["Location"]


def rng(start, end, tries=10):
    """Bytes [start, end] of the Figshare file. The signed URL expires in ~10 s,
    so re-resolve it on every request. Backs off hard on 429/5xx — Figshare's
    ndownloader rate-limits, so keep request counts low (see read_members)."""
    import time
    for t in range(tries):
        try:
            r = requests.get(resolve(), headers={"Range": f"bytes={start}-{end}", **UA}, timeout=180)
            if r.status_code in (200, 206) and r.content:
                return r.content
            raise RuntimeError(f"range status {r.status_code}")
        except Exception as e:
            if t == tries - 1:
                raise
            time.sleep(min(2 ** t * 1.5, 45) + random.random() * 2)


def file_size():
    r = requests.get(resolve(), headers={"Range": "bytes=0-0", **UA}, timeout=60)
    return int(r.headers["Content-Range"].split("/")[1])


def parse_zip64_extra(extra, us, cs, loff):
    j = 0
    while j < len(extra) - 4:
        hid, hsz = struct.unpack("<HH", extra[j:j + 4])
        if hid == 1:
            vals = struct.unpack("<" + "Q" * (hsz // 8), extra[j + 4:j + 4 + hsz])
            if us == 0xFFFFFFFF:
                us, vals = vals[0], vals[1:]
            if cs == 0xFFFFFFFF:
                cs, vals = vals[0], vals[1:]
            if loff == 0xFFFFFFFF:
                loff = vals[0]
        j += 4 + hsz
    return us, cs, loff


def central_directory(read, size):
    """read(start,n) -> bytes of [start, start+n). Returns {name: (method, comp, off)}."""
    tail = read(size - min(size, 1 << 20), min(size, 1 << 20))
    i = tail.rfind(b"PK\x05\x06")
    if i < 0:
        raise RuntimeError("no EOCD")
    n_tot, cd_size, cd_off = struct.unpack("<4s4H2LH", tail[i:i + 22])[4:7]
    if cd_off == 0xFFFFFFFF:
        j = tail.rfind(b"PK\x06\x07")
        z64_off = struct.unpack("<4sLQL", tail[j:j + 20])[2]
        z64 = read(z64_off, 56)
        n_tot, cd_size, cd_off = struct.unpack("<4sQ2H2L4Q", z64[:56])[7:10]
    cd = read(cd_off, cd_size)
    out = {}
    i = 0
    while i < len(cd) - 4:
        if cd[i:i + 4] != b"PK\x01\x02":
            break
        (sig, vm, vn, flags, method, mt, md, crc, cs, us, nl, xl, cl, disk, ia, xa, loff) = struct.unpack(
            "<4s6H3L5H2L", cd[i:i + 46])
        name = cd[i + 46:i + 46 + nl].decode()
        extra = cd[i + 46 + nl:i + 46 + nl + xl]
        us, cs, loff = parse_zip64_extra(extra, us, cs, loff)
        out[name] = (method, cs, loff)
        i += 46 + nl + xl + cl
    return out


def read_member(read, entry):
    """Read one zip member: entry = (method, comp_size, local_header_off)."""
    method, cs, loff = entry
    buf = read(loff, 30 + 4096 + cs)
    return slice_member(buf, 0, method, cs, read, loff)


def slice_member(buf, rel, method, cs, read, loff):
    """Extract one member from a buffer starting at its local header (rel offset)."""
    if buf[rel:rel + 4] != b"PK\x03\x04":
        raise RuntimeError("bad local header")
    nl, xl = struct.unpack("<2H", buf[rel + 26:rel + 30])
    d0 = rel + 30 + nl + xl
    data = buf[d0:d0 + cs]
    if len(data) < cs:  # ran past the buffer end; refetch exactly
        data = read(loff + 30 + nl + xl, cs)
    if method == 0:
        return data
    if method == 8:
        return zlib.decompress(data, -15)
    raise RuntimeError(f"unsupported method {method}")


def read_members(entries, fetch, workers=4, chunk_mb=16, label=""):
    """Batch-read many zip members with few HTTP requests: members stored contiguously
    (sorted by offset) are fetched in spans of up to chunk_mb, one range request per span.
    entries: [(name, (method, comp_size, local_off))] — offsets relative to fetch's base.
    fetch(start, n) -> bytes of [start, start+n). Returns {name: bytes}."""
    entries = sorted(entries, key=lambda kv: kv[1][2])
    spans, cur, cur_end = [], [], -1
    limit = chunk_mb << 20
    for name, e in entries:
        off = e[2]
        end = off + 30 + 4096 + e[1]
        if cur and (end - cur[0][1][2] > limit or len(cur) >= 4000):
            spans.append(cur)
            cur = []
        cur.append((name, e))
        cur_end = max(cur_end, end)
    if cur:
        spans.append(cur)
    out = {}
    failed = 0

    def do_span(span):
        s0 = span[0][1][2]
        s1 = max(e[2] + 30 + 4096 + e[1] for _, e in span)
        buf = fetch(s0, s1 - s0)
        got = {}
        for name, e in span:
            try:
                got[name] = slice_member(buf, e[2] - s0, e[0], e[1], fetch, e[2])
            except Exception:
                got[name] = None
        return got

    with ThreadPoolExecutor(min(workers, len(spans)) or 1) as ex:
        done = 0
        for got in ex.map(do_span, spans):
            done += 1
            for k, v in got.items():
                if v is None:
                    failed += 1
                else:
                    out[k] = v
            print(f"  {label}: span {done}/{len(spans)} (+{len(got)} files, {failed} failed)", flush=True)
    if failed > max(10, 0.02 * len(entries)):
        raise RuntimeError(f"{label}: {failed}/{len(entries)} member reads failed — refusing a truncated set")
    return out


def outer_reader():
    size = file_size()
    return lambda start, n: rng(start, start + n - 1), size


def voc_d40(xml_bytes):
    """-> (filename_stem, [(xmin,ymin,xmax,ymax), ...]) keeping D40 only."""
    root = ET.fromstring(xml_bytes)
    boxes = []
    for obj in root.iter("object"):
        if (obj.findtext("name") or "").strip() != "D40":
            continue
        bb = obj.find("bndbox")
        boxes.append(tuple(float(bb.findtext(t)) for t in ("xmin", "ymin", "xmax", "ymax")))
    return boxes


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True)
    ap.add_argument("--countries", nargs="+", default=["Japan", "India"])
    ap.add_argument("--workers", type=int, default=24)
    ap.add_argument("--limit", type=int, default=0, help="cap XMLs per country (debug)")
    ap.add_argument("--max-per-country", type=int, default=0, help="cap kept images per country")
    ap.add_argument("--seed", type=int, default=0)
    a = ap.parse_args()
    rng_py = random.Random(a.seed)

    read_all, total = outer_reader()
    print(f"outer zip: {total/1e9:.2f} GB")
    outer = central_directory(read_all, total)
    print("outer entries:", ", ".join(f"{k} ({v[1]/1e6:.0f} MB)" for k, v in outer.items()))

    os.makedirs(os.path.join(a.out, "images"), exist_ok=True)
    os.makedirs(os.path.join(a.out, "labels"), exist_ok=True)
    summary = {}
    for country in a.countries:
        key = f"RDD2022/{country}.zip"
        if key not in outer:
            print(f"!! {key} not in outer zip, skipping")
            continue
        # inner zip = raw bytes stored at its local header; find where its data begins
        method, cs, loff = outer[key]
        lh = rng(loff, loff + 30 + 4096 - 1)
        nl, xl = struct.unpack("<2H", lh[26:30])
        base = loff + 30 + nl + xl
        inner = central_directory(lambda s, n: rng(base + s, base + s + n - 1), cs)
        xmls = sorted((n for n in inner if n.lower().endswith(".xml")), key=lambda n: inner[n][2])
        print(f"{country}: inner entries {len(inner)}, xmls {len(xmls)}")
        if a.limit:
            xmls = xmls[:a.limit]

        # 1) read all VOC XMLs in batched range reads, keep D40 boxes
        fetch = lambda s, n: rng(base + s, base + s + n - 1)
        xml_data = read_members([(n, inner[n]) for n in xmls], fetch, workers=4, label=f"{country} xml")
        d40 = {}  # image entry name -> boxes
        for done, name in enumerate(xmls, 1):
            raw = xml_data.get(name)
            if raw is None:
                continue
            try:
                boxes = voc_d40(raw)
            except Exception:
                continue
            if boxes:
                stem = os.path.splitext(os.path.basename(name))[0]
                img_name = None
                for cand in (f"{country}/train/images/{stem}.jpg", f"train/{country}/images/{stem}.jpg",
                             f"{country}/images/{stem}.jpg", f"images/{stem}.jpg"):
                    if cand in inner:
                        img_name = cand
                        break
                if img_name is None:  # fall back: same path, images/ instead of annotations/
                    guess = name.replace("annotations", "images")
                    for ext in (".jpg", ".jpeg", ".png"):
                        if os.path.splitext(guess)[0] + ext in inner:
                            img_name = os.path.splitext(guess)[0] + ext
                            break
                if img_name:
                    d40[img_name] = boxes
        print(f"{country}: {len(d40)} images with D40 of {len(xmls)} xmls")
        items = sorted(d40.items())
        if a.max_per_country and len(items) > a.max_per_country:
            rng_py.shuffle(items)
            items = sorted(items[:a.max_per_country])

        # 2) fetch those images in batched range reads, verify with cv2, write YOLO labels
        import cv2
        import numpy as np
        stats = dict(images=0, boxes=0, failed=0)
        img_data = read_members([(n, inner[n]) for n, _ in items], fetch, workers=4, label=f"{country} img")
        for done, (img_name, boxes) in enumerate(items, 1):
            raw = img_data.get(img_name)
            im = cv2.imdecode(np.frombuffer(raw, np.uint8), cv2.IMREAD_COLOR) if raw else None
            if im is None:
                stats["failed"] += 1
                continue
            H, W = im.shape[:2]
            stem = os.path.splitext(os.path.basename(img_name))[0]
            out_name = f"{country}_{stem}"
            with open(os.path.join(a.out, "images", out_name + ".jpg"), "wb") as f:
                f.write(raw)
            with open(os.path.join(a.out, "labels", out_name + ".txt"), "w") as f:
                for x0, y0, x1, y1 in boxes:
                    cx, cy = (x0 + x1) / 2 / W, (y0 + y1) / 2 / H
                    w, h = (x1 - x0) / W, (y1 - y0) / H
                    if w > 0 and h > 0:
                        f.write(f"0 {cx:.6f} {cy:.6f} {w:.6f} {h:.6f}\n")
                        stats["boxes"] += 1
            stats["images"] += 1
            if done % 1000 == 0:
                print(f"  {country}: images {done}/{len(items)}", flush=True)
        summary[country] = dict(xmls=len(xmls), d40_images=len(d40), written=stats["images"],
                                boxes=stats["boxes"], failed=stats["failed"])
        print(f"{country}: wrote {stats['images']} images, {stats['boxes']} D40 boxes, {stats['failed']} failed")

    with open(os.path.join(a.out, "data.yaml"), "w") as f:
        f.write(f"path: {os.path.abspath(a.out)}\ntrain: images\nval: images\nnames: [pothole]\nnc: 1\n")
    json.dump(summary, open(os.path.join(a.out, "summary.json"), "w"), indent=2)

    # samples.png: 16 random boxed images with rectangles
    import cv2
    import numpy as np
    labs = [f for f in os.listdir(os.path.join(a.out, "labels")) if os.path.getsize(os.path.join(a.out, "labels", f))]
    pick = rng_py.sample(labs, min(16, len(labs)))
    tiles = []
    for lf in pick:
        im = cv2.imread(os.path.join(a.out, "images", os.path.splitext(lf)[0] + ".jpg"))
        if im is None:
            continue
        H, W = im.shape[:2]
        for ln in open(os.path.join(a.out, "labels", lf)):
            p = ln.split()
            if len(p) >= 5:
                cx, cy, w, h = map(float, p[1:5])
                cv2.rectangle(im, (int((cx - w / 2) * W), int((cy - h / 2) * H)),
                              (int((cx + w / 2) * W), int((cy + h / 2) * H)), (0, 255, 0), 2)
        tiles.append(cv2.resize(im, (320, 320)))
    while len(tiles) < 16:
        tiles.append(np.zeros((320, 320, 3), np.uint8))
    grid = np.vstack([np.hstack(tiles[i * 4:(i + 1) * 4]) for i in range(4)])
    cv2.imwrite(os.path.join(a.out, "samples.png"), grid)
    print(json.dumps(summary, indent=2))
    print("samples ->", os.path.join(a.out, "samples.png"))


if __name__ == "__main__":
    main()
