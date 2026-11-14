#!/usr/bin/env python3
"""Agent group chat = GitHub issue #1. No dependencies.

  python3 scripts/chat.py read [N]          # show the last N messages (default 15)
  python3 scripts/chat.py post "[api] START — city ingest (branch api/city-ingest)"

Auth: uses `gh auth token` if the GitHub CLI is logged in, else $GITHUB_TOKEN.
"""
import json
import os
import subprocess
import sys
import urllib.request

REPO = "ayaanamir/RoadMapWayneAWSHackathon"
ISSUE = 1
API = f"https://api.github.com/repos/{REPO}/issues/{ISSUE}/comments"
STATUSES = ("START", "DONE", "BLOCKED", "NEED", "HEADS-UP")


def token():
    try:
        t = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10).stdout.strip()
        if t:
            return t
    except (FileNotFoundError, subprocess.TimeoutExpired):
        pass
    t = os.environ.get("GITHUB_TOKEN", "").strip()
    if not t:
        sys.exit("No GitHub auth. Run `gh auth login` or set GITHUB_TOKEN.")
    return t


def call(url, data=None):
    req = urllib.request.Request(url, method="POST" if data else "GET")
    req.add_header("Authorization", f"Bearer {token()}")
    req.add_header("Accept", "application/vnd.github+json")
    body = None
    if data is not None:
        body = json.dumps(data).encode()
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, body, timeout=20) as r:
        return json.loads(r.read() or b"null")


def read(n):
    comments, page = [], 1
    while True:
        batch = call(f"{API}?per_page=100&page={page}")
        comments += batch
        if len(batch) < 100:
            break
        page += 1
    for c in comments[-n:]:
        when = c["created_at"].replace("T", " ").rstrip("Z")
        print(f"--- {when} UTC  @{c['user']['login']}")
        print(c["body"].strip())
    if not comments:
        print("(no messages yet)")


def post(msg):
    if not msg.startswith("[") or not any(s in msg for s in STATUSES):
        sys.exit('Format: "[area] STATUS — task", STATUS in ' + ", ".join(STATUSES))
    c = call(API, {"body": msg})
    print("posted:", c["html_url"])


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "read":
        read(int(sys.argv[2]) if len(sys.argv) > 2 else 15)
    elif len(sys.argv) >= 3 and sys.argv[1] == "post":
        post(" ".join(sys.argv[2:]))
    else:
        sys.exit(__doc__)
