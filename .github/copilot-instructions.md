# GitHub Copilot — instrukcje dla mcp-alm

> Przeczytaj to **najpierw** w każdej sesji. Ten plik jest najwyższej
> priorytetu konfiguracją Copilota dla repo.

## Tożsamość

Pracujesz wewnątrz **mcp-alm** — projektu TypeScript / Node 22, który
shipuje **pięć** serwerów MCP (Model Context Protocol), jeden per
integracja ALM:

- `mcp-jira` — Jira Cloud + Data Center
- `mcp-confluence` — Confluence Cloud + Data Center
- `mcp-figma` — Figma (read-only)
- `mcp-sonar` — SonarQube / SonarCloud
- `mcp-gitlab` — GitLab SaaS + self-hosted

Główny klient to **GitHub Copilot** w **VS Code ≥ 1.121**, **IntelliJ IDEA
≥ 2026.1.2** i **Eclipse** (plugin Copilot open-sourced 2026-05-21). Inne
MCP-zgodne hosty (Claude Desktop, Cursor, własny kod Agent SDK) też działają
— nie wstawiaj założeń IDE-specific do runtime'u.

## Preferencje językowe

- **Język czatu: polski.** Odpowiadaj użytkownikowi po polsku, dopóki nie
  przełączy.
- **Kod, historia git, `description` narzędzi MCP, każda powierzchnia
  czytana przez tooling: angielski.** Stringi `description` MCP są wysyłane
  do LLM przy każdym `tools/list` — polski tokenizuje się ~1.4× drożej.

## Czytaj na początku sesji

1. [`README.md`](../README.md) — czym to repo jest.
2. [`AGENTS.md`](../AGENTS.md) — podsumowanie reguł dla agentów.
3. Każdy plik w [`.github/instructions/`](instructions/) — aplikowany
   automatycznie do plików matching jego `applyTo`:
   - [`core.instructions.md`](instructions/core.instructions.md) — prawda,
     najmniejsza zmiana, plan-first.
   - [`principles.instructions.md`](instructions/principles.instructions.md) —
     DRY, SOLID, KISS, YAGNI.
   - [`security.instructions.md`](instructions/security.instructions.md) —
     sekrety, write-guard, SSRF, supply chain.
   - [`tokens.instructions.md`](instructions/tokens.instructions.md) —
     skąd przychodzą tokeny i jak ich nigdy nie logować.
   - [`mcp-server.instructions.md`](instructions/mcp-server.instructions.md) —
     jeden serwer per integracja, tool naming, error contract.
   - [`connectors.instructions.md`](instructions/connectors.instructions.md) —
     layout konektora, pipeline ekstrakcji, reguły ADF + field-registry.
   - [`llm-optimization.instructions.md`](instructions/llm-optimization.instructions.md) —
     budżety tokenów, response shaping, `compactJson`, `truncate`.
   - [`production-readiness.instructions.md`](instructions/production-readiness.instructions.md) —
     sześć must-haves zanim user-facing change shipuje.
   - [`language.instructions.md`](instructions/language.instructions.md) —
     pełen split PL / EN.

## Twarde reguły

- ✅ Przeczytaj kod zanim ogłosisz, że go znasz.
- ✅ Najmniejsza rozsądna zmiana.
- ✅ Definition of Done = `npm run format:check && npm run lint && npm run
typecheck && npm test && npm run build && npm run ai:validate`.
- ❌ Nigdy nie wymyślaj ścieżek plików, nazw funkcji, wersji pakietów.
- ❌ Nigdy nie bypassuj git hooków (`--no-verify`).
- ❌ Nigdy nie wkładaj tokena do tracked file. Tokeny przychodzą z env lub
  `~/.config/mcp-alm/config.json` — patrz [`tokens.instructions.md`](instructions/tokens.instructions.md).
- ❌ Nigdy `console.log` do **stdout** z pliku serwera — stdout to ramka
  MCP. Loguj JSON-line do **stderr** przez
  [`src/shared/log.ts`](../src/shared/log.ts).
- ❌ Nigdy `axios` — tylko natywny `fetch` (przez
  [`src/shared/http-client.ts`](../src/shared/http-client.ts)).

## Konwencje serwera MCP (skrót)

Destylowane z [`mcp-server.instructions.md`](instructions/mcp-server.instructions.md):

- **Jeden serwer per integracja.** Każdy `src/server-<tool>.ts` jest
  uruchamialny niezależnie jako `npx mcp-<tool>`.
- **Trzy MCP capabilities per serwer:**
  - **Tools** (`tools/list` + `tools/call`) — operacje upstream (read / write / destructive). Wymagane.
  - **Prompts** (`prompts/list` + `prompts/get`) — preconfigured slash-commands w Copilot Chat. Pusta tablica jeśli brak.
  - **Resources** (`resources/list` + `resources/read`) — read-only docs cache'owane przez hosta (cheatsheets, guides). Pusta tablica jeśli brak.
    Każdy serwer wpina wszystkie trzy do `bootMcpServerIfEnabled({ name, tools, prompts, resources })`.
- **Tool naming:** `<tool>.<verb>_<noun>` — `jira.get_issue`,
  `confluence.search_pages`, `gitlab.list_mrs`. Prefix MUSI matchować
  nazwę serwera.
- **Read-first, write-guarded.** Write tools rejestrują się tylko gdy
  `MCP_WRITE_ENABLED=true`. Każdy mutujący handler wrappuje
  `assertWriteAllowed(toolName)`.
- **Zod wszędzie.** Każde narzędzie deklaruje schema Zod; MCP SDK
  generuje JSON Schema. Brak `any` na granicach narzędzi.
- **Typed errors** — `AuthError` → `-32001`, `NotFoundError` → `-32002`,
  `RateLimitError` → `-32003`, `UpstreamError` → `-32004`,
  `WriteDeniedError` → `-32005`, unknown → `-32603`.
- **Stderr JSON logs** — jedna linia per wywołanie narzędzia. Brak PII,
  brak fragmentów tokenów, brak pełnych body odpowiedzi upstream.

## Kontrakt konektora (skrót)

Destylowane z [`connectors.instructions.md`](instructions/connectors.instructions.md):

- Layout: `src/<tool>/{client,types,tools}.ts` (gdy konektor rośnie) +
  `src/server-<tool>.ts` + wspólne moduły w `src/shared/`.
- Konektory to pure async functions biorące `http: HttpClient` jako
  pierwszy argument. Zwracają Zod-parsed payloads. Brak klas, chyba że
  state jest naprawdę wymagany.
- Każda metoda zwracająca listę idzie przez `src/shared/extract.ts`
  (paginate → reshape → budget). Domyślny budżet per-call: **2 500
  tokens**; override do 80 000 przez argument narzędzia, gdy capacity
  pozwala.
- Body Atlassian → `adfToMarkdown()`. Jira custom fields → `field-registry`.
  Nigdy nie zwracaj raw ADF JSON ani kluczy `customfield_NNNNN`
  modelowi.
- Zawsze wystawiaj `truncated` + kursor `next` — LLM decyduje czy
  paginować dalej.

## Polityka tokenów (skrót)

Destylowane z [`tokens.instructions.md`](instructions/tokens.instructions.md):

- Tokeny przychodzą najpierw z env vars (`JIRA_TOKEN`, `CONFLUENCE_TOKEN`,
  …), potem `~/.config/mcp-alm/config.json`, potem `AuthError`. Brak
  trzeciego fallback.
- Najmniejszy możliwy scope per serwer (`read:jira-work`, `read_api`, …).
  Szerszy scope wymaga uzasadnienia w opisie PR.
- `http-client.ts` redaktuje nagłówek `authorization` out-of-band; logger
  też rekursywnie redaktuje token-like keys jako defence in depth.

## Optymalizacja LLM (skrót)

Destylowane z [`llm-optimization.instructions.md`](instructions/llm-optimization.instructions.md):

- Estymuj przed wysyłką (`BudgetTracker`).
- Compact JSON (`compactJson()` — drop `null` / `undefined` / pustych
  tablic / pustych stringów).
- Podsumowuj długie tablice (`summarizeArray()` — head + tail + `total`).
- ADF / HTML → Markdown (~3× mniejsze).
- Custom-field reshape (~1.5× mniejsze).
- Process-local LRU dla static lookups (field registry, project lists).
- **Angielski** w stringach `description` narzędzi MCP — wysyłane do
  modelu przy każdym `tools/list`.

## Jak Copilot pobiera reguły stąd

W kolejności priorytetu:

1. **Ten plik** (`.github/copilot-instructions.md`) — repo-wide.
2. **Scoped instructions** w [`.github/instructions/*.instructions.md`](instructions/) —
   auto-aplikowane do plików matching `applyTo`.
3. **Prompt files** w [`.github/prompts/*.prompt.md`](prompts/) — wywoływane
   przez `/<promptname>` w Copilot Chat.
4. **Custom agents** w [`.github/agents/*.agent.md`](agents/) — wybierane
   z dropdownu trybu chatu (orchestrator, connector-author, epic-strategist,
   confluence-architect, token-tuner).
5. **User prompt** — najwyższy.

VS Code potrzebuje tych ustawień (już w [`.vscode/settings.json`](../.vscode/settings.json)):

```jsonc
{
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "chat.promptFiles": true,
  "chat.promptFilesLocations": { ".github/prompts": true },
  "chat.instructionsFilesLocations": { ".github/instructions": true },
  "chat.modeFilesLocations": { ".github/agents": true },
}
```

IntelliJ pobiera `.github/copilot-instructions.md` automatycznie z pluginu
GitHub Copilot w 2026.1.2+ — brak extra ustawień.

## Workflows (slash commands w Copilot Chat)

- `/new-connector` — szablon dla nowego targetu ALM (REST discovery →
  schemas → tools → tests → docs).
- `/add-tool` — szablon dla pojedynczego nowego narzędzia w istniejącym
  konektorze.
- `/release` — `npm run verify` → bump version → regen CHANGELOG →
  publish.

Pełen set w [`.github/prompts/`](prompts/).

## Conventional Commits

Format: `type(scope): subject` — wymuszany przez husky `commit-msg` +
commitlint.

- **Types:** `feat` `fix` `docs` `style` `refactor` `perf` `test` `build`
  `ci` `chore` `revert`
- **Scopes:** `jira` `confluence` `figma` `sonar` `gitlab` `shared` `auth`
  `http` `write-guard` `log` `errors` `ci` `deps` `docs` `release`
  `security`

## Bramka walidacji przed raportowaniem Done

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run ai:validate
```

Jeśli jakikolwiek krok zawiedzie, nie jesteś done. Wystaw failure
użytkownikowi verbatim.

## End-of-turn

Zawsze emituj jedno z:

```yaml
done:
  changes:
    - <path>:<one-line summary>
  validators: { format: ✓, lint: ✓, typecheck: ✓, test: ✓, build: ✓, ai-validate: ✓ }
  followups: [...]
```

```yaml
blocked:
  reason: <one line>
  needs:
    - <user decision | external service | missing input>
```
