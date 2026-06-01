---
mode: agent
description: Dodaj jedno narzędzie do ISTNIEJĄCEGO connectora mcp-alm (jira/confluence/figma/sonar/gitlab) — generuje snippet defineTool, ≤3 pliki, bez spec. Użyj gdy connector już istnieje; nowy connector → /new-connector.
---

# Workflow: Dodaj narzędzie

> Ścisły, single-iteration flow dla dodania **jednego** narzędzia do istniejącego connectora. Bez spec, bez plan markdown — tylko mały łańcuch delegacji. Używaj gdy zmiana dotyka jednego connectora i ≤ 3 plików.

## Kiedy używać

- Connector istnieje; potrzebujesz jednego więcej read lub jednego więcej write toola.
- Tool pasuje do istniejącego canonical shape — bez nowego entity.

Nie używaj dla nowych konektorów (`/new-connector`) ani dla cross-cutting
zmian (potrzebny ADR + pełny review).

## Fazy

### Faza 1 — Scaffold

Orchestrator deleguje do **connector-author** z:

- `connector` — `jira` / `confluence` / `github` / `gitlab` / `figma` / `sonar`.
- `tool-name` — snake_case.
- One-line description (English; idzie do Zod `.describe()` i tabeli README).
- Read / write — wpływa, czy `assertWriteAllowed(...)` i `dryRun` są wymagane.

Output:

- `src/<connector>/tools/<tool-name>.ts` — handler.
- Edytuj `src/server-<connector>.ts` — register the tool.

### Faza 2 — Test

Orchestrator deleguje do **test-engineer** równolegle z Fazą 1 (test-engineer pisze test bazując na schemie, author pisze handler).

Output:

- `src/<connector>/tools/<tool-name>.spec.ts` — minimum: happy path, 4xx, 5xx, i (dla writes) `dryRun: true` + write-guard denial.

### Faza 3 — Docs

Orchestrator deleguje do **doc-writer**.

Output:

- Row tabeli README "Tools".
- CHANGELOG `[Unreleased]` → `Added` entry (styl Conventional Commits).
- (Opcjonalnie) `docs/projects/<connector>/technical.md` zaktualizowany jeśli nowe narzędzie zmienia sekcję tool inventory.

### Faza 4 — Security review

Tylko dla writes: **security-auditor** potwierdza write-guard wiring, dry-run default, i że żaden token nie leakuje do nowej code path.

Dla reads: pomiń chyba że nowe narzędzie fetchuje user-supplied paths (path-traversal class).

## Definition of Done

- Handler shipuje.
- Test pokrywa happy + 4xx + 5xx + (dla writes) dry-run + denial.
- Tabela README "Tools" zaktualizowana.
- CHANGELOG entry pod `[Unreleased]` → `Added`.
- `npm run typecheck`, `npm test`, `npm run ai:validate` zielone.

## Anti-patterns

- Nie shipuj toola bez testu — connector-author odmawia delegacji bez planu testu.
- Nie bundluj dwóch nowych tools w jednym PR — każdy dostaje swój commit nawet gdy shipują razem.
- Nie sięgaj po nowy shared utility tylko dla jednego toola — skopiuj kilka linii najpierw; refactor na trzecim wystąpieniu.
