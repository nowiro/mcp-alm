---
applyTo: 'src/{jira,confluence,figma,sonar,gitlab,shared}/**/*.ts'
description: Kontrakt konektora — layout plików, pipeline ekstrakcji, reguły ADF + field-registry
---

# Kontrakt konektora

_Konektor_ to cienka warstwa, która zamienia jedno upstream API (Jira REST,
Figma REST, GitLab REST, …) na typed functions, które narzędzia MCP wołają.

## 1. Layout plików

```
src/shared/
  http-client.ts        # wrapper fetch z auth + retries + timeout + SSRF + proxy + ETag/dedup
  auth.ts               # ładowanie tokenów (env → user-config → throw)
  user-config.ts        # loader dla ~/.config/mcp-alm/config.json
  write-guard.ts        # assertWriteAllowed() / assertDestructiveAllowed()
  errors.ts             # AuthError / NotFoundError / RateLimitError / UpstreamError / WriteDeniedError

  # ── Pipeline ekstrakcji (shared by every konektor) ──────────────────────
  budget.ts             # BudgetTracker — token budget dla LLM context
  pagination.ts         # iterate() + offset / cursor adaptery per styl upstream
  adf.ts                # ADF (Atlassian Document Format) → Markdown
  field-registry.ts     # custom-field discovery + value reshape
  extract.ts            # composition pipeline (paginate → reshape → budget)

src/server-<tool>.ts    # boot serwera MCP — rejestruje narzędzia
src/<tool>/             # opcjonalne — per-tool moduły reshape / type gdy logika
                        # rośnie poza kilkaset linii inline
```

Warstwa ekstrakcji to kanoniczna odpowiedź na "jak przeżyć projekt z 10 000
issues / schemat custom-field z 50 entries / stronę Confluence o 1 MB
długości". Każdy konektor, który zwraca listy lub rich content, komponuje
się z tych modułów.

## 2. Kształt metody konektora

```ts
async function getIssue(http: HttpClient, key: string): Promise<JiraIssue> { … }
```

- Pure async functions. Brak klas, chyba że state jest naprawdę wymagany
  (np. cursor-based pagination iterator).
- Bierz `http: HttpClient` jako pierwszy argument, żeby testy mogły
  injectować mock.
- Zwracaj Zod-parsed payloads — konektor nigdy nie zwraca raw,
  niesprawdzonego upstream JSON.

## 3. Polityka tokenów

- Tokeny przychodzą z env lub user-profile config — patrz
  [`tokens.instructions.md`](tokens.instructions.md). Nigdy czytane
  mid-flight; resolved raz przy boot serwera w `src/shared/auth.ts`.
- `auth.ts` eksportuje tagged-union `AuthConfig` per tool, więc
  compile-time error odpala, jeśli `server-jira.ts` próbuje czytać
  `auth.figma`.

## 4. Pagination + ekstrakcja

Każda metoda konektora, która zwraca listę, musi iść przez
`src/shared/extract.ts`:

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

Reguły:

- Konektory **nigdy** nie auto-collectują wszystkich stron. Pipeline
  `extract()` jest budget-aware i zatrzymuje się na `BudgetTracker#exceeded()`.
- Flaga `truncated` i kursor `next` MUSZĄ pojawić się w wyniku narzędzia,
  żeby LLM mógł zdecydować, co zrobić (paginować dalej, zawęzić query,
  podsumować).
- Body Atlassian przechodzą przez `adfToMarkdown()` — nigdy nie zwracaj
  raw ADF JSON.
- Jira custom fields idą przez `createJiraFieldRegistry(http)` +
  `reshapeFieldValue(meta, raw)` — nigdy nie zwracaj kluczy
  `customfield_NNNNN`.
- Domyślny budżet per `search_*` tool call: **2 500 tokens** (override do
  80 000 przez argument narzędzia, gdy wywołujący wie, że ma capacity).

## 5. Caching

Opcjonalny. Jeśli narzędzie jest wołane wielokrotnie (np. `figma.get_file`
dla tego samego node), process-local LRU jest OK. Brak disk cache, brak
cross-server shared cache — trzyma model bezpieczeństwa prostym.

## 6. Zabronione

- ❌ Konektor, który sięga do namespace innego narzędzia (np. klient Jira,
  który wie o URL Confluence).
- ❌ Zwracanie raw `unknown` z metody konektora — najpierw Zod-parse.
- ❌ Wkładanie business logic do konektora — konektory to dumb adaptery.
- ❌ Zwracanie raw ADF JSON do LLM. Zawsze przez `adfToMarkdown()`.
- ❌ Zwracanie kluczy `customfield_NNNNN` do LLM. Zawsze reshape przez
  field registry.
- ❌ "Just fetch all pages" — pagination MUSI być budget-aware.
