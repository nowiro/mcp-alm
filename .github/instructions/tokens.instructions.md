---
applyTo: 'src/shared/{auth,http-client,user-config}.ts'
description: Polityka tokenów użytkownika — źródła, minimalizacja scope, never-log
---

# Polityka tokenów użytkownika

Serwery mcp-alm działają w imieniu **zalogowanego ludzkiego developera**,
nie shared service account. Każde wywołanie narzędzia używa osobistego
tokena API tej osoby dla odpowiedniego upstream.

## 1. Źródła tokena w kolejności priorytetu

1. **Process environment variable** (`JIRA_TOKEN`, `CONFLUENCE_TOKEN`,
   `FIGMA_TOKEN`, `SONAR_TOKEN`, `GITLAB_TOKEN`, plus ich `*_BASE_URL` /
   `*_EMAIL` siblings gdzie applicable). Wygrywa dla CI, kontenerów i
   shell `export` flows.
2. **User-profile config file** (`~/.config/mcp-alm/config.json`,
   Zod-validated przez [`src/shared/user-config.ts`](../../src/shared/user-config.ts)).
   Wygrywa dla local IDE use — wklej raz, reuse cross sessions.
3. **Throw `AuthError`**. Nie ma trzeciego fallback. Nie ma default tokena,
   nigdy.

Boot bez tokenów nadal się udaje — serwery rejestrują narzędzia — ale
pierwsze wywołanie narzędzia, które potrzebuje brakującego tokena, zwraca
`AuthError` (`-32001`) z hintem wskazującym nazwę env var.

## 2. Konwencja nazewnicza

| Konektor               | Env vars                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------- |
| Jira                   | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`                                         |
| Confluence             | `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_TOKEN`                       |
| Figma                  | `FIGMA_TOKEN` (opcjonalnie `FIGMA_BASE_URL`, default `https://api.figma.com`)       |
| SonarQube / SonarCloud | `SONAR_BASE_URL`, `SONAR_TOKEN`                                                     |
| GitLab                 | `GITLAB_TOKEN` (opcjonalnie `GITLAB_BASE_URL`, default `https://gitlab.com/api/v4`) |

## 3. Minimalizacja scope

Używaj najmniejszego możliwego scope per upstream:

- **Jira / Confluence** — `read:jira-work` / `read:content-details:confluence`.
  Write tools chcą `write:jira-work` / `write:confluence-content`.
- **Figma** — `file_content:read`.
- **SonarQube** — `Browse` permission na projektach, które chcesz wystawić.
- **GitLab** — `read_api` + `read_repository` dla reads; `api` dla GitLab
  write tools.

Jeśli potrzebujesz szerszego scope, udokumentuj dlaczego w opisie PR.

## 4. Nigdy nie loguj tokena

[`src/shared/http-client.ts`](../../src/shared/http-client.ts) buduje
`Authorization` header out of band i przekazuje resztę żądania do loggera;
wartość auth nigdy nie wchodzi w payload logu. Jako defence in depth,
[`src/shared/log.ts`](../../src/shared/log.ts) też rekursywnie redaktuje
wartość każdego klucza matching `authorization`, `*-token`, `*-key`,
`password`, `secret`, `cookie`, `x-figma-token`.

Testy w [`src/shared/log.spec.ts`](../../src/shared/log.spec.ts) asercją że
komunikaty błędów nigdy nie zawierają ani literalnego tokena, ani jego
pierwszych / ostatnich 4 znaków.

## 5. Rotacja

Tokeny mają expiry. Serwer go nie tracku; użytkownik rotuje upstream
token, aktualizuje env / config, restartuje proces MCP. 3-stopniowy
playbook żyje w [`docs/explanation/security-architecture.md`](../../docs/explanation/security-architecture.md)
pod "Rotacja tokenów".

## 6. Storage

- ❌ Nigdy nie persystuj tokena do dysku wewnątrz tego repo (brak `.env`
  files, brak cache files, brak commited JSON).
- ✅ Użytkownik trzyma tokeny w OS keychain / password manager i albo
  eksportuje do env przy starcie shella, albo wkleja w
  `~/.config/mcp-alm/config.json` (`chmod 600` na POSIX).
- ✅ CI używa GitHub Actions repo secrets (lub equivalent w Twoim CI
  providerze). Secrets są wired w env przy starcie joba; proces czyta je
  przez path 1 powyżej.
