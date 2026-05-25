---
applyTo: '**'
description: Reguły bezpieczeństwa — aplikują się do każdego pliku w mcp-alm. Tokeny, write-guard, SSRF, supply chain.
---

# Reguły bezpieczeństwa — mcp-alm

Ten plik jest ładowany przez Copilota dla każdej edycji i przez ludzi
podczas review. Aplikuje się do **każdego pliku** w repo. Reguły są
nienegocjowalne i odzwierciedlają to, co kontrole w `src/shared/` faktycznie
wymuszają w runtime — nie pisz reguł sprzecznych z kodem i nie pisz kodu
sprzecznego z tymi regułami.

## 1. Sekrety

- **Nigdy** nie umieszczaj API tokens, OAuth secrets ani service-account
  credentials w:
  - source code (`*.ts`, `*.mjs`, `*.json`),
  - konfiguracji shipowanej w repo (`.github/`, `.vscode/`, `.idea/`),
  - commit messages, opisach PR, ani ADR-ach,
  - test fixtures.
- Prawdziwe tokeny żyją w **jednym z dwóch miejsc**:
  1. Process environment variable (`JIRA_TOKEN`, `CONFLUENCE_TOKEN`,
     `FIGMA_TOKEN`, `SONAR_TOKEN`, `GITLAB_TOKEN`, plus ich `*_BASE_URL` i
     `*_EMAIL` siblings).
  2. User-profile config file pod `~/.config/mcp-alm/config.json` (POSIX
     `0600`).
- `config.example.json` jest committed i musi zawierać **wyłącznie**
  placeholdery `PASTE_YOUR_…`. Każdy commit zmieniający go na realnie
  wyglądający token musi być zablokowany w review.
- `.gitignore` już blokuje `/config.json`, `.env*`, `*.secret.*`, oraz
  katalogi `.config/` i `secrets/` w root repo.

## 2. Walidacja inputu

- Każde narzędzie MCP deklaruje Zod schema dla inputu. Handlery narzędzi
  dostają **sparsowaną** wartość; nigdy nie dotykają `unknown` z wire.
- Każde URL upstream jest budowane z walidowanego `baseUrl` + strukturalnego
  `path` — nigdy ze string concatenation user-supplied wartości bez
  ograniczeń regex po stronie Zod (patrz wzorce `IssueKey` / `ProjectKey` w
  [`src/server-jira.ts`](../../src/server-jira.ts)).
- Fragmenty JQL / CQL budowane z inputów narzędzi są quote-escaped i
  lint-checked w [`src/shared/jql-builder.ts`](../../src/shared/jql-builder.ts)
  i [`src/shared/confluence-cql.ts`](../../src/shared/confluence-cql.ts).

## 3. Obsługa output (logi + odpowiedzi narzędzi)

- Wszystkie logi idą do **stderr** w formacie JSON-line przez
  [`src/shared/log.ts`](../../src/shared/log.ts). Stdout to transport MCP
  — pisanie do niego uszkadza ramkę JSON-RPC i zabija proces.
- Logger rekursywnie redaktuje wartości pod kluczami matching
  `authorization`, `cookie`, `token`, `*-token`, `apikey`, `*-key`,
  `password`, `secret`, `x-figma-token`. To defence in depth — auth header
  jest konstruowany out of band w `http-client.ts` i nigdy nie wchodzi w
  payload logu.
- Odpowiedzi narzędzi idą przez envelope `{ data, _meta }` budowany w
  [`src/shared/mcp-server.ts`](../../src/shared/mcp-server.ts). `_meta`
  zawiera correlation id, server / tool name, version, durationMs,
  tokensEstimate, opcjonalny rateLimit snapshot. **Tokeny nigdy nie
  pojawiają się w `_meta` ani `data`.**

## 4. SSRF i proxy

- Wychodzący HTTP idzie przez
  [`src/shared/http-client.ts`](../../src/shared/http-client.ts). Odmawia
  loopback, RFC1918, link-local i IPv6 ULA hosts, chyba że
  `MCP_ALM_ALLOW_PRIVATE_HOSTS=true` (set jawnie dla on-prem upstreams).
- HTTP client honoruje `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` natywnie
  przez undici `ProxyAgent`, lazy-loaded — non-proxied envs pay zero cost.
- `MCP_ALM_DISABLE_PROXY=true` wymusza direct connection nawet gdy proxy
  env vars są ustawione (przydatne dla local dev z corporate system-wide
  proxy).
- `NODE_EXTRA_CA_CERTS` to wspierany sposób dodania prywatnego root CA;
  `npm run doctor` waliduje zawartość pliku.

## 5. Write guard (trzy tiery)

- Mutujące narzędzia (`create_*`, `add_*`, `update_*`, `transition_*`,
  `link_*`, `merge_*`) muszą:
  - rejestrować się warunkowo na `isWriteEnabled()`,
  - wołać `assertWriteAllowed(toolName)` jako pierwszą instrukcję handlera.
- Destruktywne narzędzia (`delete_*`, `remove_*`, `drop_*`, cokolwiek
  tracącego dane) muszą dodatkowo:
  - wołać `assertDestructiveAllowed(toolName, input.confirmToken)` —
    confirm token porównywany przez `crypto.timingSafeEqual`, ≥ 16 znaków;
  - **fetchować bieżącą nazwę zasobu** (page title, repo path, issue
    summary) jednym upstream GET, potem wołać
    `assertResourceConfirmation(toolName, actualName, input.confirmResourceName)`.
    Agent musi echo'wać nazwę dokładnie — case-sensitive, bez trimowania.
    Chroni przed wrong-resource delete'em nawet gdy `confirmToken` jest
    poprawny.
- Defaulty są **deny-deny-deny**: brak env vars / brak nazwy = żadne
  destruktywne narzędzie się nie uruchomi.
- Pełne wyjaśnienie patternu w
  [`docs/explanation/write-guard.md`](../../docs/explanation/write-guard.md)
  - ADR [`0003`](../../docs/adr/0003-write-guard-runtime.md) i
    [`0006`](../../docs/adr/0006-resource-name-confirmation.md).

## 6. Zależności

- `npm ci` wymuszone w CI.
- `npm run audit:prod` (`npm audit --omit=dev --audit-level=high`) biegnie
  w CI na każdym PR; high findings blokują merge do upgrade'u lub pinu w
  `package.json#overrides`.
- Nowe zależności wymagają krótkiego uzasadnienia w opisie PR: dlaczego ta
  biblioteka, jakie alternatywy rozważone, jaką powierzchnię dodaje.
  Preferuj zero-dep nad one-dep, native API nad polyfill.
- Lockfile jest committed; lockfile-only updates wymagają human review.

## 7. AI-specific

- Traktuj każdy output modelu jako **niezaufany tekst**. Gdy agent sugeruje
  mutujące wywołanie narzędzia, użytkownik musi explicite zatwierdzić env
  vars write-guarda; host (VS Code / IntelliJ) dostarcza UI per-tool
  approval.
- Argumenty inputu narzędzia, które przychodzą od LLM, są walidowane przez
  Zod przed jakimkolwiek side effectem — bez wyjątków, włącznie z "schema
  jest oczywista".
- Nie dodawaj memory MCP server (ani żadnego serwera persystującego dane
  na dysku) do domyślnego `.mcp.json`. Takie serwery są udokumentowane jako
  opt-in w [`docs/getting-started/enterprise-intranet.md`](../../docs/getting-started/enterprise-intranet.md)
  dla zespołów, których polityka jawnie pozwala.

## 8. Zgłaszanie

- Podejrzewana podatność → użyj private disclosure flow w
  [`SECURITY.md`](../../SECURITY.md). Nie otwieraj publicznego issue.
