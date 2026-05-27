# Jak: dodać nowy konektor ALM

> Przepis krok po kroku dla dodania szóstego konektora (np. Bitbucket,
> Asana, Notion). Czas: pół dnia na read-only MVP.

To przepis, nie wyjaśnienie — _dlaczego_ za kontraktem, który będziesz
implementować, przeczytaj [`explanation/architecture.md`](../explanation/architecture.md)
i [`explanation/security-architecture.md`](../explanation/security-architecture.md)
najpierw.

## 1. Dodaj scope do commitlint

Edytuj [`commitlint.config.mjs`](../../commitlint.config.mjs) i dodaj swój
scope (np. `bitbucket`) do tablicy `scope-enum`. Bez tego, każdy Twój commit
zostanie odrzucony przez hook `commit-msg`.

## 2. Szablon `src/server-<name>.ts`

Skopiuj jeden z istniejących serwerów (`src/server-jira.ts` lub
`src/server-figma.ts` dla pure-read) i podmień:

```typescript
#!/usr/bin/env node
import { z } from 'zod';

import { loadXxxAuth } from './shared/auth.js';
import { createNamedHttpClient } from './shared/http-client.js';
import { bootMcpServerIfEnabled, defineTool, usageHistoryTool, type ToolDefinition } from './shared/mcp-server.js';
import { definePrompt, type PromptDefinition } from './shared/prompt.js';
import { defineMarkdownResource, type ResourceDefinition } from './shared/resource.js';

const SERVER_NAME = 'mcp-<name>';

const http = createNamedHttpClient(SERVER_NAME, loadXxxAuth());

const tools: ToolDefinition[] = [
  defineTool({
    name: '<connector>.list_projects',
    description: 'List projects visible to the token.',
    inputSchema: z.object({}),
    async handle(_input, ctx) {
      return http.request({ path: '/api/projects', correlationId: ctx.correlationId, tool: ctx.tool });
    },
  }),
  // … kolejne narzędzia
  usageHistoryTool(SERVER_NAME),
];

// Preconfigured slash-commands (`prompts/list` + `prompts/get`). `[]` jeśli brak.
const prompts: PromptDefinition[] = [
  // definePrompt({ name: '<connector>.my-default', description: '…', buildMessages: () => [...] }),
];

// Read-only docs cached przez Copilot Chat (`resources/list` + `resources/read`). `[]` jeśli brak.
const resources: ResourceDefinition[] = [
  // defineMarkdownResource({
  //   uri: 'mcp-<connector>://docs/<topic>',
  //   name: '<topic> cheatsheet',
  //   description: 'One-line shown w Copilot resource pickerze.',
  //   file: '<connector>-<topic>.md', // → templates/resources/<connector>-<topic>.md
  // }),
];

export { tools, prompts, resources };

await bootMcpServerIfEnabled({ name: SERVER_NAME, tools, prompts, resources });
```

## 3. Zdefiniuj uwierzytelnianie w `src/shared/auth.ts`

Dodaj branch dla nowego konektora, który czyta swój token z env →
user-profile config → throw. Mirror istniejących wzorców:

```typescript
interface XxxAuth {
  readonly tool: 'xxx';
  readonly baseUrl: string;
  readonly token: string;
}

export function loadXxxAuth(): XxxAuth {
  return {
    tool: 'xxx',
    baseUrl: requireSecret('XXX_BASE_URL', 'xxx', 'baseUrl', 'xxx'),
    token: requireSecret('XXX_TOKEN', 'xxx', 'token', 'xxx'),
  };
}
```

I dodaj `xxx` do dyskryminowanej unii `AuthConfig` oraz do schematu Zod w
`src/shared/user-config.ts`. Patrz [ADR-0004](../adr/0004-token-env-only.md)
po uzasadnienie env-only.

## 4. Dostosuj `http-client.ts` (jeśli konektor wymaga niestandardowego auth)

Większość API używa `Authorization: Bearer <token>` — wspierane
out-of-the-box. Jeśli konektor wymaga niestandardowego nagłówka (jak Figma
z `X-Figma-Token`), dodaj branch w `buildAuthHeader()`.

## 5. Dodaj wpis `bin`

W [`package.json`](../../package.json):

```json
"bin": {
  "mcp-<name>": "./dist/server-<name>.js"
}
```

I skrypt start dla wygody:

```json
"start:<name>": "node dist/server-<name>.js"
```

## 6. Zaktualizuj `.mcp.json` (dogfooding) i `.vscode/mcp.json`

Dodaj wpis w obu plikach, żeby konektor był odkrywalny przy lokalnej pracy
nad mcp-alm i w VS Code.

## 7. Dokumentacja konfiguracji

Dodaj sekcję do [`reference/configuration.md`](../reference/configuration.md):

- Wymagane env vars (base URL, token).
- `MCP_WRITE_ALLOWLIST` jeśli są narzędzia mutujące.
- Gdzie uzyskać token.

Dodaj sekcję do [`how-to/configure-tokens.md`](configure-tokens.md) z
krokami pozyskania tokena.

## 8. Doctor + przykład config

Dodaj wpis dla konektora w `SPECS` w [`tools/scripts/doctor.mjs`](../../tools/scripts/doctor.mjs)
(walidacja baseUrl + placeholder check). Dodaj sekcję do [`config.example.json`](../../config.example.json).

## 9. Testy

Dodaj `src/<connector>-*.spec.ts` lub testy w `src/server-<name>.ts`:

- Test kontraktowy: `Input.parse({ /* fixture */ })` round-trips.
- Test auth: brak tokena → rzuca z użytecznym komunikatem.
- Test write-guard (jeśli mutujący): unset env → rzuca `WriteDeniedError`.

## 10. Prompts + Resources (opcjonalne, ale zalecane)

Każdy serwer może wystawić obok narzędzi również **MCP Prompts** (slash-commands) i **MCP Resources** (cached read-only docs). Oba są tanie do dodania i ratują tokeny.

- **Prompty** — preconfigured slash-commands w Copilot Chat. Dodaj `definePrompt({…})` do array `prompts` w `src/server-<name>.ts`. Dobry pierwszy prompt: `recent-issues` / `my-mrs` — assignment + last 7/14 days.
- **Resources** — write-once markdown w `templates/resources/<name>-<topic>.md` + `defineMarkdownResource({…})` do array `resources`. Dobry pierwszy resource: cheatsheet query language (JQL / CQL / GraphQL), guide do field mapping, lista typowych error codes upstream.

Wzorce pokazane w istniejących serwerach (`src/server-jira.ts`, `src/server-confluence.ts`). Pełna sekcja README → "MCP Resources — preconfigured docs context".

## 11. Udokumentuj konektor

- Dodaj wiersz do tabeli konektorów w [`README.md`](../../README.md).
- Jeśli dodałeś prompts / resources — wpisz je do tabel "MCP Prompts" / "MCP Resources" w README.
- Jeśli upstream używa niestandardowego nagłówka auth, wskaż to w sekcji
  konfiguracji.

## 12. Verify

```bash
npm run verify   # format + lint + typecheck + test + build + ai:validate
```

Otwórz PR.

## Cross-cutting — czego NIE zapomnieć

- ❌ Nie dodawaj `axios` — patrz [ADR-0005](../adr/0005-native-fetch-no-axios.md).
  Używaj `http.request()` (wrapper natywnego fetch).
- ❌ Nie pisz do stdout — MCP to posiada. Używaj logger z `src/shared/log.ts`.
- ❌ Nie czytaj tokenów z innego miejsca niż env / user-profile config —
  patrz [ADR-0004](../adr/0004-token-env-only.md).
- ❌ Nie mutuj bez `assertWriteAllowed` — patrz [ADR-0003](../adr/0003-write-guard-runtime.md).
