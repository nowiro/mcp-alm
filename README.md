# mcp-alm

[![role](https://img.shields.io/badge/role-MCP%20servers-blue)](#)
[![ide](https://img.shields.io/badge/IDE-VS%20Code%201.121%2B%20%C2%B7%20IntelliJ%202026.1.2%2B-2da44e)](#konfiguracja-ide)
[![ai](https://img.shields.io/badge/AI-GitHub%20Copilot-2da44e)](#)
[![os](https://img.shields.io/badge/OS-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-blue)](#)
[![license](https://img.shields.io/badge/license-MIT-lightgrey)](LICENSE)

Pięć serwerów MCP — **read-first, write-guarded** — które wystawiają Twoje
osobiste tokeny API do Jira, Confluence, Figma, SonarQube i GitLab jako
narzędzia (`tools`) odkrywalne dla dowolnego klienta MCP. Projekt celuje w
**GitHub Copilot** w **VS Code ≥ 1.121** oraz **IntelliJ IDEA ≥ 2026.1.2**,
ale jest zgodny ze specyfikacją [Model Context
Protocol](https://modelcontextprotocol.io), więc każdy zgodny host (Claude
Desktop, Cursor, własny agent) też działa.

## Po co to istnieje

Narzędzia ALM (Jira, GitLab, …) to miejsce, gdzie naprawdę dzieje się praca
— ale każdy pomocnik po stronie modelu, który ma własną integrację, kończy z
innym zakresem uprawnień, inną postawą bezpieczeństwa i innym rachunkiem.
**mcp-alm** przenosi integrację do najmniejszego możliwego miejsca: jeden
proces stdio na narzędzie, działający na Twojej maszynie, używający **Twoich**
tokenów, z **deny-by-default** dla zapisów i pełnym, audytowalnym śladem
żądań.

## Co dostajesz

| Serwer           | Narzędzia odczytu                                                                                                                                                                                | Narzędzia zapisu (opt-in, bramkowane)                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `mcp-jira`       | `get_issue`, `search_issues`, `bulk_get_issues`, `approximate_count`, `list_projects`, `list_transitions`, `get_comments`, `get_worklogs`, `get_changelog`, `jql_builder`, `health`              | `create_issue`, `bulk_create_issues`, `transition_issue`, `add_comment`, `add_worklog`, `link_issues` |
| `mcp-confluence` | `get_page`, `search_pages`, `search_pages_by_label`, `list_spaces`, `list_children`, `list_ancestors`, `get_attachments`, `get_comments`, `health`                                               | `add_comment`, `create_page`, `update_page`, `attach_file`                                            |
| `mcp-figma`      | `get_file`, `get_file_nodes`, `get_image_urls`, `get_comments`, `list_team_projects`, `list_project_files`, `get_team_components`, `get_team_styles`, `export_tokens`, `health`                  | (REST Figmy jest read-only)                                                                           |
| `mcp-sonar`      | `quality_gate`, `get_quality_gate_diff`, `list_issues`, `list_hotspots`, `get_hotspot`, `list_projects`, `measures`, `health`                                                                    | (read-only z polityki)                                                                                |
| `mcp-gitlab`     | `get_mr`, `list_mrs`, `list_issues`, `list_pipelines`, `get_pipeline_jobs`, `get_job_log`, `merge_request_changes`, `get_artifacts`, `get_commit`, `list_branches`, `get_file_content`, `health` | `create_issue`, `create_mr`, `merge_mr`                                                               |

Każdy serwer wystawia też `<server>.get_usage_history` — in-memory ledger
wywołań narzędzi (rozmiary input / output, latencja, estymata tokenów), żeby
można było rozumieć koszt bez zewnętrznego stosu observability.

## Postawa bezpieczeństwa — w skrócie

- **Tokeny nigdy nie żyją w repo.** Czytane przy każdym wywołaniu z `~/.config/mcp-alm/config.json` (lub z env vars). Ostrzeżenie o trybie pliku jeśli nie jest `0600` na POSIX.
- **Narzędzia zapisu są deny-by-default.** Dwupoziomowy guard: `MCP_WRITE_ENABLED=true` + `MCP_WRITE_ALLOWLIST=<dokładna.nazwa.narzędzia>` dla mutacji; operacje destruktywne wymagają dodatkowego `MCP_DESTRUCTIVE_ALLOWLIST` + porównywanego w stałym czasie `confirmToken` ≥ 16 znaków.
- **SSRF guard** blokuje loopback / RFC1918 / link-local hosts, chyba że ustawione `MCP_ALM_ALLOW_PRIVATE_HOSTS=true` (potrzebne dla self-hosted Jira / GitLab Data Center).
- **Korporacyjne proxy + prywatne CA** wbudowane: `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` honorowane natywnie; `NODE_EXTRA_CA_CERTS` dla self-signed bundles. `MCP_ALM_DISABLE_PROXY=true` wyłącza proxy per-proces.
- **Redakcja w logach** wartości pod kluczami `authorization`, `*-token`, `*-key`, `password`, `secret` na dowolnej głębokości — defense in depth ponad tym, że logger w ogóle nie dostaje nagłówka auth.
- **Identyfikujące nagłówki wychodzące.** Każde żądanie do upstream niesie `User-Agent: mcp-<server>/<version>`, `X-MCP-Server`, `X-MCP-Version`, `X-MCP-Tool`, `X-Request-ID` — Twoje dashboardy rate-limit i audit log mogą przypisać ruch do konkretnego wywołania MCP.
- **Bez memory MCP, bez internet-docs MCP, bez telemetrii.** `.mcp.json` w repo rejestruje wyłącznie pięć konektorów. Nic poza tym.

Pełna polityka żyje w [SECURITY.md](SECURITY.md) oraz [docs/explanation/security-architecture.md](docs/explanation/security-architecture.md).

## Quickstart (5 minut)

```sh
git clone https://github.com/nowiro/mcp-alm.git
cd mcp-alm
npm install
npm run bootstrap                        # zasiewa ~/.config/mcp-alm/config.json (0600 na POSIX)
$EDITOR ~/.config/mcp-alm/config.json    # wklej swoje tokeny; usuń sekcje, których nie używasz
npm run build
npm run doctor                           # waliduje config + sprawdza dostęp do każdego baseUrl
```

Następnie podłącz serwery w IDE — patrz [Konfiguracja IDE](#konfiguracja-ide) niżej.

## Konfiguracja IDE

### Visual Studio Code ≥ 1.121

Repo ma już [`.vscode/mcp.json`](.vscode/mcp.json). Otwórz projekt w VS
Code, **Copilot Chat → MCP: List Servers → Reload**, zaakceptuj prompt
zaufania dla każdego serwera. Pięć serwerów `alm-*` pojawia się w tool
pickerze.

Szczegółowy przewodnik (per-tool approval, write-guard env wiring,
troubleshooting): [docs/getting-started/vscode-setup.md](docs/getting-started/vscode-setup.md).

### IntelliJ IDEA ≥ 2026.1.2

Repo ma [`.idea/mcp-servers.example.xml`](.idea/mcp-servers.example.xml).
Otwórz Settings → Tools → AI Assistant → Model Context Protocol → **Import
from file…**, wskaż przykład, zamień `/absolute/path/to/mcp-alm` na realną
ścieżkę, **Apply**. Serwery pojawiają się w AI Assistant tool pickerze (i w
GitHub Copilot, jeśli używasz pluginu).

Szczegółowy przewodnik: [docs/getting-started/intellij-setup.md](docs/getting-started/intellij-setup.md).

### Inne hosty MCP

Claude Desktop, Cursor i każdy inny host czytający mapę `mcpServers`: wklej
odpowiedni blok z [`.mcp.json`](.mcp.json) do konfiguracji hosta i go
zrestartuj.

## Intranet korporacyjny / środowiska air-gapped

mcp-alm jest zbudowany tak, aby działać w restrykcyjnej sieci korporacyjnej
bez modyfikacji. Patrz [docs/getting-started/enterprise-intranet.md](docs/getting-started/enterprise-intranet.md)
po:

- przepisy na proxy korporacyjne (`HTTPS_PROXY` / `NO_PROXY`),
- prywatne CA bundle (`NODE_EXTRA_CA_CERTS`) — w tym jak sprawdzić, że
  zostało załadowane przez `npm run doctor`,
- instalacja air-gapped (`npm ci --offline` przeciw lokalnemu mirrorowi
  rejestru),
- rekomendowane wiring DLP i trwałego audit-trail dla branż regulowanych,
- dlaczego domyślny `.mcp.json` NIE zawiera memory MCP ani serwerów
  internetowych — i jak je świadomie włączyć, jeśli polityka pozwala.

## Codzienne komendy

```sh
npm run build               # tsc -p tsconfig.json
npm test                    # vitest run
npm run test:cov            # z coverage
npm run lint                # eslint . --max-warnings=0
npm run typecheck           # tsc --noEmit
npm run format              # prettier --write
npm run doctor              # config + zdrowie konektorów
npm run audit:prod          # audyt prod-deps, high severity
npm run verify              # format:check + lint + typecheck + test + build + ai:validate
npm run extract:jira        # deterministyczny snapshot Jira → output/jira/ (patrz docs/how-to/data-extraction.md)
npm run extract:confluence  # to samo dla Confluence (page / tree / label)
npm run extract:gitlab      # GitLab (issues / mrs / pipelines)
npm run extract:sonar       # SonarQube (quality_gate / issues / hotspots / measures)
```

## Dwie bramki do tej samej warstwy ekstrakcji

| Bramka                                       | Charakterystyka                | Use case                                                        |
| -------------------------------------------- | ------------------------------ | --------------------------------------------------------------- |
| **MCP stdio** (`mcp-jira`, `mcp-confluence`) | Interactive, agent decyduje    | Eksploracja, code review, ad-hoc query w środku rozmowy         |
| **Skrypty `extract-*.ts`**                   | Non-interactive, config-driven | Snapshot, compliance audit, eval-sety, reproducible bug reports |

Obie dzielą 100% kodu reshape — gdy poprawisz projekcję pola dla MCP,
propaguje się do snapshotów też. Szczegóły:
[`docs/how-to/data-extraction.md`](docs/how-to/data-extraction.md).

## Architektura w jednym akapicie

Każdy `src/server-<tool>.ts` to samodzielny binarny ESM Node 22, mówiący
JSON-RPC przez stdio (transport MCP). Narzędzia są deklarowane przez
schematy Zod, automatycznie konwertowane do JSON Schema dla `tools/list`.
Wspólna warstwa `src/shared/` posiada: uwierzytelnianie
([`auth.ts`](src/shared/auth.ts), [`user-config.ts`](src/shared/user-config.ts)),
klient HTTP z SSRF guard / proxy / retries / ETag / dedup
([`http-client.ts`](src/shared/http-client.ts)), dwupoziomowy write-guard
([`write-guard.ts`](src/shared/write-guard.ts)), shaping kosztu tokenów
([`extract.ts`](src/shared/extract.ts), [`budget.ts`](src/shared/budget.ts))
i fabrykę MCP która to wszystko zszywa ([`mcp-server.ts`](src/shared/mcp-server.ts)).
Mermaid w [docs/explanation/architecture.md](docs/explanation/architecture.md).

## Layout projektu

```
src/
  server-{jira,confluence,figma,sonar,gitlab}.ts   # jeden serwer MCP per konektor
  shared/                                          # HTTP, auth, write-guard, pipeline ekstrakcji
tools/scripts/                                     # bootstrap, doctor, validate-ai-config
docs/                                              # dokumentacja w stylu Diátaxis
  getting-started/                                 # quickstart, vscode-setup, intellij-setup, enterprise-intranet
  how-to/                                          # configure-tokens, add-connector, deploy
  reference/                                       # configuration, error-codes
  explanation/                                     # architecture, security-architecture, write-guard
  adr/                                             # Architecture Decision Records
.vscode/mcp.json                                   # natywna rejestracja MCP dla VS Code
.idea/mcp-servers.example.xml                      # szablon importu dla IntelliJ AI Assistant
.github/workflows/                                 # CI: lint, typecheck, test, build, audit, secret-scan
```

## Dokumentacja

- Pierwszy raz? → [docs/getting-started/quickstart.md](docs/getting-started/quickstart.md)
- Tokeny → [docs/how-to/configure-tokens.md](docs/how-to/configure-tokens.md)
- Każda env-var → [docs/reference/configuration.md](docs/reference/configuration.md)
- Wiring w VS Code → [docs/getting-started/vscode-setup.md](docs/getting-started/vscode-setup.md)
- Wiring w IntelliJ → [docs/getting-started/intellij-setup.md](docs/getting-started/intellij-setup.md)
- Za firewallem korporacyjnym → [docs/getting-started/enterprise-intranet.md](docs/getting-started/enterprise-intranet.md)
- Dodanie konektora → [docs/how-to/add-connector.md](docs/how-to/add-connector.md)

## Kompatybilność

| Komponent      | Minimum przetestowane        | Uwagi                                                                           |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| Node.js        | 22.0.0                       | Natywne `fetch`, `AbortSignal.any`, `crypto.timingSafeEqual` — wszystko od 22+. |
| npm            | 10.0.0                       | Dostarczany z Node 22. `package-lock.json` jest committed.                      |
| VS Code        | 1.121                        | Natywne wsparcie MCP (od 1.99) z UI per-tool approval.                          |
| IntelliJ IDEA  | 2026.1.2                     | AI Assistant + plugin GitHub Copilot — oba wspierają MCP od tej wersji.         |
| GitHub Copilot | najnowszy (2026-05+)         | Chat + slash commands + MCP tool calling.                                       |
| API Atlassiana | Jira Cloud + Data Center 9.x | `search/jql` cursor pagination (post-2025-05).                                  |
| API GitLaba    | 16.x+ (self-hosted) i SaaS   | tylko `/api/v4`.                                                                |

## Bezpieczeństwo

Jeśli wykryjesz podatność, **nie** otwieraj publicznego issue. Postępuj
zgodnie z private disclosure flow w [SECURITY.md](SECURITY.md).
