# AGENTS.md — agenci pracujący w tym repo

> Format [agents.md](https://agents.md). Cienki wskaźnik — pełen rulebook w [`.github/copilot-instructions.md`](.github/copilot-instructions.md) i [`.github/instructions/`](.github/instructions/).

## Tożsamość

**mcp-alm** — TypeScript / Node 22, pięć serwerów MCP per integracja ALM: `mcp-jira`, `mcp-confluence`, `mcp-figma`, `mcp-sonar`, `mcp-gitlab`. Cloud + Data Center / SaaS + self-hosted.

Klient: **GitHub Copilot** w VS Code ≥ 1.121, IntelliJ ≥ 2026.1.2, Eclipse (od 2026-05-21). Inne MCP hosty (Claude Desktop, Cursor, własny Agent SDK) też działają.

**Cross-platform**: Windows + macOS / Linux identycznie. Config w `<home>/.config/mcp-alm/config.json` (`os.homedir()`).

## Konfiguracja repo (dla kogoś modyfikującego ten kod)

**Single AI host: GitHub Copilot.** Repo NIE utrzymuje konfiguracji pod Claude Code / Cursor / inne narzędzia developerskie. Świadomie brak:

- `CLAUDE.md` (instrukcje dla Claude Code)
- `.claude/` (workspace Claude Code: agents, commands, hooks, skills, settings)
- `.ai/` (kanoniczna wiedza AI — rules, agents, workflows, prompts)

Single source of truth dla agentów: ten `AGENTS.md` + [`.github/copilot-instructions.md`](.github/copilot-instructions.md) + [`.github/instructions/`](.github/instructions/) + [`.github/prompts/`](.github/prompts/) + [`.github/chatmodes/`](.github/chatmodes/) + [`.github/skills/`](.github/skills/).

> Uwaga: inne MCP hosty (Claude Desktop, Cursor, custom Agent SDK) mogą **konsumować** uruchomione serwery MCP zgodnie ze standardem MCP — to inna sprawa niż konfiguracja dewelopmentu kodu repo.

## Reguły (skrót dla agentów spoza Copilot)

Pełen rulebook → [`.github/copilot-instructions.md`](.github/copilot-instructions.md).

1. **Czytaj kod przed deklarowaniem.** Nie zgaduj.
2. **Najmniejsza rozsądna zmiana.** Bez drive-by refactor.
3. **Tokeny:** env / user-config, nigdy tracked file; nigdy w log; `console.log` do stdout w serwerze = MCP frame uszkodzony.
4. **Natywny `fetch` przez `src/shared/http-client.ts`**, nie `axios`.
5. **Zod wszędzie** na granicach narzędzi — brak `any`.
6. **Write tools wołają `assertWriteAllowed`** zanim wystrzelą upstream.
7. **DoD = `npm run verify`** (format + lint + typecheck + test + build + ai:validate).
8. **Conventional Commits** — husky commit-msg + commitlint enforce.

## Custom chat modes (VS Code Copilot)

**Jeden widoczny tryb.** Repo wystawia tylko jeden custom chat mode w mode picker Copilota — `orchestrator`. Routuje on do wewnętrznych personas które nie pojawiają się w pickerze (świadoma decyzja: prostsze UX dla użytkownika końcowego).

### Widoczne w mode picker

| Mode                                                         | Kiedy używać                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [`orchestrator`](.github/chatmodes/orchestrator.chatmode.md) | każde high-level zadanie — multi-step, plan-first, routing do specjalistów |

### Wewnętrzne persony (ładowane przez orchestrator, nie pojawiają się w pickerze)

| Persona                                                                | Kiedy orchestrator je ładuje                   |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| [`connector-author`](.github/agents/connector-author.agent.md)         | implementacja / refactor konektora             |
| [`epic-strategist`](.github/agents/epic-strategist.agent.md)           | Jira epic breakdown, INVEST, sprint cuts       |
| [`confluence-architect`](.github/agents/confluence-architect.agent.md) | IA dla Confluence space, page templates        |
| [`token-tuner`](.github/agents/token-tuner.agent.md)                   | P50/P95 audit, budgetTokens recommendations    |
| [`template-author`](.github/agents/template-author.agent.md)           | `templates/responses/` — LLM-agnostic shapes   |
| [`test-engineer`](.github/agents/test-engineer.agent.md)               | coverage ≥ 80%, msw mocks, deterministic specs |
| [`dependency-curator`](.github/agents/dependency-curator.agent.md)     | audit prod-deps, lockfile hygiene              |

### Power-user shortcuts

Slash-commands w [`.github/prompts/`](.github/prompts/) (`/add-tool`, `/new-connector`, `/release`, `/security-review`, `/refine`) uruchamiają konkretną ścieżkę bez przechodzenia przez orchestratora — dla power userów którzy wiedzą co chcą.

VS Code wymaga `chat.modeFilesLocations` w [`.vscode/settings.json`](.vscode/settings.json) (chatmodes są discoverable automatycznie z `.github/chatmodes/`). Inne hosty MCP czytają `AGENTS.md` + `.github/copilot-instructions.md` jako fallback.

## Gdzie idzie nowa praca

| Rodzaj pracy                          | Sugerowany katalog                                                                                                                |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Nowe narzędzie w istniejącym serwerze | `src/server-<tool>.ts` (dodaj `defineTool({…})`)                                                                                  |
| Nowy konektor ALM                     | `src/<tool>/` + `src/server-<tool>.ts`                                                                                            |
| Nowy MCP prompt                       | `definePrompt({…})` w array `prompts` w `src/server-<tool>.ts`                                                                    |
| Nowy MCP resource                     | Markdown w `templates/resources/<server>-<topic>.md` + `defineMarkdownResource({…})` w array `resources` w `src/server-<tool>.ts` |
| Cross-cutting helper                  | `src/shared/` (+ `*.spec.ts`)                                                                                                     |
| Doc                                   | `docs/<section>/` (Diátaxis)                                                                                                      |
| Deterministyczny pipeline ekstrakcji  | `src/extract-<connector>.ts`                                                                                                      |

## Dwie bramki nad warstwą reshape

`src/shared/*` używają **dwie** powierzchnie wywołania:

1. **MCP stdio** (`src/server-*.ts`) — interactive, agent decyduje. Niedeterministyczne.
2. **Skrypty ekstrakcji** (`src/extract-*.ts`) — config-driven (`examples/extract-configs/*.json`). Deterministyczne. Use case: snapshoty / compliance / eval-sety.

Obie dzielą 100% reshape — nie duplikuj. Szczegóły: [`docs/how-to/data-extraction.md`](docs/how-to/data-extraction.md).

## Workflow scripts + response templates

Deterministyczne scaffoldery w `tools/scripts/workflow-*.mjs` dla `/add-tool` + `/new-connector` — LLM nie pali tokenów na decyzje o shape. Response templates w `templates/responses/` — identyczne shape niezależnie od modelu LLM. Pełen kontrakt: [`src/shared/response-template.ts`](src/shared/response-template.ts) + `templates/responses/README.md`.

## Koordynacja z innymi repo

Repo **standalone**. Sibling [`mcp-devtools`](https://github.com/nowiro/mcp-devtools) wystawia dev-workflow primitives — kopiuje wzorzec SSRF/proxy z naszego `http-client.ts`.
