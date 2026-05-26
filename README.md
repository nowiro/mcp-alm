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

## Agenci Copilot — kiedy i jak używać

Repo wprowadza **pięć custom agents** w [`.github/agents/`](.github/agents/), które Copilot wykrywa automatycznie w VS Code (≥ 1.121) jako custom chat modes do wyboru z dropdownu nad polem czatu. Każdy agent ma wąską specjalizację — wybierz pasującego do typu zadania.

| Agent                                                                  | Kiedy używać                                                                                 | Przykładowy prompt                                                                                                                      |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [`orchestrator`](.github/agents/orchestrator.agent.md)                 | Wieloetapowe zadania, plan-first, koordynacja innych specjalistów                            | "Zaplanuj migrację Jira PAT → OAuth2 we wszystkich connectorach"                                                                        |
| [`connector-author`](.github/agents/connector-author.agent.md)         | Implementacja / refactor konektora (jira, confluence, figma, sonar, gitlab)                  | "Dodaj `jira.get_sprint` z parametrami `boardId`, `state`, zwraca canonical sprint shape"                                               |
| [`epic-strategist`](.github/agents/epic-strategist.agent.md)           | Jira epic breakdown na stories per INVEST, dependency mapping, sprint cuts                   | "Rozbij epic PROJ-100 na stories per INVEST, oszacuj T-shirt sizes, zaproponuj cut na 3 sprinty"                                        |
| [`confluence-architect`](.github/agents/confluence-architect.agent.md) | Information architecture dla Confluence space, page templates, hierarchy plans               | "Audyt space ENG i zaproponuj target tree z lifecycle markers + migration plan z rollback"                                              |
| [`token-tuner`](.github/agents/token-tuner.agent.md)                   | Audyt P50/P95 zużycia tokenów per tool, rekomendacje `budgetTokens` / `fields` / `maxChars`  | "Pull session-tracker dla każdego serwera, policz P95, zaproponuj nowe defaulty w osobnym PR (nie w tym samym co audit)"                |
| [`template-author`](.github/agents/template-author.agent.md)           | Owns `templates/responses/` — LLM-agnostic output shape + semver bumps przy breaking changes | "Dodaj template `jira-changelog` (changelog entries z timestamps i actorami), bumpnij confluence-page do v1.1 z attachments thumbnails" |
| [`test-engineer`](.github/agents/test-engineer.agent.md)               | Coverage ≥ 80%, msw mocks, integration testy gated by sandbox tokens, pin error contract     | "Dodaj testy dla `jira.bulk_create_issues`: happy path z 5 issues, 4xx partial fail (3/5 created), 5xx, dry-run, write-guard denial"    |
| [`dependency-curator`](.github/agents/dependency-curator.agent.md)     | Każda nowa npm dep wymaga ADR, audit prod-deps, lockfile hygiene, supply-chain guard         | "Czy `p-queue` jest sensowną alternatywą do własnego rate-limitera dla jira-client? Napisz ADR z transitive size + license check"       |

**Workflow w VS Code:**

1. Otwórz Copilot Chat (`Ctrl+Alt+I` lub `Cmd+Ctrl+I`).
2. Z dropdownu trybu chatu (góra okna) wybierz np. `connector-author`.
3. Wpisz zadanie — Copilot załaduje plik `.github/agents/<name>.agent.md` jako system prompt i odpowie zgodnie z workflow specjalisty.
4. Pozostałe hosty MCP (Claude Desktop, Cursor, własny SDK) czytają agents jako fallback w `AGENTS.md` + `.github/copilot-instructions.md`.

## Workflow scripts — deterministic scaffolders

Dla najczęściej powtarzanych workflow z `.github/prompts/` repo dostarcza **deterministic scaffolders** w `tools/scripts/workflow-*.mjs`. Skrypty tworzą strukturę (folders, frontmatter, snippety, plan markdown) zanim Copilot zacznie pracować — agent dostaje gotowy szkielet zamiast wymyślać shape. Oszczędność tokenów + reproducible output niezależnie od modelu LLM.

```sh
# Dodaj jeden tool do istniejącego connectora
npm run workflow:add-tool -- \
  --connector=jira \
  --tool=get_sprint \
  --description="Fetch sprint metadata and issue summary." \
  --type=read
# → docs/runs/<date>-add-tool-jira-get_sprint.md
#   z gotowym Zod snippet + defineTool block + CHANGELOG entry + README row.
#   Następnie connector-author agent wkleja snippet do src/server-jira.ts.

# Nowy ALM connector od zera
npm run workflow:new-connector -- \
  --name=asana \
  --base-url=https://app.asana.com/api/1.0 \
  --auth=pat
# → docs/specs/asana/spec.md, docs/specs/asana/plan.md (design),
#   src/server-asana.ts (stub), docs/plans/<date>-new-connector-asana.md.
#   Następnie analyst → architect → connector-author wypełniają TODO/[?].
```

## Response templates — LLM-agnostic outputs

Tool handlery renderują payload przez `src/shared/response-template.ts` z markdown+frontmatter templates pod `templates/responses/`. Cel: **identyczna struktura odpowiedzi niezależnie od modelu LLM** który ją czyta (Claude / GPT / Gemini behind Copilot).

```sh
npm run template:list
# → jira-issue, confluence-page, gitlab-mr, sonar-issue, error

npm run template:render -- --name=jira-issue --vars=tests/fixtures/jira-issue.json
# → renderuje template z fixture data, podgląd markdown wyjścia
```

W tool handler:

```ts
import { templateResponse } from '../shared/response-template.js';

return templateResponse(
  'jira-issue',
  { key: 'PROJ-123', summary: '...', status: '...', comments: [...] },
  { correlationId, server: 'mcp-jira', tool: 'jira.get_issue' },
);
// → ToolResponse<string> z markdown payload + _meta envelope (tokensEstimate, durationMs)
```

Każdy template ma `version:` w frontmatter — bump przy breaking shape changes (semver minor = compatible, major = breaking).

## Deterministyczne audyty (validate + token-budget)

Dwa skrypty static-only które pilnują kontraktu narzędzi przed mergem:

```sh
npm run validate:inputs
# → static check defineTool({...}) w każdym src/server-*.ts:
#   name z prefixem servera, description literal, inputSchema (named ref), handle method.
#   Wpięte w npm run verify — drift kontraktu blokuje commit.
#   Obecny stan: 63/63 tools clean.

npm run token:budget
# → scan Zod limits (.min/.max/.default) w server/extract files,
#   porównanie z baseline z llm-optimization.instructions.md,
#   raport docs/runs/<date>-token-budget.md z recommendations
#   (review-high-max, add-default).
#   Manualny audit — akcje delegowane do connector-author w osobnym PR.
```

## Przykłady narzędzi MCP (jak Copilot z nich korzysta)

Z poziomu Copilot Chat (przy aktywnym `mcp-jira` z `.vscode/mcp.json`):

```text
> Pobierz Jira PROJ-123 z komentarzami i changelog
# Copilot → jira.get_issue({ key: 'PROJ-123', include_comments: true, include_changelog: true })
# Odpowiedź: ToolResponse z canonical issue shape + Markdown description + comments table.

> Szukaj otwartych bugów assigned to me w projektach PROJ, OPS, INFRA
# Copilot → jira.search_issues({ jql: 'assignee = currentUser() AND status != Done AND project IN (PROJ,OPS,INFRA)', fields: ['summary','priority','status'] })

> Pokaż page Confluence "Onboarding" w space ENG (z attachments)
# Copilot → confluence.get_page({ space_key: 'ENG', title: 'Onboarding', include_attachments: true })

> Lista MR w gitlab "myorg/api" z labelem "ready-for-review"
# Copilot → gitlab.list_mrs({ project: 'myorg/api', labels: ['ready-for-review'], state: 'opened' })

> Quality gate dla projektu Sonar "my-service" z porównaniem do main
# Copilot → sonar.get_quality_gate_diff({ project: 'my-service', target_branch: 'main' })

> Komponenty frame X w Figma file "designsys"
# Copilot → figma.get_file({ key: '<file-key>', node_ids: ['<frame-id>'] })
```

Pełna tabela narzędzi z parametrami: `docs/reference/tools.md` (generowana przez `npm run docs:tools`).

**Write tools** są gated przez `MCP_WRITE_ENABLED=true` env i wrappują `assertWriteAllowed(toolName)` — patrz [`docs/how-to/enable-writes.md`](docs/how-to/enable-writes.md).

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
