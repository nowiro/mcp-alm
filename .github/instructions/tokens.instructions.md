---
applyTo: 'src/shared/{auth,http-client,user-config}.ts'
description: Polityka tokenów użytkownika — źródła, minimalizacja scope, never-log
---

# Polityka tokenów użytkownika

Serwery mcp-alm działają w imieniu **zalogowanego dewelopera**, nie shared service account. Każde wywołanie używa osobistego tokena API tej osoby.

## 1. Źródła w kolejności priorytetu

1. **Env vars** — `JIRA_TOKEN`, `CONFLUENCE_TOKEN`, `FIGMA_TOKEN`, `SONAR_TOKEN`, `GITLAB_TOKEN` + sibling `*_BASE_URL` / `*_EMAIL`. Wygrywa dla CI / kontenerów.
2. **User config** — `~/.config/mcp-alm/config.json` (Zod-validated, [`user-config.ts`](../../src/shared/user-config.ts)). Wygrywa dla local IDE.
3. **Throw `AuthError`** (`-32001`). Brak trzeciego fallback.

Boot bez tokenów nadal udaje się (rejestracja narzędzi); pierwsze wywołanie potrzebujące brakującego tokena rzuca z hintem env var.

## 2. Konwencja nazewnicza

| Konektor   | Env vars                                                                     |
| ---------- | ---------------------------------------------------------------------------- |
| Jira       | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`                                  |
| Confluence | `CONFLUENCE_BASE_URL`, `CONFLUENCE_EMAIL`, `CONFLUENCE_TOKEN`                |
| Figma      | `FIGMA_TOKEN` (opt. `FIGMA_BASE_URL`, default `https://api.figma.com`)       |
| Sonar      | `SONAR_BASE_URL`, `SONAR_TOKEN`                                              |
| GitLab     | `GITLAB_TOKEN` (opt. `GITLAB_BASE_URL`, default `https://gitlab.com/api/v4`) |

## 3. Minimalizacja scope

Najmniejszy możliwy scope per upstream:

- **Jira / Confluence** — `read:jira-work` / `read:content-details:confluence`. Write: `write:jira-work` / `write:confluence-content`.
- **Figma** — `file_content:read`.
- **Sonar** — `Browse` permission na projektach.
- **GitLab** — `read_api` + `read_repository` dla reads; `api` dla writes.

Szerszy scope wymaga uzasadnienia w PR.

## 4. Nigdy nie loguj tokena

[`http-client.ts`](../../src/shared/http-client.ts) buduje `Authorization` header out of band — nigdy nie wchodzi w payload logu. Defence in depth: [`log.ts`](../../src/shared/log.ts) rekursywnie redaktuje wartość klucza matching `authorization`, `*-token`, `*-key`, `password`, `secret`, `cookie`, `x-figma-token`.

Testy w [`log.spec.ts`](../../src/shared/log.spec.ts) asercją że komunikaty błędów nigdy nie zawierają tokena ani jego prefiksu / suffiksu.

## 5. Rotacja + Storage

- **Rotacja:** użytkownik rotuje upstream token, aktualizuje env / config, restartuje proces MCP. Playbook: [`security-architecture.md`](../../docs/explanation/security-architecture.md#rotacja-tokenów).
- ❌ Nigdy nie persystuj tokena do dysku w tym repo (brak `.env`, brak cache, brak commited JSON).
- ✅ User trzyma w OS keychain / password manager → export do env / wkleja w `~/.config/mcp-alm/config.json` (`chmod 600` na POSIX).
- ✅ Automatyzacja (jeśli kiedyś): token w secret store schedulera / CI → env w starcie procesu; nigdy w tracked file. (To repo nie używa GitHub Actions.)
