# AGENTS.md — agenci pracujący w tym repo

> Format zgodny z konwencją [AGENTS.md](https://agents.md): zwykły Markdown,
> który dowolny AI coding assistant przeczyta na początku sesji. Ten plik
> jest **cienkim wskaźnikiem** — pełen rulebook żyje w
> [`.github/copilot-instructions.md`](.github/copilot-instructions.md) i
> [`.github/instructions/`](.github/instructions/).

## Tożsamość

Pracujesz wewnątrz **mcp-alm** — projektu TypeScript / Node 22, który shipuje **pięć** serwerów MCP (Model Context Protocol), jeden per integracja ALM:

- `mcp-jira` — Jira Cloud + Data Center
- `mcp-confluence` — Confluence Cloud + Data Center
- `mcp-figma` — Figma (read-only)
- `mcp-sonar` — SonarQube / SonarCloud
- `mcp-gitlab` — GitLab SaaS + self-hosted

Główny klient: **GitHub Copilot** w **VS Code ≥ 1.121** i **IntelliJ IDEA ≥ 2026.1.2**. Inne MCP-zgodne hosty (Claude Desktop, Cursor, własny Agent SDK) też działają — nie wstawiaj założeń IDE-specific do runtime'u.

**Cross-platform**: działa na Windows i macOS/Linux identycznie. User-profile config żyje w `<home>/.config/mcp-alm/config.json` gdzie `<home>` to `%USERPROFILE%` na Windows i `$HOME` na POSIX (`os.homedir()`).

## Reguły, których każdy agent musi przestrzegać

Pełen rulebook → [`.github/copilot-instructions.md`](.github/copilot-instructions.md). Skrót dla agentów które nie czytają Copilot-specific plików:

1. **Czytaj zanim ogłosisz, że wiesz.** Otwórz plik. Nie zgaduj.
2. **Najmniejsza rozsądna zmiana.** Bez drive-by refactorów.
3. **Nigdy nie loguj tokena, nigdy go nie commituj, nigdy nie pisz `console.log` do stdout** z pliku serwera (stdout to ramka MCP).
4. **Tylko natywny `fetch`.** Bez `axios`. Wrapper HTTP w [`src/shared/http-client.ts`](src/shared/http-client.ts) jest nienegocjowalny.
5. **Zod wszędzie** na granicach narzędzi. Brak `any` w input/output.
6. **Narzędzia zapisu wołają `assertWriteAllowed`** zanim wystrzelą żądanie upstream.
7. **Definition of Done** przed ogłoszeniem sukcesu: `npm run verify` (format + lint + typecheck + test + build + ai:validate).
8. **Conventional Commits** dla każdego commitu (wymuszane przez husky `commit-msg` + commitlint).

## Custom agents (VS Code Copilot)

Każdy specjalista ma dedykowany **custom agent** w [`.github/agents/`](.github/agents/) — wybierasz go z dropdownu chatu w VS Code:

| Mode                                                                   | Kiedy używać                                                            |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`orchestrator`](.github/agents/orchestrator.agent.md)                 | multi-step zadania, plan-first, koordynacja specjalistów                |
| [`connector-author`](.github/agents/connector-author.agent.md)         | implementacja / refactor konektora (Jira/Confluence/Figma/Sonar/GitLab) |
| [`epic-strategist`](.github/agents/epic-strategist.agent.md)           | Jira epic breakdown na stories per INVEST, sprint cuts                  |
| [`confluence-architect`](.github/agents/confluence-architect.agent.md) | IA dla Confluence space, page templates, hierarchy                      |
| [`token-tuner`](.github/agents/token-tuner.agent.md)                   | P50/P95 audit, budgetTokens recommendations                             |

VS Code musi mieć włączone `chat.modeFilesLocations` w [`.vscode/settings.json`](.vscode/settings.json) (patrz [`copilot-instructions.md`](.github/copilot-instructions.md) §Jak Copilot pobiera reguły).

Inne hosty MCP (Claude Desktop, Cursor, własny SDK) nie czytają agents — czytają `AGENTS.md` + `.github/copilot-instructions.md` jako fallback. Treść agents intentionally cienka — pełen rulebook w `.github/instructions/`.

## Response templates (LLM-agnostic outputs)

Tool handlery renderują payload przez [`src/shared/response-template.ts`](src/shared/response-template.ts) z markdown+frontmatter templates pod [`templates/responses/`](templates/responses/). Cel: **identyczna struktura odpowiedzi niezależnie od modelu LLM** który ją czyta (Claude / GPT / Gemini behind Copilot).

Engine syntax (self-contained, no deps):

- `{{ var }}` lub `{{ var.path }}` — substytucja z dot-notation
- `{{ var | default:"—" }}` — fallback gdy nullish / pusty string
- `{{#if var}}...{{/if}}` — warunek (truthy = non-empty)
- `{{#each list}} {{ this.field }} {{/each}}` — pętla z item scope (nested loops supported)

Workflow:

1. Edytuj `templates/responses/<name>.md` (frontmatter: `id`, `description`, `version`, `vars`).
2. Preview z fixture: `npm run template:render -- --name=<name> --vars=tests/fixtures/<name>.json`.
3. W tool handler: `import { templateResponse } from '../shared/response-template.js'` → `return templateResponse('jira-issue', vars, metaInput)`.
4. Vitest spec pinuje contract: [`src/shared/response-template.spec.ts`](src/shared/response-template.spec.ts) (13 testów).

Dostępne templates: `npm run template:list` (jira-issue, confluence-page, gitlab-mr, sonar-issue, error).

Gdy dodajesz template — dodaj fixture w `tests/fixtures/<name>.json` żeby preview działało. Gdy zmieniasz template — bump `version:` w frontmatter (semver minor = compatible, major = breaking shape).

## Deterministic gates (validate + audit)

| Skrypt                    | Co robi                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run validate:inputs` | static check `defineTool({...})` w każdym `src/server-*.ts`: name z prefixem servera, description, inputSchema (named ref), handle method                                |
| `npm run token:budget`    | scan Zod limits (`.min`/`.max`/`.default`) w server/extract files, porównanie z baseline w `llm-optimization.instructions.md`, raport `docs/runs/<date>-token-budget.md` |

`validate:inputs` wpięte w `npm run verify` — drift kontraktu blokuje commit. `token:budget` to manualny audit (akcje delegowane do `connector-author` w osobnym PR). Runtime P50/P95 stats — patrz `token-tuner` agent.

## Pełne reguły scoped

Pliki w [`.github/instructions/`](.github/instructions/) są auto-aplikowane przez Copilot do plików matching ich `applyTo` glob:

- `core.instructions.md` — DRY/SOLID/KISS/YAGNI, plan-first
- `principles.instructions.md` — sześć zasad inżynierskich
- `security.instructions.md` — sekrety, write-guard, SSRF
- `tokens.instructions.md` — gdzie tokeny żyją, jak ich nigdy nie logować
- `mcp-server.instructions.md` — jeden serwer per integracja, naming, error contract
- `connectors.instructions.md` — layout konektora, pipeline ekstrakcji, ADF + field-registry
- `llm-optimization.instructions.md` — budżety tokenów, response shaping
- `production-readiness.instructions.md` — sześć must-haves przed shipem
- `language.instructions.md` — pełen split PL / EN

## Gdzie idzie nowa praca

| Rodzaj pracy                           | Sugerowany katalog                                       |
| -------------------------------------- | -------------------------------------------------------- |
| Nowe narzędzie w istniejącym serwerze  | `src/server-<tool>.ts` (dodaj kolejny `defineTool({…})`) |
| Nowy konektor dla nowego narzędzia ALM | Nowy folder `src/<tool>/` + `src/server-<tool>.ts`       |
| Cross-cutting helper                   | `src/shared/` (musi mieć obok plik `*.spec.ts`)          |
| Doc                                    | `docs/<section>/` — Diátaxis layout                      |
| Deterministyczny pipeline ekstrakcji   | `src/extract-<connector>.ts`                             |

## Dwie bramki do tej samej warstwy ekstrakcji

Repo ma **dwa** sposoby wywołania funkcji reshape z `src/shared/`:

1. **MCP stdio** (`src/server-*.ts`) — interactive, agent (Copilot) podejmuje decyzje. Niedeterministyczne.
2. **Skrypty ekstrakcji** (`src/extract-*.ts`) — non-interactive, config-driven (`examples/extract-configs/*.json`). Deterministyczne.

Obie bramki dzielą 100% kodu reshape — nie duplikuj.

## Koordynacja z innymi repo

Repo jest świadomie **standalone**. Sibling [`mcp-devtools`](https://github.com/<your-org>/mcp-devtools) wystawia dev-workflow primitives — używa naszego `http-client.ts` jako wzorca SSRF/proxy gdy doda tool z siecią.
