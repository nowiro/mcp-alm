# Changelog

Ten plik opisuje **stan as-is** bieżącej wersji pakietu. Pełna historia zmian → `git log`.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) · [SemVer](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — `@nowiro/mcp-alm` (as-is)

Pięć serwerów MCP (stdio) dla narzędzi ALM, **read-first, write-guarded**. Klient: GitHub Copilot
(VS Code ≥ 1.121, IntelliJ ≥ 2026.1.2, Eclipse od 2026-05). Node ≥ 22, ESM, MIT.

### Serwery i narzędzia

- `mcp-jira`, `mcp-confluence`, `mcp-figma`, `mcp-sonar`, `mcp-gitlab` — ~69 narzędzi (read + write-guarded), każde z Zod I/O. `mcp-jira` pokrywa też Agile: `list_boards` / `list_sprints` / `get_sprint` / `get_sprint_issues` / `get_board_config` / `get_board_backlog`.
- Druga bramka: deterministyczne skrypty `npm run extract:{jira,confluence,gitlab,sonar}` (snapshoty z committed configu).
- MCP Resources (cheatsheety JQL / CQL / pipeline / severity / design-tokens) + response templates (LLM-agnostic).

### Bezpieczeństwo

- Tokeny **tylko** przez env / `~/.config/mcp-alm/config.json` — nigdy w repo.
- Write-guard: deny-by-default (`MCP_WRITE_ENABLED`) + allowlist + confirm-token na destrukcyjne operacje.
- SSRF guard, deep log redaction, brak telemetrii, brak memory-MCP (ADR 0008).

### Konfiguracja Copilot

- `orchestrator` (jedyny widoczny) + 7 subagentów; 9 instructions (auto per `applyTo`).
- Prompty: `/add-tool`, `/new-connector`, `/release`, `/security-review`, `/refine`.
- Skille (read-only): `pr-mr-review`, `jira-triage`, `confluence-to-spec` + lint „description = routing rule" w `ai:validate`.

### Tooling i dystrybucja

- `npm run verify` = format · lint · typecheck · test · build · ai:validate · validate:inputs. Plus `doctor`, `bootstrap`, scaffoldery `workflow:*`, `token:budget`.
- Husky: pre-commit (lint-staged) + commit-msg (commitlint). **Brak GitHub Actions** — publish ręczny (`npm publish --provenance`), verify lokalnie.
- Decyzje architektoniczne: ADR 0001–0008 (`docs/adr/`).
