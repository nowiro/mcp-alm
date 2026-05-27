# SonarQube severity guide

## Skala severity

| Severity     | Działanie                        | Przykład                                                     |
| ------------ | -------------------------------- | ------------------------------------------------------------ |
| **BLOCKER**  | Fix przed merge. SLA ≤ 4h.       | NPE w hot path, SQL injection, RCE, hardcoded secret.        |
| **CRITICAL** | Fix w bieżącym sprint. SLA ≤ 5d. | Memory leak, broken auth flow, unsafe deserialization.       |
| **MAJOR**    | Backlog, fix w 30 dni.           | Cyclomatic complexity > 15, duplicate code block > 50 lines. |
| **MINOR**    | Cleanup. Fix gdy touchasz plik.  | Unused variable, inconsistent naming, missing JSDoc.         |
| **INFO**     | Awareness. Tylko gdy łatwo.      | Magic number bez const, long parameter list.                 |

## Triage flow

1. Otwórz `sonar.quality_gate({ project: <key> })` — czy QG jest pass / warn / error?
2. Jeśli error: `sonar.list_issues({ project, statuses: ["OPEN","REOPENED"], severities: ["BLOCKER","CRITICAL"] })` — krótka lista.
3. Per issue: `sonar.get_hotspot({ key })` (dla security) lub szczegóły z `list_issues` payload.
4. Plan fixu: filed jako PR z scope = jeden file lub jedna rule (nie "fix all sonar").

## Quality gate — common conditions

```
new_coverage              ≥ 80%
new_duplicated_lines      ≤ 3%
new_maintainability       A
new_reliability           A
new_security              A
new_security_hotspots_reviewed = 100%
```

`sonar.get_quality_gate_diff({ project, target_branch: "main" })` porównuje feature branch vs main — pokazuje **tylko nowe** issues wprowadzone przez branch.

## Rules po typie

| Typ                | Co skanuje                                            |
| ------------------ | ----------------------------------------------------- |
| `bug`              | Logic errors, NPE, type mismatches.                   |
| `vulnerability`    | Security: injection, weak crypto, hardcoded secrets.  |
| `code_smell`       | Maintainability: dead code, complexity, naming.       |
| `security_hotspot` | Code który WYMAGA review (nie zawsze bug, ale risky). |

Hotspots ≠ issues. Każdy hotspot wymaga **manual review verdict** (`safe` / `at-risk` / `fixed`). `sonar.list_hotspots` zwraca tylko `to-review`.

## Anti-patterns

- ❌ "Fix all sonar findings w jednym PR" — review staje się nie-przeprowadzalny.
- ❌ Mute rule globally bez ADR — sygnał że rule jest źle skonfigurowana, nie że findings są mylne.
- ❌ Score 100% bez patrzenia na coverage — coverage 100% z `expect(true).toBe(true)` to security theater.
- ✅ Per-PR check: zero new BLOCKER/CRITICAL, coverage ≥ 80% na touched files.

## Common patterns

```ts
// QG diff for current branch
sonar.get_quality_gate_diff({ project: 'my-service', target_branch: 'main' });

// New issues since main fork
sonar.list_issues({ project: 'my-service', branch: 'feature/xyz', inNewCodePeriod: true });

// All BLOCKERs across org
sonar.list_issues({ severities: ['BLOCKER'], statuses: ['OPEN'], limit: 100 });

// Hotspots needing review
sonar.list_hotspots({ project: 'my-service', status: 'TO_REVIEW' });
```
