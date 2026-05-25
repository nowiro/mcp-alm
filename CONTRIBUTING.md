# Contributing — mcp-alm

Cieszymy się, że chcesz pomóc. Ten dokument jest skróconą instrukcją dla
ludzi; reguły wymuszane na agentach LLM żyją w
[`AGENTS.md`](AGENTS.md) i [`.github/instructions/`](.github/instructions/) —
warto się zapoznać, bo opisują to samo, tylko bardziej formalnie.

## Zanim zaczniesz

- **Node 22+ wymagane.** Sprawdź `node --version`. Jeśli używasz nvm/fnm,
  jest `.nvmrc`.
- Repo jest celowo standalone. Nie ma orchestratora, nie ma backendu, nie
  ma submodułów — wszystko, czego potrzebujesz, jest w tym katalogu.
- Pakiet jest `"private": true`. Nie publikujemy na npm. Buildy
  dystrybuujemy przez `npm link` lub bezpośrednio `node dist/server-X.js`.

## Setup

```sh
git clone <repo-url>
cd mcp-alm
npm ci
npm run build
npm run doctor        # sprawdza config + dostęp do baseUrl
```

## Pętla deweloperska

```sh
npm test              # vitest run
npm run test:watch    # vitest --watch
npm run lint          # eslint . --max-warnings=0
npm run typecheck     # tsc --noEmit
npm run verify        # cała Definition of Done jednym strzałem
```

Do ręcznego testowania serwera bez IDE jest minimalny klient stdio:

```sh
node tools/scripts/dev-client.mjs jira              # lista narzędzi
node tools/scripts/dev-client.mjs jira jira.health '{}'   # call jednego narzędzia
```

## Conventional Commits

Wymuszane przez husky + commitlint. Format:

```
type(scope): subject

[optional body]

[optional footer]
```

- **type**: `feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert`
- **scope**: connector (`jira`, `confluence`, …) lub warstwa (`shared`, `auth`,
  `http`, `write-guard`, `log`, `errors`, `ci`, `deps`, `docs`, `release`,
  `security`)
- **subject**: zdanie, lower-case, < 70 znaków, w trybie rozkazującym

Przykłady:

- `feat(jira): add jira.get_sprint tool`
- `fix(http): retry 429 with jittered exponential backoff`
- `docs(security): document confirm-resource-name tier`

## Definition of Done (PR)

Przed otwarciem PR uruchom lokalnie:

```sh
npm run verify
```

Co przechodzi: format check · lint · typecheck · test · build · validate-ai-config.

PR template ([`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md))
ma kompletną checklistę bezpieczeństwa, którą trzeba zaznaczyć — to nie
jest teatr, te punkty często wyłapują regresje.

## Dodanie nowego narzędzia (tool)

1. Otwórz `src/server-<connector>.ts`.
2. Dodaj kolejny `defineTool({ name, description, inputSchema, handle })`.
3. Schema MUSI być `z.object({ … })` z restryktywnymi typami — bez `z.any()`.
4. Handler woła `http.request(...)` z `src/shared/http-client.ts` —
   nie używaj `fetch` bezpośrednio (omija SSRF guard / proxy / dedup).
5. Mutacje wołają `assertWriteAllowed(toolName)` jako pierwszą linię handlera.
6. Operacje destrukcyjne wołają również `assertDestructiveAllowed(toolName, confirmToken)`.
7. Dodaj test do najbliższego pliku `*.spec.ts` (lub stwórz nowy obok).
8. Zaktualizuj tabelę narzędzi w [`README.md`](README.md) i
   [`docs/reference/tools.md`](docs/reference/tools.md).

Szczegóły: [`docs/how-to/add-connector.md`](docs/how-to/add-connector.md).

## Dodanie nowego konektora (cały serwer)

Patrz [`docs/how-to/add-connector.md`](docs/how-to/add-connector.md) —
checklist + przykładowy diff.

Kluczowe punkty:

- Nowy `src/server-<tool>.ts` jako self-contained ESM entry.
- Wpis `bin` w [`package.json`](package.json).
- Wpis w [`.mcp.json`](.mcp.json) (dogfooding).
- Wpis w [`.vscode/mcp.json`](.vscode/mcp.json) i
  [`.idea/mcp-servers.example.xml`](.idea/mcp-servers.example.xml).
- ADR w [`docs/adr/`](docs/adr/) opisujący wybór endpoints / paginacji /
  reshape strategii.

## Bezpieczeństwo

- **Nigdy** nie commituj tokenów, kluczy, ciasteczek sesyjnych.
- **Nigdy** nie pisz do `stdout` z pliku serwera (`console.log` w
  `src/server-*.ts`) — stdout to transport MCP, uszkodzenie ramki zabija
  proces. Logi idą wyłącznie do `stderr` przez `createLogger`.
- Polityka pełna: [`SECURITY.md`](SECURITY.md) i
  [`docs/explanation/security-architecture.md`](docs/explanation/security-architecture.md).

## Code of Conduct

Patrz [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
