---
applyTo: 'src/{jira,confluence,figma,sonar,gitlab,shared}/**/*.ts'
description: Kontrakt konektora — layout plików, pipeline ekstrakcji, reguły ADF + field-registry
---

# Kontrakt konektora

Cienka warstwa zamieniająca jedno upstream API (Jira REST, Figma REST, GitLab REST, …) na typed functions wołane przez narzędzia MCP.

## 1. Layout

```
src/shared/
  http-client.ts    # fetch wrapper: auth + retries + timeout + SSRF + proxy + ETag/dedup
  auth.ts           # ładowanie tokenów (env → user-config → throw)
  user-config.ts    # loader ~/.config/mcp-alm/config.json
  write-guard.ts    # assertWriteAllowed() / assertDestructiveAllowed()
  errors.ts         # AuthError / NotFoundError / RateLimitError / UpstreamError / WriteDeniedError

  # Pipeline ekstrakcji (shared)
  budget.ts         # BudgetTracker — token budget dla LLM context
  pagination.ts     # iterate() + offset / cursor adapters per upstream style
  adf.ts            # ADF (Atlassian Document Format) → Markdown
  field-registry.ts # custom-field discovery + value reshape
  extract.ts        # composition (paginate → reshape → budget)

src/server-<tool>.ts # boot serwera MCP, rejestracja narzędzi
src/<tool>/          # opcjonalne — per-tool reshape/types gdy logika > kilkaset linii
```

Warstwa ekstrakcji to kanoniczna odpowiedź na "10k issues / 50-entry custom-field schema / 1MB Confluence page". Każdy konektor zwracający listy lub rich content komponuje się z tych modułów.

## 2. Kształt metody

```ts
async function getIssue(http: HttpClient, key: string): Promise<JiraIssue> { … }
```

- **Pure async functions.** Brak klas, chyba że state wymagany (np. cursor iterator).
- `http: HttpClient` jako pierwszy argument — testy injectują mock.
- Zwracaj **Zod-parsed** payloads, nigdy raw upstream JSON.

## 3. Tokeny

- Z env lub user-profile config ([`tokens.instructions.md`](tokens.instructions.md)). Nigdy mid-flight; resolved raz przy boot w [`auth.ts`](../../src/shared/auth.ts).
- `auth.ts` eksportuje tagged-union `AuthConfig` per tool — compile-time error gdy `server-jira.ts` próbuje czytać `auth.figma`.

## 4. Pagination + ekstrakcja

Każda metoda zwracająca listę MUSI iść przez `extract.ts`:

```ts
import { BudgetTracker } from '../shared/budget.js';
import { extract } from '../shared/extract.js';
import { jiraJqlCursorAdapter } from '../shared/pagination.js';

const fetchPage = jiraJqlCursorAdapter(
  ({ nextPageToken, maxResults }) =>
    http.request({
      path: '/rest/api/3/search/jql',
      query: { jql, maxResults, ...(nextPageToken ? { nextPageToken } : {}) },
    }),
  (raw) => raw.issues,
  50,
);
const result = await extract({
  fetchPage,
  budget: new BudgetTracker(2_500),
  reshape: (issue) => reshapeJiraIssue(issue, fieldRegistry),
});
return { items: result.items, next: result.next, truncated: result.truncated };
```

**Reguły:**

- Konektory **nigdy** nie auto-collectują wszystkich stron. `extract()` jest budget-aware, zatrzymuje się na `BudgetTracker#exceeded()`.
- `truncated` + `next` cursor **MUSZĄ** być w wyniku — LLM decyduje paginować / zawężać / podsumować.
- Body Atlassian → `adfToMarkdown()`, nigdy raw ADF JSON.
- Jira custom fields → `createJiraFieldRegistry(http)` + `reshapeFieldValue(meta, raw)`, nigdy raw `customfield_NNNNN`.
- Default budget per `search_*` call: **2 500 tokens** (override do 80 000 przez argument gdy capacity pozwala).

## 5. Caching

Opcjonalny. Wielokrotne wywołanie (`figma.get_file` dla tego samego node) → process-local LRU OK. Brak disk cache, brak cross-server shared cache (security model simple).

## 6. Zabronione

- ❌ Konektor sięgający do namespace innego (klient Jira wiedzący o Confluence URL).
- ❌ `unknown` z metody — najpierw Zod parse.
- ❌ Business logic w konektorze — to dumb adaptery.
- ❌ Raw ADF JSON do LLM. Zawsze `adfToMarkdown()`.
- ❌ `customfield_NNNNN` do LLM. Zawsze reshape przez field registry.
- ❌ "Just fetch all pages" — pagination MUSI być budget-aware.
