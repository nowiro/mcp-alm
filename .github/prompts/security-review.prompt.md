---
mode: agent
description: Defensive security audit konektora — SSRF, write-guard, token leakage, ADF/CQL/JQL injection
tools: ['editFiles', 'search', 'runCommands', 'runTasks', 'problems']
---

# Security review

Inspirowane Copilot CLI `/security-review` slash command. Defensive audyt
pojedynczego konektora MCP w mcp-alm pod kątem typowych klas vulnerabilities.

## Scope

Wybierz **jeden** konektor (lub plik) — audyt szerszego scope rozdziela ostrożność.

- `connector` (string, required): jedna z `jira`, `confluence`, `figma`, `sonar`, `gitlab`
- `focus` (string, optional): `read-tools`, `write-tools`, `extract-pipeline`, `auth`, `http-client`, `all` (default)

## Workflow

### 1. Wytyp powierzchnię ataku

Otwórz `src/server-<connector>.ts` + `src/shared/<connector>-*.ts` + `src/extract-<connector>.ts` (jeśli istnieje). Wylistuj:

- Wszystkie narzędzia (read / write / destructive).
- Wszystkie metody konektora wywołujące `http.request(...)`.
- Wszystkie `extract.config.*.json` keys które wpływają na request shape.

### 2. SSRF audit

Reguły z [`security-architecture.md`](../../docs/explanation/security-architecture.md):

- `http-client.ts` blokuje loopback / RFC1918 / link-local hosts unless `MCP_ALM_ALLOW_PRIVATE_HOSTS=true`.
- Per-narzędzie sprawdź: czy `baseUrl` jest jedynym kanałem upstream — czy gdziekolwiek user-input (issue id, page id, project key) trafia do _scheme_ albo _host_ części URL? Path injection (`/issues/../../admin`) jest blokowane przez encode'er — ale zweryfikuj.
- Czy `Authorization` header może wyciec do alternative host w redirect chain? Sprawdź `follow` settings w `http.request`.

### 3. Write-guard tier audit

Per narzędzie write/destructive:

- Pierwsza instrukcja w `handle()` MUSI być `assertWriteAllowed(toolName)`.
- Destruktywne narzędzia (`delete_*`, `drop_*`, `remove_*`) muszą wołać:
  - `assertDestructiveAllowed(toolName, input.confirmToken)` — confirm token compare w stałym czasie.
  - `assertResourceConfirmation(toolName, fetchedName, input.confirmResourceName)` — case-sensitive exact match z upstream'em.
- Czy allowlist enforcement jest **per-tool**, a nie **per-server**? Pusta allowlist = deny.

### 4. Token leakage audit

- `console.log` do **stdout** w pliku serwera → fatal (uszkadza ramkę MCP, ale też leak'uje do hosta).
- `logger.log(...)` z fragmentem tokena (np. `Bearer ${token.slice(0, 6)}`) → reject, redactor w logger powinien to złapać, ale defence-in-depth.
- Error messages: czy `error.message` zawiera fragment tokena (np. axios-style)? `http-client.ts` redaktuje header, ale upstream może wrzucić token do body 4xx.
- Token w outbound `User-Agent` / custom headers — sprawdź.

### 5. Query language injection (JQL / CQL)

- JQL/CQL ma własną składnię. `jql-builder.ts` używa parametric escape — ale jeśli narzędzie buduje query stringiem (`` `assignee = ${user}` ``), audytuj escape ANSI / quotes / parenthesis.
- Sprawdź: czy `user.input.field` może wstrzyknąć `ORDER BY` lub `AND project = ANOTHER` żeby exfiltrować dane spoza scope?
- Confluence CQL: identyczne pytanie dla space scoping (`space = "PROJ"` vs `space IN ("PROJ", "SECRET")`).

### 6. ADF / Markdown rendering injection

Confluence + Jira renderują markdown jako ADF. Hardcore vector: user wkleja markdown link `[click](javascript:...)` lub `<script>` w body. `adf.ts` powinien stripować dangerous nodes, ale:

- Sprawdź czy `adfToMarkdown` nie reverses sanitization (np. tworzy raw HTML z `code` nodes).
- Czy `customfield_NNNNN` resolution może wstrzyknąć kontrolowany przez user'a field name do response shape? Field registry lookup powinien być whitelist'em, nie passthrough'em.

### 7. Output verification

Po review, emituj:

```yaml
security_review:
  connector: <name>
  scope: <focus>
  findings:
    - severity: high | medium | low
      class: ssrf | write-guard | token-leak | injection | adf | other
      file: src/...:LINE
      issue: <one-liner>
      remediation: <konkretny diff suggestion>
  clean_areas: # gdzie audit nic nie znalazł
    - <area>
  next_steps:
    - <task dla user'a (np. dodaj test do sandbox-redirect)>
```

## Sukces

`security-review` jest done gdy:

1. Każda klasa z #2-#6 ma explicit verdict (clean / N findings).
2. Każde finding ma file:line + konkretną remediation (nie "consider validating input" — _what_ validation, _where_).
3. Output blok w YAML jak wyżej.

## Co NIE robi

- **Nie wprowadza zmian** w kodzie. To audit, nie fix.
- **Nie audytuje upstream APIs** (Jira, GitLab itd.). Zaufanie kończy się na `http-client.ts` body cap.
- **Nie testuje exploitów na żywym systemie.** Static analysis only.

## Cross-check

Po `/security-review`:

- Otwórz [`.github/agents/connector-author.agent.md`](../agents/connector-author.agent.md) jeśli findings wymagają zmian kodu.
- [`docs/explanation/security-architecture.md`](../../docs/explanation/security-architecture.md) — pełna polityka.
- [`docs/explanation/write-guard.md`](../../docs/explanation/write-guard.md) — tier 1/2/3 spec.
