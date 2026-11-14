---
name: no-collisions
description: Team workflow that stops the 3 people / agents in this repo from overwriting each other — fetch constantly and check whether your changes overlap anyone else's. Use before starting any task, before EVERY commit, before every push or PR.
---

# No-collisions workflow (Still There?, 3 people, many agents)

Owners (who usually works where): **Ayaan** = `api/`, `services/api/`, `apps/map/`;
**Muq** = `pipeline/`; **Ado** = `apps/live/`, `pitch/`. You may edit any file — the
tooling doesn't block you. What it does is **fetch and tell you when your changes collide
with someone else's**, so you can talk before it becomes a merge mess.

## The check: `python3 scripts/precommit.py`

Fetches `origin`, then compares YOUR changes (branch commits + staged + unstaged +
untracked) with `origin/main` and every other unmerged branch on `origin`. For each file
you both touched it simulates the merge (nothing on disk changes):

| Result | Meaning | Do |
|---|---|---|
| `CONFLICT` | you both changed the same lines | stop, tell them in chat, agree who keeps what, then rebase |
| `OVERLAP` | same file, different lines | merges cleanly; glance at their change |
| `SAME` | identical change on both sides | nothing |
| `New on main` / `main is N ahead` | someone merged | `git pull --rebase origin main` |
| `BLOCKED` | secret, `.env`, video/`.gpx`/weights, file > 5 MB | remove it; the only thing that stops a commit |

It runs automatically:
- **Every new message** (Claude Code): `.claude/settings.json` `UserPromptSubmit` hook runs
  `--prompt` and puts the report in your context. Read it first. Other agents (Cursor,
  Codex): run `python3 scripts/precommit.py --prompt` at the start of each turn.
- **Every commit**, once you run `python3 scripts/precommit.py --install-hook` (per clone).

## Before starting a task

1. `git pull --rebase origin main`
2. `python3 scripts/chat.py read` — contract changed? someone on the same thing?
3. `python3 scripts/board.py next <area>` → `python3 scripts/board.py claim <#> "<human>/<agent>"`
4. `git checkout -b <area>/<short-task>`. One agent = one branch = one checkout
   (second agent → `git worktree add ../<dir> -b <area>/<task>`).

## Before push / PR

1. `git pull --rebase origin main`, then `python3 scripts/precommit.py`.
2. Any `CONFLICT` with someone's branch → agree in chat first; don't resolve their side alone.
3. Run your area's done check, push, PR with `Closes #<n>`, merge as soon as it runs.
4. `python3 scripts/board.py done <#>` and post `DONE` in chat.

## Still true

- `shared/CONTRACTS.md` changes break everyone: only add fields, bump the version, post HEADS-UP.
- Never commit to `main` directly, never `git push --force` to `main`, never rewrite pushed history.
- Never commit secrets, video, `.gpx`, or model weights.
