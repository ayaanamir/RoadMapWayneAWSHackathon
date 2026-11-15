#!/usr/bin/env python3
"""Upload an ONNX model to the team's R2 bucket so the live page can load it.

    pip install boto3
    python3 apps/live/tools/upload_model.py apps/live/model/yolo11n.onnx
    python3 apps/live/tools/upload_model.py best.onnx --name pothole.onnx    # for #39
    python3 apps/live/tools/upload_model.py drive_..._seg1.mp4 --folder videos  # drive video for the report

Reads R2_* values from the repo's .env file (never commit that file).
Saves the file as models/<name> in the bucket and prints its public URL.
"""
import argparse
import os
import sys
from pathlib import Path

import boto3

REPO_ROOT = Path(__file__).resolve().parents[3]
# Videos need their real type or browsers won't play them from R2.
CONTENT_TYPES = {".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime"}


def read_env(path):
    """Read KEY=value lines from .env. Ignores blank lines and # comments."""
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.split(" #")[0].strip().strip("\"'")
    return values


def main():
    parser = argparse.ArgumentParser(description="Upload a model file to R2.")
    parser.add_argument("file", type=Path, help="the .onnx file to upload")
    parser.add_argument("--name", help="file name in the bucket (default: same as the file)")
    parser.add_argument("--folder", default="models", help="folder in the bucket, e.g. videos for a drive video")
    args = parser.parse_args()

    env = {**read_env(REPO_ROOT / ".env"), **os.environ}
    needed = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_PUBLIC_URL"]
    missing = [k for k in needed if not env.get(k)]
    if missing:
        sys.exit(f"Missing in .env: {', '.join(missing)}")
    if not args.file.is_file():
        sys.exit(f"No such file: {args.file}")

    # R2 speaks the same language as Amazon S3, so the S3 client works with its address.
    r2 = boto3.client(
        "s3",
        endpoint_url=f"https://{env['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=env["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=env["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )

    key = f"{args.folder}/{args.name or args.file.name}"
    size_mb = args.file.stat().st_size / 1_000_000
    print(f"Uploading {args.file} ({size_mb:.1f} MB) to {env['R2_BUCKET']}/{key} ...")
    r2.upload_file(
        str(args.file), env["R2_BUCKET"], key,
        ExtraArgs={
            "ContentType": CONTENT_TYPES.get(args.file.suffix.lower(), "application/octet-stream"),
            # Let browsers keep a copy for an hour so the page loads faster on refresh.
            "CacheControl": "public, max-age=3600",
        },
    )
    print(f"Done. Public URL: {env['R2_PUBLIC_URL'].rstrip('/')}/{key}")


if __name__ == "__main__":
    main()
