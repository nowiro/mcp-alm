---
applyTo: 'src/server-*.ts'
description: Konwencje serwerów MCP — jeden serwer per integracja, naming, error contract
---

# Konwencje serwerów MCP

Każdy serwer ma ten sam kształt, żeby MCP-zgodny klient (Copilot, Claude Desktop, Cursor, Agent SDK) polegał na jednym kontrakcie cross Jira / Confluence / Figma / Sonar / GitLab.

## 1. Jeden serwer per integracja

- `src/server-jira.ts`, `src/server-confluence.ts`, … — jeden entry point per ALM.
- `bin` w `package.json` mapuje na `dist/server-<tool>.js` → `npx mcp-<tool>`.
- User nie potrzebujący Confluence nie płaci kosztu bootowania — uruchamiaj tylko to, czego używasz.

## 2. Naming narzędzi

`<server>.<verb>_<noun>` — `jira.get_issue`, `confluence.search_pages`, `gitlab.list_mrs`. Prefix MUSI matchować nazwę serwera. Nigdy nie przeciążaj cross-serwerami.

## 3. Pełen kontrakt `bootMcpServerIfEnabled`

`StartOptions` w [`mcp-server.ts`](../../src/shared/mcp-server.ts) wymaga **trzech** tablic (pusta `[]` jeśli serwer nie ma capability):

```ts
await bootMcpServerIfEnabled({
  name: SERVER_NAME,
  tools, // ToolDefinition[] — operacje upstream
  prompts, // PromptDefinition[] — slash-commands; `[]` jeśli brak
  resources, // ResourceDefinition[] — read-only docs; `[]` jeśli brak
});
```

- **`prompts`** (`prompts/list` + `prompts/get`) — preconfigured slash-commands w Copilot Chat (`/<server>.<prompt>`). `definePrompt({ name, description, arguments?, buildMessages })` z [`prompt.ts`](../../src/shared/prompt.ts). Use: zastąp "napisz JQL który…" jednym `/jira.sprint-summary PROJ`.
- **`resources`** (`resources/list` + `resources/read`) — read-only docs cache'owane przez Copilot raz na sesję. Najprościej: markdown w `templates/resources/<server>-<topic>.md` + `defineMarkdownResource({ uri, name, description, file })` z [`resource.ts`](../../src/shared/resource.ts). Helper resolwuje path z `import.meta.url` (cross-platform po `npx mcp-<server>`).
- **URI convention:** `mcp-<server>://docs/<slug-kebab>` (np. `mcp-jira://docs/jql-cheatsheet`), MIME default `text/markdown`.

## 4. Read-first, write-guarded

- Każdy serwer defaultuje do **read-only**. Write tools (`create_issue`, `add_comment`, `merge_mr`) rejestrują się warunkowo na `isWriteEnabled()` z [`write-guard.ts`](../../src/shared/write-guard.ts).
- Pierwsza instrukcja handlera = `assertWriteAllowed(toolName)`. Allowlist `MCP_WRITE_ALLOWLIST=<tool>,<tool>`; pusta = deny.
- **Destruktywne** (`delete_*` / `drop_*` / `remove_*`) dodatkowo:
  - `assertDestructiveAllowed(toolName, input.confirmToken)` — match `MCP_DESTRUCTIVE_CONFIRM` (≥ 16 znaków, `timingSafeEqual`).
  - `assertResourceConfirmation(toolName, fetchedName, input.confirmResourceName)` po upstream GET — agent echo'wuje nazwę (page title, repo path, issue summary) case-sensitive exact. Chroni przed wrong-resource delete.

## 5. Schematy Zod

Każde narzędzie deklaruje Zod schema dla inputu. MCP SDK generuje JSON Schema dla `tools/list`. **Brak `any` na granicach.**

```ts
const GetIssueInput = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
});
```

## 6. Kontrakt błędów

Typed errors z [`errors.ts`](../../src/shared/errors.ts):

| Klasa               | Trigger                                           | MCP code |
| ------------------- | ------------------------------------------------- | -------- |
| `AuthError`         | 401 / 403 z upstream                              | -32001   |
| `NotFoundError`     | 404                                               | -32002   |
| `RateLimitError`    | 429                                               | -32003   |
| `UpstreamError`     | 5xx, bad JSON, body cap                           | -32004   |
| `WriteDeniedError`  | odmowa write-guard tier 1/2                       | -32005   |
| `ValidationError`   | semantic input validation (mutually-exclusive)    | -32007   |
| `SecurityError`     | defence-in-depth (path traversal, SSRF preflight) | -32008   |
| `ConfirmationError` | tier 3: nazwa zasobu nie matchuje                 | -32009   |
| Unknown             | fallback                                          | -32603   |

Host (VS Code / IntelliJ / Claude Desktop) routuje per code: `-32001` prompts re-auth, `-32003` plan retry, itd.

## 7. Logowanie

Jedna JSON-line per tool call → **stderr** (stdout = transport MCP):

```json
{
  "ts": "2026-05-22T12:00:00.000Z",
  "server": "mcp-jira",
  "version": "1.0.0",
  "tool": "jira.get_issue",
  "correlationId": "9e1c7c1f-...",
  "durationMs": 142,
  "ok": true
}
```

Bez PII / fragmentów tokenów / pełnych body upstream — tylko klucze deklarowane przez schema.

`correlationId` z inbound `req.params._meta?.correlationId` (Copilot CLI `preMcpToolCall` hook może wstrzyknąć trace ID z external observability). Fallback: ULID server-side. End-to-end: inbound `_meta` → log → ledger → outbound `_meta` → `X-Request-ID` header. Patrz [`observability.md`](../../docs/explanation/observability.md) §4.1.

## 8. Zabronione

- ❌ Hard-coded credentials gdziekolwiek (nawet w testach — mockuj env w vitest setup).
- ❌ `axios` — natywny `fetch` przez [`http-client.ts`](../../src/shared/http-client.ts).
- ❌ `console.log` do stdout — uszkadza ramkę MCP.
- ❌ Cross-server imports — współdzielenie tylko przez `src/shared/`.
- ❌ Serwer persystujący stan na dysku default. Memory / caching → jawna flaga env, udokumentowane w [`enterprise-intranet.md`](../../docs/getting-started/enterprise-intranet.md).
