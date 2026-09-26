# AGENTS.md

Guidance for coding agents (Codex CLI, Claude Code, …) working in this repository. Claude-Code-specific tooling is in `CLAUDE.md`.

## What this is

kimchi-claude is a Claude Code **plugin**: when the user writes in Korean, Claude answers in the register Korean developers actually use, without degrading the quality of the work. Two layers with opposite principles:

- **Always-on (tone)** — `output-styles/natural-korean.md`, force-applied into the system prompt. Generated from `rules/*.md` by `scripts/build-style.mjs`. `hooks/guard.mjs` checks artifacts (commit messages, Korean docs): tone → warn, resident registration numbers → block.
- **On-demand (knowledge)** — `skills/korean-*` (encoding, datetime, identifiers, formats) and `skills/natural-korean-writing` (the full rule table, opened for review requests). Each knowledge skill ships working code in `skills/*/examples/*.mjs`.

Node ESM, **zero dependencies**, no LLM calls in hooks or scripts. The design rationale lives in `docs/design.md` (Korean) — read the relevant section before changing a decision it records.

Talk to the user in Korean. Code comments and the design doc are Korean 한다체; README, CONTRIBUTING.md and commit messages are Korean 합니다체. Instruction files meant for models (`AGENTS.md`, `CLAUDE.md`, `.claude/`) are English.

## Commands

```bash
npm test                                   # build --check (generated files fresh) + all node:test suites, ~3s
node --test tests/particle.test.mjs        # one file
node --test --test-name-pattern='<name>' "tests/*.test.mjs"   # one test by name
npm run build                              # regenerate output-styles/natural-korean.md and the README counts block
npm run art                                # regenerate the README figures in assets/ (hook messages and lint scores are computed, not typed)
npm run score -- <file>                    # lint a response by hand
npm run eval                               # claude plugin eval — launches child claude processes, costs tokens; only when the user asks
echo '<hook json>' | node hooks/guard.mjs  # drive a hook directly with a synthetic payload
```

- After editing `rules/*.md` or `scripts/build-style.mjs`, run `npm run build`; `npm test` fails if the generated files are stale.
- `assets/*.svg` are generated too, and the hero figure's lint score covers every rule. After any change to `rules/`, hook messages, the lint/particle engine, `tests/fixtures/thin-contract-*`, or `scripts/build-readme-art.mjs`, run `npm run art` (a rule edit usually needs both `build` and `art`); `tests/readme-art.test.mjs` fails if the figures are stale.
- Commit only with `npm test` green, and never push without asking.
- CI (`.github/workflows/test.yml`) runs `npm test` on every push to `main`, `develop`, `feature/**` and on every pull request. Pushing a `v*` tag runs `.github/workflows/release.yml`, which checks that the tag and both version files agree, runs `npm test` again, and creates the GitHub Release.

## Branches and versions

- `main` holds released states only. `develop` is the integration branch. Each unit of work is a `feature/<slug>` branched from `develop` and merged back with `git merge --no-ff` (one merge commit per unit), then deleted.
- Never commit directly to `main` or `develop`. Release (`develop` → `main`) only when the user asks.
- Every unit commit bumps the version in **both** `package.json` and `.claude-plugin/plugin.json` (semver: new capability → minor, fix/doc → patch). Commit subject: `0.x.y — <합니다체 한 문장>`, e.g. `0.11.2 — 전각으로 적은 주민등록번호가 차단을 빠져나가던 구멍을 막았습니다`. The body explains *why* first (usually a measured fact: "20문장 중 3개만 잡혔습니다"), then what changed.

## Invariants (violating any is a bug)

1. **Hooks never break the user's work.** Any failure in `hooks/*.mjs` → no stdout, exit 0. The top-level `try/catch` + `process.exit(0)` stays. A hook that crashes and blocks a tool call is a worse failure than a missed check.
2. **Block only for PII.** Resident registration numbers block by default (`KIMCHI_PII`); tone only warns unless `KIMCHI_BLOCK=1`. When both fire, block wins and non-blocking warnings ride along in the same single response.
3. **The output style is generated.** Never hand-edit `output-styles/natural-korean.md` or the `<!-- kimchi:counts -->` block in README. Body ≤ `MAX_CHARS` (6000). Frontmatter keeps `force-for-plugin: true` and `keep-coding-instructions: true` (the latter keeps Claude Code's coding instructions — dropping it degrades work quality).
4. **Don't touch what isn't prose.** Code, identifiers, commands, paths, product names, log/error text, source files and code comments are never linted or rewritten. English sessions are not intervened in.
5. **If unsure, don't judge.** A wrong autofix is worse than none. The particle engine leaves words it can't pronounce alone; autofix skips when the replacement changes the final-syllable batchim and a particle follows. `치환` is only for replacements that preserve meaning everywhere; context-dependent ones are `정규식` (warn).
6. **Conservative inference.** Repo-language detection intervenes only when clearly English (≤10% Hangul, ≥3 samples); mixed/unknown → silent. The asymmetry is deliberate.
7. **Skills load or silently vanish.** `SKILL.md` frontmatter starts on line 1 (nothing before it, not even an ignore marker); every file a skill references exists; example code is exercised by `npm test`. Values that change (holiday dates, retention periods) are not hardcoded — point to the authoritative source.
8. **Dogfood.** Every Korean doc in the repo passes the repo's own linter (`tests/dogfood.test.mjs`). Deliberately quoted bad examples go inside `kimchi-ignore` markers — not the other way around.
9. **Rule data quality is product quality.** A wrong rule entry is harm, not help. New entries carry a reason; terms with legitimate uses are excluded with the reason written in the rule file.
10. Zero dependencies, Node ESM, no network or LLM calls from hooks/scripts. Hooks stay cheap — they run on every tool call (measured ~100 ms per call on Node 26, ~80 ms of it Node startup).

## Architecture

- `hooks/hooks.json` (the plugin's own hooks, shipped to users — unrelated to the dev hooks in `.claude/`): `SessionStart` → `session-language.mjs`; `PreToolUse`/`PostToolUse` on `Bash|Write|Edit|MultiEdit` → `guard.mjs`.
- `hooks/lib/`: `rules.mjs` (parse `rules/*.md` tables), `lint.mjs`, `particle.mjs` (pronunciation-based particle choice), `pii.mjs`, `artifact.mjs` (which targets to check, autofix/block/warn), `detect.mjs`, `segment.mjs`, `repo-language.mjs`.
- `rules/*.md`: markdown tables `| 원어 | 쓰지 말 것 | 쓸 것 | 이유 | 검사 | 순위 |`. `검사` ∈ `치환`/`정규식`/`프롬프트`; `순위` ∈ `핵심`/`보통`/`참고` decides what fits in the style body.
- `tests/`: `node:test`, no dependencies. `improvement.test.mjs` pins the with/without-plugin difference on preserved real answers in `tests/fixtures/`.
- `evals/`: `claude plugin eval` cases (tone vs. quality-preserved vs. english-passthrough). Needs credentials in the child process.
