---
mode: agent
description: Uruchom release flow — bump wersji, regeneracja CHANGELOG, publish
tools: ['editFiles', 'search', 'runCommands', 'runTasks', 'problems']
---

# Release

Uruchamia release workflow dla mcp-alm.

## Inputs

- `${input:notes:Optional release-notes one-liner}` — krótkie description dla CHANGELOG headline

## Co robić

1. Pre-flight gate (odmów on red):
   - `npm run verify` (format + lint + typecheck + test + build + ai-validate)
   - `npm run audit:prod`
   - Working tree clean (`git status --porcelain` jest empty)
   - Aktualny branch to `main`
2. Określ version bump z Conventional Commits od ostatniego tagu:
   - `feat` → minor, `fix`/`perf` → patch, `feat!` lub `BREAKING CHANGE:` → major.
3. Regeneruj `CHANGELOG.md` z commitów (`conventional-changelog` lub równoważne). Wstaw opcjonalną linię `${notes}` pod nową version header.
4. Update `package.json` version.
5. Commit `chore(release): vX.Y.Z` (Conventional Commits, no `[skip ci]`).
6. Tag `vX.Y.Z` (annotated).
7. Push commita i tag. Publish workflow handluje resztę.
8. End-of-turn: blok `done:` z nową wersją i link do release page.

## Nie

- Bypassuj verify gate.
- Force-push release brancha.
- Dodawaj unrelated zmiany do release commita.
