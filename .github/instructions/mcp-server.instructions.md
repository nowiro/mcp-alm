---
applyTo: 'src/server-*.ts'
description: Konwencje serwerów MCP — jeden serwer per integracja, naming, error contract
---

# Konwencje serwerów MCP

Każdy serwer MCP w tym repo śledzi ten sam kształt, żeby każdy MCP-zgodny
klient (Copilot w VS Code / IntelliJ, Claude Desktop, Cursor, własny kod
Agent SDK) mógł polegać na jednym kontrakcie cross Jira / Confluence /
Figma / SonarQube / GitLab.

## 1. Jeden serwer per integracja

- `src/server-jira.ts`, `src/server-confluence.ts`, … — jeden entry point
  per narzędzie ALM.
- Wpisy `bin` w `package.json` mapują na `dist/server-<tool>.js`, więc
  każdy serwer może być uruchomiony niezależnie jako `npx mcp-<tool>`.
- Użytkownik, który nie potrzebuje Confluence, nie płaci kosztu bootowania
  go — uruchamiaj tylko to, czego używasz.

## 2. Naming narzędzi

`<server>.<verb>_<noun>` — np. `jira.get_issue`, `confluence.search_pages`,
`gitlab.list_mrs`. Prefix MUSI matchować nazwę serwera. Nigdy nie
przeciążaj nazwy narzędzia cross serwerami; każdy serwer posiada swój
prefix.

## 2.5. Pełen kontrakt `bootMcpServerIfEnabled` — tools + prompts + resources

`StartOptions` w [`src/shared/mcp-server.ts`](../../src/shared/mcp-server.ts)
wymaga **trzech** tablic, każda obowiązkowo przekazana (pusta `[]` jeśli serwer
nie ma danej capability):

```ts
await bootMcpServerIfEnabled({
  name: SERVER_NAME,
  tools, // ToolDefinition[] — operacje upstream
  prompts, // PromptDefinition[] — slash-commands; `[]` jeśli brak
  resources, // ResourceDefinition[] — read-only docs; `[]` jeśli brak
});
```

- **`prompts`** (`prompts/list` + `prompts/get`) — preconfigured slash-commands
  pokazywane w Copilot Chat (`/<server>.<prompt>`). Definiuj przez
  `definePrompt({ name, description, arguments?, buildMessages })` z
  [`src/shared/prompt.ts`](../../src/shared/prompt.ts). Use case: zastąpienie
  złożonego "napisz JQL który…" jednym `/jira.sprint-summary PROJ`.
- **`resources`** (`resources/list` + `resources/read`) — read-only docs / configs
  / cheatsheets, które Copilot cache'uje raz i ma w kontekście do końca sesji.
  Najprościej: markdown w `templates/resources/<server>-<topic>.md` +
  `defineMarkdownResource({ uri, name, description, file })` z
  [`src/shared/resource.ts`](../../src/shared/resource.ts). Helper resolwuje
  path z `import.meta.url`, więc działa cross-platform po `npx mcp-<server>`
  z dowolnego `cwd`.
- Convention URI: `mcp-<server>://docs/<slug-kebab>` (np.
  `mcp-jira://docs/jql-cheatsheet`). MIME default `text/markdown`.

## 3. Read-first, write-guarded

- Każdy serwer defaultuje do **read-only**. Write tools (mutujące operacje
  jak `create_issue`, `add_comment`, `merge_mr`) rejestrują się warunkowo
  na `isWriteEnabled()` z
  [`src/shared/write-guard.ts`](../../src/shared/write-guard.ts).
- Nawet po rejestracji, pierwsza instrukcja handlera musi być
  `assertWriteAllowed(toolName)`. Allowlist to
  `MCP_WRITE_ALLOWLIST=<tool.name>,<tool.name>`; pusta allowlist odmawia
  każdemu write tool.
- Destruktywne narzędzia (`delete_*` / `drop_*` / `remove_*`) dodatkowo wołają:
  - `assertDestructiveAllowed(toolName, input.confirmToken)` — confirm token
    musi matchować `MCP_DESTRUCTIVE_CONFIRM` (≥ 16 znaków, porównanie w
    stałym czasie);
  - `assertResourceConfirmation(toolName, fetchedName, input.confirmResourceName)`
    po upstream GET na targetowanym zasobie — agent echo'wuje bieżącą nazwę
    (page title, repo path, issue summary), case-sensitive, exact match.
    Chroni przed wrong-resource delete'em.

## 4. Schematy Zod wszędzie

Każde narzędzie deklaruje schemat Zod dla inputu. MCP SDK generuje JSON
Schema dla `tools/list` z każdej definicji Zod. **Brak `any` na granicach
narzędzi.**

```ts
const GetIssueInput = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9]+-\d+$/),
});
```

## 5. Kontrakt błędów

Narzędzia rzucają typed errors z [`src/shared/errors.ts`](../../src/shared/errors.ts):

- `AuthError` (401 / 403 z upstream) → MCP error code `-32001`
- `NotFoundError` (404) → `-32002`
- `RateLimitError` (429) → `-32003`
- `UpstreamError` (5xx, bad JSON, body cap) → `-32004`
- `WriteDeniedError` (odmowa write-guard tier 1/2) → `-32005`
- `ValidationError` (semantyczna walidacja inputu, np. mutually-exclusive params) → `-32007`
- `SecurityError` (defence-in-depth guard: path traversal, SSRF preflight) → `-32008`
- `ConfirmationError` (odmowa tier 3: nazwa zasobu nie matchuje) → `-32009`
- Unknown → `-32603` (JSON-RPC `Internal error`)

Host (VS Code / IntelliJ / Claude Desktop) routuje każdy kod inaczej:
`-32001` prompts re-auth, `-32003` plan retry, itd.

## 6. Logowanie

Jedna linia JSON per wywołanie narzędzia, na **stderr** (stdout jest
zarezerwowany dla transportu MCP):

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

Bez PII, bez fragmentów tokenów, bez pełnych body odpowiedzi upstream —
tylko klucze, które schema deklaruje.

## 7. Zabronione

- ❌ Hard-coded credentials gdziekolwiek — nawet w testach. Mockuj env w
  vitest setup.
- ❌ `axios` — natywny `fetch` przez
  [`src/shared/http-client.ts`](../../src/shared/http-client.ts).
- ❌ Bezpośrednie `console.log` do stdout — uszkadza ramkę MCP.
- ❌ Cross-server imports — każdy `server-*.ts` współdzieli tylko przez
  `src/shared/`.
- ❌ Dodawanie serwera, który persystuje stan na dysku domyślnie. Jeśli
  memory / caching jest potrzebne, żyje za jawną flagą env i jest
  udokumentowane w [`docs/getting-started/enterprise-intranet.md`](../../docs/getting-started/enterprise-intranet.md).
