# How we work in parallel (read once, 2 minutes)

## The one idea

Each person owns folders. Your agent only writes in your folders. Everything that crosses
between folders goes through `shared/CONTRACTS.md` (data shapes + API). That's why we
can't conflict.

## Starting your agent

Open your agent with your area as the working directory, and start with:

> You are working on the **<Backbone | Footage | Live>** area of this repo.
> Read `AGENTS.md` at the repo root and the `AGENTS.md` in your area folder.
> Only write inside your area. Read the agent chat first (`python3 scripts/chat.py read`)
> and post START/DONE there. Next task: the first unchecked box in your area's `ROADMAP.md`.

Claude Code reads `CLAUDE.md` files automatically (they point at `AGENTS.md`).
Cursor / Codex read `AGENTS.md` directly.

## Running 2+ agents yourself

Don't run two agents in the same checkout — they'll fight over the working tree.
Give each one its own worktree on its own branch:

```bash
git worktree add ../roadmap-api-ingest -b api/city-ingest
git worktree add ../roadmap-map-ui     -b map/timeline-ui
```

Each agent gets one folder. Remove when merged: `git worktree remove ../roadmap-api-ingest`.

## Branch → PR → merge loop

```bash
git pull --rebase origin main
git checkout -b <area>/<task>
# ...agent works...
git push -u origin <area>/<task>
gh pr create --fill          # or open it on GitHub
gh pr merge --squash --delete-branch
```

Merge as soon as your area still runs. Small and often beats one big merge at 3 AM.

## Need something from someone else?

Append one line to `docs/REQUESTS.md`:

```
- [Footage → Backbone] POST /detections should accept `heading_deg` (optional)
```

Then tell them out loud. Until it lands, use `shared/fixtures/`.

## If something breaks main

Whoever notices says it in the group chat. The owner of the broken area fixes or reverts
their own PR (`gh pr revert` or `git revert <sha>`). Nobody else touches it.
