# GitHub Copilot — instrukcje dla mcp-alm

> Przeczytaj **najpierw** w każdej sesji. Top-level digest; szczegóły w `.github/instructions/*.md` (auto-loaded per `applyTo` glob) oraz `AGENTS.md`.

## Tożsamość

**mcp-alm** — TypeScript / Node 22, pięć serwerów MCP per integracja ALM: `mcp-jira`, `mcp-confluence`, `mcp-figma`, `mcp-sonar`, `mcp-gitlab`. Cloud + Data Center / SaaS + self-hosted.

Klient: **GitHub Copilot** w VS Code ≥ 1.121, IntelliJ ≥ 2026.1.2, Eclipse (od 2026-05-21). Inne MCP hosty (Claude Desktop, Cursor) też działają — bez założeń IDE-specific.

## Język

- **Czat: polski.** Odpowiadaj PL dopóki user nie przełączy.
- **Kod, git, MCP `description` strings, wszystko czytane przez tooling: angielski.** PL tokenizuje ~1.4× drożej.

## Twarde reguły (must)

- ✅ Czytaj kod przed deklarowaniem że znasz; najmniejsza rozsądna zmiana.
- ✅ DoD przed "done": `npm run verify` (format + lint + typecheck + test + build + ai:validate).
- ❌ Nie zgaduj ścieżek / nazw / wersji.
- ❌ Nie bypass git hooków (`--no-verify`).
- ❌ Tokeny **wyłącznie** z env / `~/.config/mcp-alm/config.json` — nigdy w tracked file.
- ❌ Nie `console.log` do **stdout** w `src/server-*.ts` (uszkadza MCP frame). Loguj JSON-line do stderr przez `src/shared/log.ts`.
- ❌ Nie `axios` — natywny `fetch` przez `src/shared/http-client.ts`.

## MCP capabilities trio (per serwer)

Każdy `src/server-*.ts` wpina **trzy** capability arrays do `bootMcpServerIfEnabled({ name, tools, prompts, resources })`:

- **`tools`** — `<server>.<verb>_<noun>` (np. `jira.get_issue`). Read-first; write tools warunkowane `MCP_WRITE_ENABLED` + `assertWriteAllowed(toolName)`.
- **`prompts`** — slash-commands w Copilot Chat (`prompts/list` + `prompts/get`). `[]` jeśli brak.
- **`resources`** — read-only docs (`resources/list` + `resources/read`), cache'owane przez hosta. `[]` jeśli brak.

Pełen kontrakt + naming → [`mcp-server.instructions.md`](instructions/mcp-server.instructions.md). Layout konektora + extract pipeline → [`connectors.instructions.md`](instructions/connectors.instructions.md). Polityka tokenów → [`tokens.instructions.md`](instructions/tokens.instructions.md). Token shaping → [`llm-optimization.instructions.md`](instructions/llm-optimization.instructions.md).

## Hierarchia reguł

1. **Ten plik** — repo-wide.
2. **`.github/instructions/*.instructions.md`** — auto-aplikowane per `applyTo` glob (load: `core`, `principles`, `security`, `tokens`, `mcp-server`, `connectors`, `llm-optimization`, `production-readiness`, `language`).
3. **`.github/prompts/*.prompt.md`** — wywoływane `/<name>` (`/release`, `/add-tool`, `/new-connector`, `/security-review`).
4. **`.github/agents/*.agent.md`** — picker w VS Code (`orchestrator`, `connector-author`, `epic-strategist`, `confluence-architect`, `token-tuner`, `template-author`, `test-engineer`, `dependency-curator`).
5. **User prompt** — najwyższy.

VS Code settings są w [`.vscode/settings.json`](../.vscode/settings.json). IntelliJ 2026.1.2+ ładuje ten plik automatycznie z pluginu Copilot.

## Conventional Commits

`type(scope): subject` — wymuszane przez `husky commit-msg` + commitlint.

- **Types:** `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`
- **Scopes:** `jira` `confluence` `figma` `sonar` `gitlab` `shared` `auth` `http` `write-guard` `log` `errors` `ci` `deps` `docs` `release` `security` `extract`

## End-of-turn

Emituj jedno z:

```yaml
done:
  changes: [<path>:<summary>]
  validators: { format: ✓, lint: ✓, typecheck: ✓, test: ✓, build: ✓, ai-validate: ✓ }
  followups: [...]
```

```yaml
blocked:
  reason: <line>
  needs: [<user decision | external | missing input>]
```
