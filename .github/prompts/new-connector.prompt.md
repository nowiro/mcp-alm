---
mode: agent
description: Workflow dodania nowego konektora ALM
---

# Workflow: Nowy konektor

> Od idei "dodaj Asana" do działającego serwera MCP z testami, docs i
> wpisem CHANGELOG. Faza specify → plan → tasks → implement, ale skrojona
> dla konkretnego artefaktu (nowy konektor).

## Kiedy używać

- Nowy target ALM (Asana, Linear, ServiceNow, …).
- Nowy external system pasujący do wzorca konektora (canonical entity →
  search + get + mutate).
- Major rewrite istniejącego konektora (np. switch schema auth z PAT na
  OAuth2 — duża zmiana wymagająca ADR).

Nie używaj dla dodania pojedynczego narzędzia do istniejącego konektora —
użyj [`add-tool.prompt.md`](add-tool.prompt.md) zamiast.

## Fazy

### Faza 1 — Specify

Spisz krótki spec inline w opisie PR lub w `docs/adr/NNNN-<slug>.md`
(gdy decyzja jest nietrywialna). Zawartość:

- Problem statement — który agentic workflow to odblokowuje?
- Acceptance criteria — Given/When/Then.
- Success metrics — tokens per call, P50/P95 latency, test coverage.
- Non-goals — co jawnie nie shipujemy w tej rundzie.
- Open questions — auth scheme, rate-limit policy, plugin support
  (custom fields, …).

Done gdy: spec istnieje z zero markerów `[?]`.

### Faza 2 — Plan

Zawartość:

- Tech additions: jakiekolwiek nowe pakiety (rzadkie — mamy już `fetch`,
  `zod`, MCP SDK).
- Module taxonomy: które `src/<connector>/`, które shared moduły.
- Public surface: tool list z jednolinijkowymi descriptions. Inkluduj
  `health` i `get_usage_history`.
- Canonical entity: `CanonicalTask`, `CanonicalProject`, … z key order.
- Auth: PAT / Basic / OAuth2 (z refresh token w user-profile config).
- Rate-limit: policy + headers parsed.
- Risks + mitigations.

Done gdy: użytkownik akceptuje plan; ADR (jeśli jest) jest `accepted`.

### Faza 3 — Tasks

Typowy DAG dla nowego konektora:

```
T001  Define CanonicalTask shape
T002  Implement reshape(raw, opts)            blocked_by: T001
T003  Implement search_tasks handler          blocked_by: T002
T004  Implement get_task handler              blocked_by: T002
T005  Implement health + usage-history        blocked_by: T003, T004
T006  Register tools in server-<n>.ts         blocked_by: T005
T007  Unit tests (vi.mock fetch)              parallel_with: T003-T006
T008  Dodaj do .mcp.json + .vscode/mcp.json   blocked_by: T006
T009  CHANGELOG entry                         blocked_by: T006
T010  Security review                         blocked_by: T006, T007
```

### Faza 4 — Implement

Iteruj DAG. Po każdym task: walidacja `done_when`. Po wszystkich tasks:
uruchom `npm run verify`.

Done gdy: wszystkie taski `status: done`, validators zielone, security
review `approved`.

## Definition of Done

- `src/server-<connector>.ts` shipuje minimum: `search_*`, `get_*`,
  `health`, `get_usage_history`.
- `_meta.tokensEstimate` na każdej response (automatyczne przez factory
  MCP).
- `sessionTracker.record(...)` z każdego handlera (automatyczne przez
  factory MCP).
- ≥ 1 unit test per narzędzie.
- **Destruktywne narzędzia** (`delete_*`, `remove_*`, `drop_*`) muszą:
  - wołać `assertDestructiveAllowed(toolName, input.confirmToken)` (tier 2),
  - wykonać upstream GET, wyciągnąć human-readable name (`title` / `path` / `summary`),
  - wołać `assertResourceConfirmation(toolName, actualName, input.confirmResourceName)` (tier 3),
  - mieć test asercją oba helpery (mismatch → throws, success → passes).
  - Patrz [ADR 0006](../../docs/adr/0006-resource-name-confirmation.md).
- Dodaj wpis `bin` w `package.json` (`mcp-<connector>`).
- Dodaj wpisy w `.mcp.json` + `.vscode/mcp.json`.
- Dodaj sekcję w [`docs/reference/configuration.md`](../../docs/reference/configuration.md)
  - [`docs/how-to/configure-tokens.md`](../../docs/how-to/configure-tokens.md).
- Dodaj scope w [`commitlint.config.mjs`](../../commitlint.config.mjs).
- Wpis `CHANGELOG.md` pod `[Unreleased]` → `Added`.
- Wiersz w tabeli "Co dostajesz" w `README.md`.
- `npm run verify` zielony.
