# Rules for every coding agent in this repo

This repo is built by 3 people at the same time, each with their own AI agent(s).
These rules exist so agents never overwrite each other's work. Follow them exactly.

## 0a. Use the project board (one GitHub issue per subtask)

Every task is an issue labeled `area:<area>` and `status:todo|doing|blocked`, grouped
into milestones M0–M5. **The board is the source of truth for who is doing what.**

```
python3 scripts/board.py                    # see the whole board
python3 scripts/board.py next <area>        # your area's next unclaimed tasks
python3 scripts/board.py claim <#> "<name>" # BEFORE you start (also posts START in chat)
python3 scripts/board.py done <#>           # when merged (closes it, posts DONE)
python3 scripts/board.py block <#> "<why>"  # if stuck
```

- `<name>` = your human + agent, e.g. `"Ayaan/claude-1"`, so two agents of the same
  person are distinguishable.
- Only work on an issue you claimed. Never take one claimed by someone else.
- Take tasks in milestone order (the `next` command already sorts them).
- Put `Closes #<n>` in your PR description.
- Your area's `ROADMAP.md` is the plan; the board is the live status. You don't need
  to tick both — the board wins.

## 0. Use the agent chat (GitHub issue #1)

The team's group chat is https://github.com/ayaanamir/RoadMapWayneAWSHackathon/issues/1

- **Before every task:** `python3 scripts/chat.py read` — check nobody else is on it and
  whether anything changed (API URL, contract, blockers).
- **When you start:** `python3 scripts/chat.py post "[<area>] START — <task> (branch <area>/<task>)"`
- **When you finish, get stuck, or need something:** post `DONE`, `BLOCKED`, `NEED`, or
  `HEADS-UP` the same way. One short message each. Include URLs/branch names.
- Areas: `api`, `map`, `pipeline`, `live`, `pitch`, `repo`.
- A `START` on a task is a claim. Don't start a task someone else has claimed and not
  finished.

## 1. Stay in your lane

Every top-level area has exactly one owner. **Only edit files inside the area you were
assigned.** If you weren't told which area you're in, ask before writing anything.

| Area | Owner | What lives there |
|---|---|---|
| `api/` | Backbone | Vercel Functions (TypeScript): the REST API in `shared/CONTRACTS.md` |
| `services/api/` | Backbone | `schema.sql`, city ingest + pothole matching scripts (run locally against Neon) |
| `apps/map/` | Backbone | Map + timeline demo screen (static site) |
| `pipeline/` | Footage | Drive footage → frames → GPS match → YOLO → OpenRouter verify → POST detections |
| `apps/live/` | Live | Phone browser page: camera + YOLO (ONNX Runtime Web) + GPS → POST detections |
| `pitch/` | Live | Pitch script, slides, backup demo video notes |
| `shared/` | **Everyone (locked)** | Data contracts, schemas, fixtures — see rule 3 |
| root files (`vercel.json`, `package.json`), `docs/`, `scripts/`, `.github/` | Ayaan | Repo setup — don't edit unless asked |
| each area's `ROADMAP.md` | that area's owner | Tick boxes as you finish; keep it current |

You may **read** anything. You may only **write** in your own area.

## 2. Talk to other areas only through the contracts

- Never import code from another area's folder. Areas talk over HTTP (the API) or
  through the Neon database, exactly as described in `shared/CONTRACTS.md`.
- If you need something from another area (a new field, a new endpoint), **don't build
  it yourself.** Write it in `docs/REQUESTS.md` (append only, one line, your area + what
  you need) and tell your human. Use the fixtures in `shared/fixtures/` until it exists.

## 3. `shared/` is locked

- Do not change anything in `shared/` unless your human explicitly says
  "change the contract". Contract changes break the other two people.
- When it does change: **add** fields, never rename or remove them. Bump the
  `version` at the top of `shared/CONTRACTS.md` and say what changed in one line.

## 4. Git rules

- Never commit to `main` directly. Work on a branch named `<area>/<short-task>`,
  e.g. `api/city-ingest`, `live/camera-page`, `pipeline/frame-sampler`.
- Small commits, often. Pull `main` before starting each new task:
  `git pull --rebase origin main`.
- Open a PR into `main` and merge it yourself as soon as your area still runs.
  Because areas don't overlap, merges should not conflict. If one does conflict in a
  file **outside** your area, stop and tell your human — do not resolve someone
  else's file.
- Never `git push --force` to `main`. Never rewrite history others have pulled.
- Never delete or move another area's files, even if they look unused.

## 5. Secrets and big files

- Never commit secrets, AWS keys, or `.env`. Use `.env.example` for names only.
- Never commit video, images from the drive, `.gpx` logs, or model weights. Those go
  on the laptop that processes them (frames go to R2 via `POST /api/upload`). `.gitignore` already blocks the common ones.

## 6. Keep it demo-able

- `main` must always run. If your change half-works, keep it on your branch.
- Prefer the simplest thing that works for a 24-hour demo. No new frameworks,
  build tools, or infrastructure without your human's OK.
- Don't add dependencies to another area's `requirements.txt` / `package.json`.

## 6b. Collision check on every message and before EVERY commit

- Every new message: Claude Code runs `python3 scripts/precommit.py --prompt` automatically
  (`.claude/settings.json` hook) — fetches `origin`, reports new `main` commits and
  collisions. Other agents: run it yourself at the start of each turn.

- Once per checkout: `git config stillthere.area <your area(s)>` and
  `python3 scripts/precommit.py --install-hook`.
- Before every commit and push: `python3 scripts/precommit.py` (fetches `origin`, blocks
  out-of-area / `shared/` / secret files, and catches teammates' changes to your files).
- Full checklist: `.claude/skills/no-collisions/SKILL.md` (any agent can read it).

## 7. Before you finish a task

- Run your area's check command (listed in your area's `AGENTS.md`).
- Summarize what you changed in the PR description using the template.
