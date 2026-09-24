# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Claude Code tooling in this repo

- `/temper <task>` — one unit of work on `feature/<slug>` off `develop`: `kimchi-analyst` (opus, read-only) → `kimchi-implementer` (sonnet, edits + tests, no commit) → `kimchi-reviewer` (opus, read-only) → `kimchi-tester` for runtime changes → version bump + commit → `--no-ff` merge into `develop`. Never pushes, never touches `main`.
- `kimchi-tester` (opus, no repo writes) — exercises a change for real: drives the hooks with synthetic payloads and launches headless `claude -p --plugin-dir <repo>` in a scratch repo, then reports observed behavior. `/temper` runs it for runtime changes; spawn it directly for ad-hoc checks.
- The agents in `.claude/agents/` carry the full invariant list; keep them in sync with `AGENTS.md` if an invariant changes.
- Project hooks (`.claude/settings.json`): every `.mjs`/`.js` edit is syntax-checked with `node --check` and every `.json` edit is parsed; `git commit` is blocked unless `npm test` passes. Treat a block as a bug to fix, not something to bypass.
