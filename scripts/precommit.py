#!/usr/bin/env python3
"""Collision check: run before EVERY commit (and before every push / PR). No dependencies.

  python3 scripts/precommit.py                 # fetch origin, check everything, explain
  python3 scripts/precommit.py --install-hook  # run it automatically on every `git commit`
  python3 scripts/precommit.py --no-fetch      # offline: skip the fetch
  python3 scripts/precommit.py --contract      # allow shared/ (only when your human said
                                               #   "change the contract")

Your area comes from `git config stillthere.area` (comma list, e.g. "api,map"), else
from the branch prefix (`pipeline/frame-sampler` → pipeline). Set it once per checkout:

  git config stillthere.area pipeline

What it checks (FAIL blocks the commit, WARN just tells you):
  FAIL  a file you changed is outside your area
  FAIL  you changed shared/ without --contract
  FAIL  docs/REQUESTS.md edited instead of appended
  FAIL  secrets / video / .gpx / weights / files > 5 MB staged
  FAIL  origin/main moved AND touched the same files as you → rebase first
  WARN  origin/main moved (no overlap) → pull --rebase soon
  WARN  another unmerged branch on origin edits the same files as you
  WARN  you are committing on main
"""
import os
import re
import subprocess
import sys

# Areas → path prefixes they may write. "repo" = everything not listed here (Ayaan).
AREAS = {
    "api": ["api/", "services/api/", "package.json", "package-lock.json", "tsconfig.json"],
    "map": ["apps/map/"],
    "pipeline": ["pipeline/"],
    "live": ["apps/live/"],
    "pitch": ["pitch/"],
}
SHARED = "shared/"
APPEND_ONLY = {"docs/REQUESTS.md"}  # anyone may append one line
BAD_NAMES = re.compile(r"(^|/)\.env$|\.pem$|\.(mp4|mov|avi|gpx|pt|onnx|engine)$", re.I)
SECRET_PATTERNS = [
    re.compile(r"sk-or-v1-[0-9a-f]{20,}"),                      # OpenRouter
    re.compile(r"postgres(ql)?://[^:\s/]+:[^@\s]+@"),            # DB URL with password
    re.compile(r"AKIA[0-9A-Z]{16}"),                             # AWS-style key id
    re.compile(r"(R2_SECRET_ACCESS_KEY|OPENROUTER_API_KEY)\s*=\s*\S{8,}"),
]
MAX_BYTES = 5 * 1024 * 1024

fails, warns = [], []


def git(*args, check=False):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def lines(s):
    return {l for l in s.splitlines() if l}


def area_of(path):
    if path.startswith(SHARED):
        return "shared"
    for name, prefixes in AREAS.items():
        if any(path == p or path.startswith(p) for p in prefixes):
            return name
    return "repo"


def my_areas(branch):
    cfg = git("config", "--get", "stillthere.area")
    if cfg:
        return {a.strip() for a in cfg.split(",") if a.strip()}
    prefix = branch.split("/", 1)[0] if "/" in branch else ""
    if prefix in AREAS or prefix == "repo":
        return {prefix}
    return set()


def install_hook():
    hooks = git("rev-parse", "--git-path", "hooks", check=True)
    os.makedirs(hooks, exist_ok=True)
    path = os.path.join(hooks, "pre-commit")
    with open(path, "w", newline="\n") as f:
        f.write('#!/bin/sh\n# installed by scripts/precommit.py\n'
                f'exec "{sys.executable}" scripts/precommit.py --hook "$@"\n')
    os.chmod(path, 0o755)
    print(f"Installed {path}. Every `git commit` now fetches + checks for collisions.")
    print("Bypass only in an emergency: git commit --no-verify (then tell the chat why).")


def main():
    argv = sys.argv[1:]
    if "--install-hook" in argv:
        return install_hook()
    hook = "--hook" in argv
    contract = "--contract" in argv or os.environ.get("STILLTHERE_CONTRACT") == "1"

    os.chdir(git("rev-parse", "--show-toplevel", check=True))
    branch = git("rev-parse", "--abbrev-ref", "HEAD")

    # 1. Fetch so we compare against what teammates pushed, not a stale copy.
    if "--no-fetch" not in argv:
        r = subprocess.run(["git", "fetch", "--quiet", "--prune", "origin"],
                           capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            warns.append(f"git fetch failed (offline?): {r.stderr.strip()[:120]}")

    if branch == "main":
        warns.append("You are on main. Rule 4: work on a branch named <area>/<task>.")

    areas = my_areas(branch)
    if not areas:
        fails.append(f"Don't know your area (branch '{branch}' has no area prefix). "
                     "Run: git config stillthere.area <api|map|pipeline|live|pitch|repo>[,...]")

    # 2. Every file this branch changes: committed-not-on-main + staged + unstaged + untracked.
    base = "origin/main"
    committed = lines(git("diff", "--name-only", f"{base}...HEAD"))
    staged = lines(git("diff", "--name-only", "--cached"))
    unstaged = set() if hook else lines(git("diff", "--name-only"))
    untracked = set() if hook else lines(git("ls-files", "--others", "--exclude-standard"))
    mine = committed | staged | unstaged | untracked

    # 3. Lane check.
    for p in sorted(mine):
        a = area_of(p)
        if p in APPEND_ONLY:
            removed = [l for l in git("diff", base, "--", p).splitlines()
                       if l.startswith("-") and not l.startswith("---")]
            removed += [l for l in git("diff", "--cached", "--", p).splitlines()
                        if l.startswith("-") and not l.startswith("---")]
            if removed:
                fails.append(f"{p} is append-only; you changed/removed existing lines.")
            continue
        if a == "shared":
            if not contract:
                fails.append(f"{p}: shared/ is LOCKED. Only with your human's 'change the contract' "
                             "→ rerun with --contract, add fields only, bump CONTRACTS.md version.")
            continue
        if areas and a not in areas:
            fails.append(f"{p}: belongs to area '{a}', you are '{','.join(sorted(areas))}'. "
                         "Revert it, or ask for it in docs/REQUESTS.md.")

    # 4. Secrets and big files (staged + committed on this branch).
    for p in sorted(staged | committed):
        if BAD_NAMES.search(p) and not p.endswith(".env.example"):
            fails.append(f"{p}: secrets/media/weights never go in git (rule 5).")
        if os.path.isfile(p) and os.path.getsize(p) > MAX_BYTES:
            fails.append(f"{p}: {os.path.getsize(p) // 1024 // 1024} MB — too big for git.")
    added = [l[1:] for l in (git("diff", "--cached") + "\n" + git("diff", f"{base}...HEAD")).splitlines()
             if l.startswith("+") and not l.startswith("+++")]
    for l in added:
        for pat in SECRET_PATTERNS:
            if pat.search(l):
                fails.append(f"Looks like a secret in your diff: {l.strip()[:60]}…")
                break

    # 5. Did main move under us? Same files = real collision.
    behind = git("rev-list", "--count", f"HEAD..{base}") or "0"
    if behind != "0":
        incoming = lines(git("diff", "--name-only", f"HEAD...{base}"))
        overlap = sorted(incoming & mine)
        if overlap:
            fails.append(f"origin/main is {behind} commit(s) ahead and also changed: "
                         f"{', '.join(overlap)}. Run: git pull --rebase origin main "
                         "(conflict in a file outside your area → stop, tell your human).")
        else:
            warns.append(f"origin/main is {behind} commit(s) ahead (no file overlap). "
                         "Run: git pull --rebase origin main before you push.")

    # 6. Other people's unmerged branches touching the same files.
    me = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or f"origin/{branch}"
    main_subjects = git("log", "--format=%s", "-300", base).splitlines()
    for r in sorted(lines(git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"))):
        if r in ("origin/main", "origin/HEAD", "origin", me):
            continue
        if subprocess.run(["git", "merge-base", "--is-ancestor", r, base]).returncode == 0:
            continue  # already merged (merge commit / fast-forward)
        tip = git("log", "-1", "--format=%s", r)
        if any(re.fullmatch(re.escape(tip) + r" \(#\d+\)", s) for s in main_subjects):
            continue  # squash-merged via a PR
        theirs = lines(git("diff", "--name-only", f"{base}...{r}"))
        overlap = sorted(p for p in theirs & mine
                         if subprocess.run(["git", "diff", "--quiet", r, base, "--", p]).returncode != 0)
        if overlap:
            who = git("log", "-1", "--format=%an, %cr", r)
            warns.append(f"Branch {r} ({who}) also edits: {', '.join(overlap)}. "
                         "Check the chat before you continue.")

    # Report.
    print(f"precommit: branch {branch} · area {','.join(sorted(areas)) or '?'} · "
          f"{len(mine)} file(s) changed vs origin/main")
    for w in warns:
        print(f"  WARN  {w}")
    for f in fails:
        print(f"  FAIL  {f}")
    if fails:
        print("Blocked. Fix the FAIL lines, then commit again.")
        sys.exit(1)
    print("  OK    no collisions." if not warns else "  OK    no blocking problems.")


if __name__ == "__main__":
    main()
