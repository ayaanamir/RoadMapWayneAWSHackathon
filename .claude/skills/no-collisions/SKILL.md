---
name: no-collisions
description: Team ruleset that stops the 3 people / agents in this repo from overwriting each other. Use before starting any task, before EVERY commit, before every push or PR, and whenever you're unsure if a file is yours to edit.
---

# No-collisions ruleset (Still There?, 3 people, many agents)

Owners: **Ayaan** = `api` + `map` (+ `repo`), **Muq** = `pipeline`, **Ado** = `live` + `pitch`.
`shared/` is locked for everyone. Full rules: root `AGENTS.md`. This file is the checklist.

| Area | You may write |
|---|---|
| `api` | `api/`, `services/api/`, root `package.json` / `package-lock.json` / `tsconfig.json` |
| `map` | `apps/map/` |
| `pipeline` | `pipeline/` |
| `live` | `apps/live/` |
| `pitch` | `pitch/` |
| `repo` (Ayaan) | root files, `docs/`, `scripts/`, `.github/`, `.claude/`, `vercel.json` |
| everyone | append ONE line to `docs/REQUESTS.md` |
| nobody* | `shared/` (*only after the human says "change the contract": add fields, bump version) |

## Once per checkout

```bash
git config stillthere.area pipeline          # your area(s), comma list: api,map
python3 scripts/precommit.py --install-hook  # auto-runs the check on every git commit
```

## Before starting a task

1. `git fetch origin && git pull --rebase origin main`
2. `python3 scripts/chat.py read` — contract changed? someone on the same thing?
3. `python3 scripts/board.py next <area>` → `python3 scripts/board.py claim <#> "<human>/<agent>"`
   Never take an issue someone else claimed.
4. New branch: `git checkout -b <area>/<short-task>`. One agent = one branch = one checkout
   (second agent → `git worktree add ../<dir> -b <area>/<task>`).

## Before EVERY commit (the hook does this; run it by hand if no hook)

```bash
python3 scripts/precommit.py
```

It fetches `origin`, then:
- **FAIL** if any changed file is outside your area, touches `shared/`, edits (not appends)
  `docs/REQUESTS.md`, or contains secrets / video / `.gpx` / weights / files > 5 MB.
- **FAIL** if `origin/main` moved and changed the **same files** you did → `git pull --rebase origin main` first.
- **WARN** if `origin/main` moved with no overlap → rebase before pushing.
- **WARN** if another unmerged branch on `origin` edits the same files → read chat, talk first.

On FAIL: fix it. Out-of-area change → `git restore <file>` (or `git restore --staged <file>`)
and write what you need in `docs/REQUESTS.md`. Never `--no-verify` without telling the chat.

## Before push / PR

1. `git fetch origin && git pull --rebase origin main`, then `python3 scripts/precommit.py` again.
2. Rebase conflict in a file **outside your area** → `git rebase --abort`, stop, tell your human.
   Never resolve someone else's file. Conflict inside your area → resolve, re-run your area check.
3. Run your area's done check (in your area's `AGENTS.md`).
4. `git push -u origin <area>/<task>`, PR with `Closes #<n>`, merge as soon as it runs.
5. `python3 scripts/board.py done <#>` and post `DONE` in chat.

## Never

- Commit to `main`, `git push --force` to `main`, or rewrite pushed history.
- Delete, move, or "clean up" another area's files.
- Import code from another area — talk over the API (`shared/CONTRACTS.md`) only.
- Add dependencies to another area's `requirements.txt` / `package.json`.
- Run two agents in the same checkout.
