# Referencja konfiguracji

> Wszystkie env vars, których serwery przestrzegają, z defaultami i
> kolejnością precedensu.

## Jak rozstrzygana jest konfiguracja

1. **Process environment** (ustawione przy uruchamianiu `node
dist/server-*.js` lub przez konfigurację hosta MCP).
2. **User-profile config** (`~/.config/mcp-alm/config.json`,
   schema-validated przez Zod).
3. **Defaulty wkompilowane w binarkę** (lub `AuthError` dla wymaganych
   tokenów bez fallbacku).

Pierwsze źródło dostarczające non-empty wartość wygrywa. Serwery nigdy nie
czytają konfiguracji z argumentów ani stdin — to jest zarezerwowane dla
protokołu MCP.

## Wspólne (wszystkie serwery)

| Zmienna                                   | Default | Cel                                                                                                                                                                                 |
| ----------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                               | `info`  | Jedno z `trace` `debug` `info` `warn` `error` `fatal`. Logi idą do stderr (stdout jest zarezerwowany dla MCP).                                                                      |
| `MCP_ALM_HTTP_CONCURRENCY`                | `6`     | Maks współbieżne in-flight żądania upstream per HttpClient (per proces serwera). Zapobiega temu, że `extract` rozkręca 50 socketów na raz iterując strony. Min `1`.                 |
| `MCP_ALM_ALLOW_PRIVATE_HOSTS`             | unset   | Ustaw na `true` żeby obejść SSRF guard i pozwolić na wywołania upstream do `127.0.0.1` / RFC1918 / link-local. Używaj tylko dla local dev / self-hosted upstream na prywatnym VLAN. |
| `MCP_ALM_DISABLE_PROXY`                   | unset   | Ustaw na `true` żeby wymusić direct connection nawet gdy `HTTPS_PROXY` / `HTTP_PROXY` jest ustawione (np. lokalna praca przy aktywnym systemowym proxy korpo).                      |
| `MCP_ALM_CONFIG_DIR`                      | unset   | Override pełnej ścieżki katalogu user-profile config. Plik to `<dir>/config.json`. Bez tego: `$XDG_CONFIG_HOME/mcp-alm/config.json`, fallback `~/.config/mcp-alm/config.json`.      |
| `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` | unset   | Standardowe env vars proxy. Honorowane natywnie przez undici `ProxyAgent` (lazy-loaded).                                                                                            |
| `NODE_ENV`                                | unset   | Gdy `test`, domyślny `LOG_LEVEL` zmienia się na `trace` (ułatwia debug w vitest). Pomijaj w produkcji.                                                                              |
| `NODE_EXTRA_CA_CERTS`                     | unset   | Ścieżka do bundle PEM z prywatnymi root CA (dla self-signed certów upstream typu Jira Data Center / GitLab self-hosted). Walidowane przez `npm run doctor`.                         |
| `XDG_CONFIG_HOME`                         | unset   | POSIX-only fallback dla katalogu config. Bez `MCP_ALM_CONFIG_DIR`: ścieżka to `$XDG_CONFIG_HOME/mcp-alm/config.json`; ostateczny fallback `~/.config/mcp-alm/config.json`.          |

## Domyślne budżety token-cost

Dla nich nie ma env vars — żyją jako wkompilowane defaulty w schematach
narzędzi. Wywołujący nadpisują per-call przez udokumentowany parametr.

| Narzędzie                                    | Parametr       | Default           | Override                   |
| -------------------------------------------- | -------------- | ----------------- | -------------------------- |
| `jira.search_issues`, `jira.bulk_get_issues` | `budgetTokens` | `2 500`           | 500 – 80 000               |
| `jira.search_issues`, `jira.get_issue`       | `fields`       | system projection | tablica field id Jira      |
| `confluence.search_pages`                    | `budgetTokens` | `2 500`           | 500 – 80 000               |
| `confluence.get_page`                        | `maxChars`     | `5 000`           | 500 – 200 000              |
| `confluence.get_page`                        | `mode`         | `'full'`          | `'summary'`                |
| `gitlab.merge_request_changes`               | `include_diff` | `false`           | `true` żeby embedować diff |
| `gitlab.list_mrs`                            | `mode`         | `'full'`          | `'summary'`                |

In-memory session ledger (`*.get_usage_history`) ma hard cap 1 000 records
(FIFO eviction). Cap nie jest konfigurowalny — bound by design.

## Write-guard (trzypoziomowy)

| Zmienna                     | Używana przez | Notatki                                                                                                                                                                                                                                                                                                     |
| --------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MCP_WRITE_ENABLED`         | wszystkie     | `true` żeby pozwolić na mutujące narzędzia (POST / PATCH / PUT). Default `false`. Serwery rejestrują write tools tylko gdy to jest `true`.                                                                                                                                                                  |
| `MCP_WRITE_ALLOWLIST`       | wszystkie     | Comma-separated dokładne nazwy narzędzi, którym wolno mutować, np. `jira.create_issue,gitlab.create_mr`. **Pusta / nieustawiona allowlist odmawia każdemu write tool, nawet z `MCP_WRITE_ENABLED=true`**.                                                                                                   |
| `MCP_DESTRUCTIVE_ALLOWLIST` | wszystkie     | Comma-separated dokładne nazwy narzędzi destruktywnych (DELETE / drop). Muszą też być na `MCP_WRITE_ALLOWLIST`. Pusta = brak destruktywnych.                                                                                                                                                                |
| `MCP_DESTRUCTIVE_CONFIRM`   | wszystkie     | Shared-secret string, który wywołujący musi przekazać jako argument `confirmToken` do narzędzia destruktywnego. **Musi mieć ≥ 16 znaków** — krótsze secrety są odrzucane przez guard. Porównanie w stałym czasie (`crypto.timingSafeEqual`). Pusta / nieustawiona = każde wywołanie destruktywne odmawiane. |

### Tier 3 — potwierdzenie nazwy zasobu

Narzędzia destruktywne dodatkowo wymagają parametru `confirmResourceName`
w argumentach wywołania (nie env var — to per-call). Wartość musi dokładnie
matchować bieżącą nazwę zasobu (page title, repo path, issue summary),
**case-sensitive, bez trimowania**. Handler fetchuje zasób tuż przed
mutacją i porównuje przez `crypto.timingSafeEqual`. Mismatch →
`ConfirmationError` (`-32009`). Chroni przed wrong-resource delete'em
nawet gdy `confirmToken` jest poprawny.

Pełne wyjaśnienie: [`explanation/write-guard.md`](../explanation/write-guard.md#trzeci-poziom--potwierdzenie-nazwy-zasobu).

### Narzędzia diagnostyczne / dry-run

- Każde write tool akceptuje `dryRun: true` — zwraca skonstruowane request
  body (method + path + JSON) bez uderzania w upstream. Przydatne do
  inspekcji, co agent zaraz zrobi.
- Każdy serwer wystawia `<server>.health` — omija cache, woła tani upstream
  `/me` (lub równoważny) endpoint, zwraca `{ ok, durationMs }` plus
  identity-specific info. Używaj z CI żeby zweryfikować, że tokeny są
  nadal ważne.

## Jira (`server-jira.ts`)

| Zmienna         | Wymagana dla | Notatki                                                                         |
| --------------- | ------------ | ------------------------------------------------------------------------------- |
| `JIRA_BASE_URL` | wszystkie    | `https://<your-domain>.atlassian.net` (bez trailing slash) lub URL Data Center. |
| `JIRA_EMAIL`    | wszystkie    | Email konta Atlassian — używany jako user basic-auth.                           |
| `JIRA_TOKEN`    | wszystkie    | API token z <https://id.atlassian.com/manage-profile/security/api-tokens>.      |

## Confluence (`server-confluence.ts`)

| Zmienna               | Wymagana dla | Notatki                                                             |
| --------------------- | ------------ | ------------------------------------------------------------------- |
| `CONFLUENCE_BASE_URL` | wszystkie    | Domena Atlassian zakończona na `/wiki` (Cloud) lub URL Data Center. |
| `CONFLUENCE_EMAIL`    | wszystkie    | Tak samo jak `JIRA_EMAIL` jeśli shared account.                     |
| `CONFLUENCE_TOKEN`    | wszystkie    | Re-używa API token Atlassian — ta sama wartość co `JIRA_TOKEN`.     |

## Figma (`server-figma.ts`)

| Zmienna          | Wymagana dla | Notatki                                                                              |
| ---------------- | ------------ | ------------------------------------------------------------------------------------ |
| `FIGMA_TOKEN`    | wszystkie    | Personal access token. Wysyłany jako nagłówek `X-Figma-Token` (NIE `Authorization`). |
| `FIGMA_BASE_URL` | opcjonalna   | Default `https://api.figma.com`.                                                     |

## Sonar (`server-sonar.ts`)

| Zmienna          | Wymagana dla | Notatki                                         |
| ---------------- | ------------ | ----------------------------------------------- |
| `SONAR_BASE_URL` | wszystkie    | URL SonarQube / SonarCloud.                     |
| `SONAR_TOKEN`    | wszystkie    | User token z SonarQube → My Account → Security. |

## GitLab (`server-gitlab.ts`)

| Zmienna           | Wymagana dla | Notatki                                                                                               |
| ----------------- | ------------ | ----------------------------------------------------------------------------------------------------- |
| `GITLAB_TOKEN`    | wszystkie    | Personal access token. Rekomendowany scope: `read_api`. Dodaj `api` tylko jeśli włączasz write tools. |
| `GITLAB_BASE_URL` | opcjonalna   | Default `https://gitlab.com/api/v4`. Ustaw dla self-hosted (kończy na `/api/v4`).                     |

## Worked example: minimalny setup tylko Jira

```bash
JIRA_BASE_URL=https://my-org.atlassian.net \
JIRA_EMAIL=alice@example.com \
JIRA_TOKEN=ATATT3xFfGF... \
node dist/server-jira.js
```

Żeby włączyć tworzenie issue:

```bash
MCP_WRITE_ENABLED=true \
MCP_WRITE_ALLOWLIST=jira.create_issue \
JIRA_BASE_URL=... \
JIRA_EMAIL=... \
JIRA_TOKEN=... \
node dist/server-jira.js
```

## Skrócona referencja precedensu

```
explicit env var > user-profile config (~/.config/mcp-alm/config.json) > compiled default
```

**Nie ma** override przez argument narzędzia. Konfiguracja jest
process-scoped świadomie — to robi model bezpieczeństwa audytowalnym.

## Powiązane

- [Quickstart](../getting-started/quickstart.md) — te same env vars w
  kontekście.
- [Wzorzec write-guard](../explanation/write-guard.md) — co `MCP_WRITE_*`
  faktycznie robi.
- [Architektura bezpieczeństwa](../explanation/security-architecture.md) —
  dlaczego tokeny są env-only.
