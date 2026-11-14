#!/usr/bin/env python3
"""Team project board = GitHub issues labeled area:* / status:*. No dependencies.

  python3 scripts/board.py                      # whole board: who's doing what, what's next
  python3 scripts/board.py next <area>          # next unclaimed tasks for an area
  python3 scripts/board.py claim <#> "<name>"   # take a task (posts START in the agent chat)
  python3 scripts/board.py done <#>             # finish it (closes issue, posts DONE)
  python3 scripts/board.py block <#> "<why>"    # mark blocked (posts BLOCKED)
  python3 scripts/board.py unclaim <#>          # give it back

Areas: api, map, pipeline, live, pitch. "<name>" = your name + agent, e.g. "Ayaan/claude-1".
Auth: `gh auth token` if logged in, else $GITHUB_TOKEN.
"""
import json
import os
import re
import subprocess
import sys
import urllib.request

REPO = "ayaanamir/RoadMapWayneAWSHackathon"
BASE = f"https://api.github.com/repos/{REPO}"
CHAT_ISSUE = 1
AREAS = ["api", "map", "pipeline", "live", "pitch", "team"]
CLAIM_RE = re.compile(r"\n*\*\*Claimed by:\*\* .*$", re.S)
_TOKEN = None


def token():
    global _TOKEN
    if _TOKEN:
        return _TOKEN
    try:
        _TOKEN = subprocess.run(["gh", "auth", "token"], capture_output=True, text=True, timeout=10).stdout.strip()
    except (FileNotFoundError, subprocess.TimeoutExpired):
        _TOKEN = ""
    _TOKEN = _TOKEN or os.environ.get("GITHUB_TOKEN", "").strip()
    if not _TOKEN:
        sys.exit("No GitHub auth. Run `gh auth login` or set GITHUB_TOKEN.")
    return _TOKEN


def call(path, method="GET", data=None):
    req = urllib.request.Request(BASE + path, method=method)
    req.add_header("Authorization", f"Bearer {token()}")
    req.add_header("Accept", "application/vnd.github+json")
    body = json.dumps(data).encode() if data is not None else None
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, body, timeout=20) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def all_tasks(state="all"):
    out, page = [], 1
    while True:
        batch = call(f"/issues?state={state}&per_page=100&page={page}")
        out += [i for i in batch if "pull_request" not in i and i["number"] != CHAT_ISSUE]
        if len(batch) < 100:
            return out
        page += 1


def labels(i):
    return {l["name"] for l in i["labels"]}


def area(i):
    for l in labels(i):
        if l.startswith("area:"):
            return l[5:]
    return "?"


def status(i):
    if i["state"] == "closed":
        return "done"
    for s in ("blocked", "doing"):
        if f"status:{s}" in labels(i):
            return s
    return "todo"


def claimer(i):
    m = re.search(r"\*\*Claimed by:\*\* (.+)", i.get("body") or "")
    return m.group(1).strip() if m else ""


def due(i):
    m = i.get("milestone")
    return (m or {}).get("due_on") or "9999"


def title(i):
    return re.sub(r"^\[\w+\]\s*", "", i["title"])


def short(i):
    ms = (i.get("milestone") or {}).get("title", "").split(" ·")[0]
    return f"#{i['number']:<3} {ms:<5} {title(i)[:80]}"


def set_status(n, new):
    i = call(f"/issues/{n}")
    keep = [l for l in labels(i) if not l.startswith("status:")]
    if new:
        keep.append(f"status:{new}")
    call(f"/issues/{n}", "PATCH", {"labels": keep})
    return i


def chat(msg):
    try:
        call(f"/issues/{CHAT_ISSUE}/comments", "POST", {"body": msg})
    except Exception as e:  # board still works if chat post fails
        print("(chat post failed:", e, ")")


def cmd_board():
    tasks = sorted(all_tasks(), key=lambda i: (due(i), i["number"]))
    print("=" * 96)
    for a in AREAS:
        mine = [i for i in tasks if area(i) == a]
        if not mine:
            continue
        done = sum(status(i) == "done" for i in mine)
        print(f"\n■ {a.upper()}   {done}/{len(mine)} done")
        for s, tag in (("doing", "DOING  "), ("blocked", "BLOCKED")):
            for i in mine:
                if status(i) == s:
                    who = claimer(i) or "?"
                    print(f"  {tag} {short(i)}  ← {who}")
        todo = [i for i in mine if status(i) == "todo"][:3]
        for i in todo:
            print(f"  next    {short(i)}")
    print("\n" + "=" * 96)


def cmd_next(a):
    for i in sorted(all_tasks("open"), key=lambda i: (due(i), i["number"])):
        if area(i) == a and status(i) == "todo":
            print(short(i))


def cmd_claim(n, who):
    i = call(f"/issues/{n}")
    if status(i) == "doing" and claimer(i) and claimer(i) != who:
        sys.exit(f"#{n} is already claimed by {claimer(i)}. Pick another (board.py next {area(i)}).")
    body = CLAIM_RE.sub("", i.get("body") or "") + f"\n\n**Claimed by:** {who}"
    call(f"/issues/{n}", "PATCH", {"body": body})
    set_status(n, "doing")
    chat(f"[{area(i)}] START — #{n} {title(i)} (claimed by {who})")
    print(f"claimed #{n} for {who}")


def cmd_done(n):
    i = set_status(n, None)
    call(f"/issues/{n}", "PATCH", {"state": "closed"})
    chat(f"[{area(i)}] DONE — #{n} {title(i)}")
    print(f"closed #{n}")


def cmd_block(n, why):
    i = set_status(n, "blocked")
    call(f"/issues/{n}/comments", "POST", {"body": f"Blocked: {why}"})
    chat(f"[{area(i)}] BLOCKED — #{n}: {why}")
    print(f"blocked #{n}")


def cmd_unclaim(n):
    i = call(f"/issues/{n}")
    call(f"/issues/{n}", "PATCH", {"body": CLAIM_RE.sub("", i.get("body") or "")})
    set_status(n, "todo")
    chat(f"[{area(i)}] HEADS-UP — #{n} is unclaimed again")
    print(f"unclaimed #{n}")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        cmd_board()
    elif a[0] == "next" and len(a) == 2:
        cmd_next(a[1])
    elif a[0] == "claim" and len(a) >= 3:
        cmd_claim(int(a[1].lstrip("#")), " ".join(a[2:]))
    elif a[0] == "done" and len(a) == 2:
        cmd_done(int(a[1].lstrip("#")))
    elif a[0] == "block" and len(a) >= 3:
        cmd_block(int(a[1].lstrip("#")), " ".join(a[2:]))
    elif a[0] == "unclaim" and len(a) == 2:
        cmd_unclaim(int(a[1].lstrip("#")))
    else:
        sys.exit(__doc__)
