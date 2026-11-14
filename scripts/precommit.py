#!/usr/bin/env python3
"""Collision check: fetch, then tell you if your changes overlap someone else's. No dependencies.

  python3 scripts/precommit.py                 # fetch origin + report
  python3 scripts/precommit.py --install-hook  # run it automatically on every `git commit`
  python3 scripts/precommit.py --prompt        # short report (Claude Code runs this on every message)
  python3 scripts/precommit.py --no-fetch      # offline: skip the fetch

It does NOT restrict which files you may edit. It compares YOUR changes (commits on your
branch not yet on main + staged + unstaged + untracked) with what others changed:
  - origin/main since you branched off, and
  - every other unmerged branch on origin (teammates' work in progress).

For each file you both touched it simulates the merge (`git merge-tree`, nothing on disk changes):
  CONFLICT  you both changed the same lines → talk / rebase before going further
  OVERLAP   same file, different lines → merges cleanly, just be aware
  SAME      you both made the identical change → nothing to do

The only thing that blocks a commit: secrets, .env, video/.gpx/weights, or files > 5 MB.
"""
import os
import re
import subprocess
import sys

BAD_NAMES = re.compile(r"(^|/)\.env$|\.pem$|\.(mp4|mov|avi|gpx|pt|onnx|engine)$", re.I)
SECRET_PATTERNS = [
    re.compile(r"sk-or-v1-[0-9a-f]{20,}"),                      # OpenRouter
    re.compile(r"postgres(ql)?://[^:\s/]+:[^@\s]+@"),            # DB URL with password
    re.compile(r"AKIA[0-9A-Z]{16}"),                             # AWS-style key id
    re.compile(r"(R2_SECRET_ACCESS_KEY|OPENROUTER_API_KEY)\s*=\s*\S{8,}"),
]
MAX_BYTES = 5 * 1024 * 1024
BASE = "origin/main"


def git(*args, check=False):
    r = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip()}")
    return r.stdout.strip()


def ok(*args):
    return subprocess.run(["git", *args], capture_output=True).returncode == 0


def lines(s):
    return {l for l in s.splitlines() if l}


def install_hook():
    hooks = git("rev-parse", "--git-path", "hooks", check=True)
    os.makedirs(hooks, exist_ok=True)
    path = os.path.join(hooks, "pre-commit")
    with open(path, "w", newline="\n") as f:
        f.write('#!/bin/sh\n# installed by scripts/precommit.py\n'
                f'exec "{sys.executable}" scripts/precommit.py --hook "$@"\n')
    os.chmod(path, 0o755)
    print(f"Installed {path}. Every `git commit` now fetches + checks for collisions.")


def snapshot():
    """Commit object of the current working tree (tracked + untracked), via a temp index."""
    import shutil
    import tempfile
    real_index = git("rev-parse", "--git-path", "index")
    fd, tmp = tempfile.mkstemp(prefix="precommit-index-")
    os.close(fd)
    try:
        if os.path.exists(real_index):
            shutil.copyfile(real_index, tmp)
        env = dict(os.environ, GIT_INDEX_FILE=tmp)
        subprocess.run(["git", "add", "-A"], env=env, capture_output=True)
        tree = subprocess.run(["git", "write-tree"], env=env, capture_output=True, text=True).stdout.strip()
        r = subprocess.run(["git", "commit-tree", tree, "-p", "HEAD", "-m", "precommit snapshot"],
                           capture_output=True, text=True)
        return r.stdout.strip() or "HEAD"
    finally:
        os.unlink(tmp)


def conflicted_files(ours, theirs):
    """Files that would conflict if `theirs` merged into `ours` (simulated, no disk changes)."""
    r = subprocess.run(["git", "merge-tree", "--write-tree", "--name-only", "--no-messages", ours, theirs],
                       capture_output=True, text=True)
    if r.returncode == 0:
        return set()
    out = r.stdout.splitlines()
    return {l for l in out[1:] if l}  # first line is the tree id


def main():
    argv = sys.argv[1:]
    if "--install-hook" in argv:
        return install_hook()
    hook, prompt = "--hook" in argv, "--prompt" in argv

    os.chdir(os.path.dirname(os.path.abspath(__file__)))  # works from any cwd
    os.chdir(git("rev-parse", "--show-toplevel", check=True))
    branch = git("rev-parse", "--abbrev-ref", "HEAD")
    notes, problems, blockers = [], [], []

    # 1. Fetch.
    before = git("rev-parse", BASE)
    if "--no-fetch" not in argv:
        try:
            r = subprocess.run(["git", "fetch", "--quiet", "--prune", "origin"],
                               capture_output=True, text=True, timeout=15 if prompt else 60)
            if r.returncode != 0:
                notes.append(f"git fetch failed (offline?): {r.stderr.strip()[:120]}")
        except subprocess.TimeoutExpired:
            notes.append("git fetch timed out — using the last fetched copy of origin.")
    after = git("rev-parse", BASE)
    if before and after != before:
        new = git("log", "--format=%h %s", f"{before}..{after}").replace("\n", "\n        ")
        notes.append(f"New on main since last check:\n        {new}")

    # 2. My changes, plus a snapshot commit of my whole working tree (incl. untracked) so the
    #    merge simulation sees uncommitted work too. Uses a throwaway index; your files, index
    #    and branch are untouched.
    committed = lines(git("diff", "--name-only", f"{BASE}...HEAD"))
    staged = lines(git("diff", "--name-only", "--cached"))
    unstaged = lines(git("diff", "--name-only"))
    untracked = lines(git("ls-files", "--others", "--exclude-standard"))
    mine = committed | staged | unstaged | untracked
    ours = snapshot() if (staged | unstaged | untracked) else "HEAD"

    # 3. Compare with main and with every other unmerged branch on origin.
    upstream = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}") or f"origin/{branch}"
    main_subjects = git("log", "--format=%s", "-300", BASE).splitlines()
    others = [BASE]
    for r in sorted(lines(git("for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"))):
        if r in (BASE, "origin/HEAD", "origin", upstream) or ok("merge-base", "--is-ancestor", r, BASE):
            continue
        tip = git("log", "-1", "--format=%s", r)
        if any(re.fullmatch(re.escape(tip) + r" \(#\d+\)", s) for s in main_subjects):
            continue  # squash-merged via a PR
        others.append(r)

    behind = git("rev-list", "--count", f"HEAD..{BASE}") or "0"
    for ref in others:
        # main: what main changed since we split. A branch: only its own work (vs main),
        # so branches that merely contain main's commits don't show up as collisions.
        theirs = lines(git("diff", "--name-only", f"HEAD...{ref}" if ref == BASE else f"{BASE}...{ref}"))
        overlap = theirs & mine
        if not overlap:
            continue
        who = "main" if ref == BASE else f"{ref} ({git('log', '-1', '--format=%an, %cr', ref)})"
        conflicts = conflicted_files(ours, ref) & overlap
        same = {p for p in overlap - conflicts if ok("diff", "--quiet", ours, ref, "--", p)}
        clean = overlap - conflicts - same
        for p in sorted(conflicts):
            problems.append(f"CONFLICT  {p}: you and {who} changed the same lines.")
        for p in sorted(clean):
            problems.append(f"OVERLAP   {p}: also changed by {who} (different lines, merges cleanly).")
        for p in sorted(same):
            notes.append(f"SAME      {p}: {who} made the identical change.")
    if behind != "0":
        notes.append(f"main is {behind} commit(s) ahead of you → git pull --rebase origin main")

    # 4. Secrets / big files (the only blockers).
    for p in sorted(staged | committed):
        if BAD_NAMES.search(p) and not p.endswith(".env.example"):
            blockers.append(f"{p}: secrets/media/weights don't go in git.")
        if os.path.isfile(p) and os.path.getsize(p) > MAX_BYTES:
            blockers.append(f"{p}: {os.path.getsize(p) // 1024 // 1024} MB — too big for git.")
    for l in (git("diff", "--cached") + "\n" + git("diff", f"{BASE}...HEAD")).splitlines():
        if l.startswith("+") and not l.startswith("+++") and any(p.search(l) for p in SECRET_PATTERNS):
            blockers.append(f"Looks like a secret in your diff: {l[1:].strip()[:60]}…")

    # Report.
    print(f"[collision check] {branch} · {len(mine)} changed file(s) vs main · "
          f"compared with main + {len(others) - 1} teammate branch(es)")
    for n in notes:
        print(f"  {n}")
    for p in problems:
        print(f"  {p}")
    for b in blockers:
        print(f"  BLOCKED   {b}")
    if not (notes or problems or blockers):
        print("  OK  up to date, nobody else is touching your files.")
    if any(p.startswith("CONFLICT") for p in problems):
        print("  → Tell the other person (chat), then git pull --rebase origin main / coordinate.")
    if blockers and hook and not prompt:
        sys.exit(1)


if __name__ == "__main__":
    main()
