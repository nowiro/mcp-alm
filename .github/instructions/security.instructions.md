---
applyTo: '**'
description: Reguły bezpieczeństwa — aplikują się do każdego pliku. Tokeny, write-guard, SSRF, supply chain.
---

# Reguły bezpieczeństwa — mcp-alm

Ładowane dla każdej edycji i przy review. **Nienegocjowalne** — odzwierciedlają to, co kontrole w `src/shared/` faktycznie wymuszają w runtime.

## 1. Sekrety

- **Nigdy** w source code (`*.ts`, `*.mjs`, `*.json`), `.github/`, `.vscode/`, `.idea/`, commit messages, opisach PR / ADR, ani test fixtures.
- Prawdziwe tokeny w **jednym z dwóch miejsc:**
  1. Env vars (`JIRA_TOKEN`, `CONFLUENCE_TOKEN`, `FIGMA_TOKEN`, `SONAR_TOKEN`, `GITLAB_TOKEN` + sibling `*_BASE_URL` / `*_EMAIL`).
  2. `~/.config/mcp-alm/config.json` (POSIX `0600`).
- `config.example.json` zawiera **wyłącznie** placeholdery `PASTE_YOUR_…` — każda zmiana na realny token blokowana w review.
- `.gitignore` blokuje `/config.json`, `.env*`, `*.secret.*`, `.config/`, `secrets/`.

## 2. Walidacja inputu

- Każde narzędzie deklaruje Zod schema. Handler dostaje **sparsowaną** wartość; nigdy nie dotyka `unknown` z wire.
- URL upstream budowane z walidowanego `baseUrl` + structural `path` — nigdy concat user-supplied bez Zod regex (`IssueKey`, `ProjectKey` patterns w [`server-jira.ts`](../../src/server-jira.ts)).
- JQL / CQL fragmenty quote-escaped + lint-checked przez [`jql-builder.ts`](../../src/shared/jql-builder.ts), [`confluence-cql.ts`](../../src/shared/confluence-cql.ts).

## 3. Output (logi + odpowiedzi)

- Logi → **stderr** w JSON-line przez [`log.ts`](../../src/shared/log.ts). Stdout = transport MCP, pisanie zabija proces.
- Logger redaktuje klucze matching `authorization`, `cookie`, `token`, `*-token`, `apikey`, `*-key`, `password`, `secret`, `x-figma-token`. Defence in depth — auth header konstruowany out of band w `http-client.ts` i nigdy nie wchodzi w log payload.
- Tool responses przez `{ data, _meta }` envelope ([`mcp-server.ts`](../../src/shared/mcp-server.ts)). `_meta` zawiera correlation id, server/tool, version, durationMs, tokensEstimate, opt. rateLimit. **Tokeny nigdy w `_meta` ani `data`.**

## 4. SSRF + proxy

- Outbound HTTP przez [`http-client.ts`](../../src/shared/http-client.ts). Odmawia loopback / RFC1918 / link-local / IPv6 ULA chyba że `MCP_ALM_ALLOW_PRIVATE_HOSTS=true` (jawnie dla on-prem upstreams).
- Honoruje `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` natywnie przez undici `ProxyAgent` (lazy-loaded, non-proxied envs = zero cost).
- `MCP_ALM_DISABLE_PROXY=true` wymusza direct connection (corporate system-wide proxy bypass).
- `NODE_EXTRA_CA_CERTS` dla prywatnego root CA; `npm run doctor` waliduje plik.

## 5. Write-guard (trzy tiery)

**Tier 1 — Mutujące** (`create_*`, `add_*`, `update_*`, `transition_*`, `link_*`, `merge_*`):

- Rejestrują się warunkowo na `isWriteEnabled()`.
- Pierwsza instrukcja handlera: `assertWriteAllowed(toolName)`.

**Tier 2 — Destruktywne** (`delete_*`, `remove_*`, `drop_*`, anything losing data) **dodatkowo:**

- `assertDestructiveAllowed(toolName, input.confirmToken)` — confirm token compare `crypto.timingSafeEqual`, ≥ 16 znaków.
- **Fetchują nazwę zasobu** jednym upstream GET → `assertResourceConfirmation(toolName, actualName, input.confirmResourceName)`. Agent echo'wuje nazwę dokładnie (case-sensitive, bez trim). Chroni przed wrong-resource delete'em nawet gdy `confirmToken` poprawny.

**Defaulty: deny-deny-deny** — brak env vars / brak nazwy = żadne destruktywne się nie uruchomi.

Pełne wyjaśnienie: [`write-guard.md`](../../docs/explanation/write-guard.md) + [ADR-0003](../../docs/adr/0003-write-guard-runtime.md), [ADR-0006](../../docs/adr/0006-resource-name-confirmation.md).

## 6. Zależności

- `npm ci` wymuszone w CI.
- `npm run audit:prod` (`--omit=dev --audit-level=high`) biegnie na każdym PR — high findings blokują merge do upgrade'u / pinu w `overrides`.
- Nowe deps wymagają uzasadnienia w PR (dlaczego, jakie alternatywy, jaka surface). Preferuj zero-dep > one-dep, native > polyfill.
- Lockfile committed; lockfile-only updates wymagają human review.

## 7. AI-specific

- Każdy output modelu = **niezaufany tekst**. Mutujące wywołania narzędzia wymagają explicite zatwierdzonego env (write-guard). Host (VS Code / IntelliJ) dostarcza UI per-tool approval.
- Argumenty inputu od LLM → Zod validation przed side-effectem. Bez wyjątków.
- **Nie dodawaj memory MCP server** (ani żadnego persystującego dane na dysku) do domyślnego `.mcp.json`. Opt-in flow w [`enterprise-intranet.md`](../../docs/getting-started/enterprise-intranet.md) dla zespołów których polityka pozwala.

## 8. Zgłaszanie

Podejrzewana podatność → private disclosure flow w [`SECURITY.md`](../../SECURITY.md). Nigdy publicznego issue.
