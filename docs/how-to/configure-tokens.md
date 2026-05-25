# Jak: konfigurować tokeny

> Skąd bierze się każdy token i jak go zaskoupować zgodnie z least privilege.

Pełna lista env vars: [`reference/configuration.md`](../reference/configuration.md).
Ten przepis skupia się na _ludzkich_ krokach uzyskania i zaskoupowania
każdego tokena.

Wszystkie URL-e platform (`*_BASE_URL`) są konfigurowalne — to ten sam
mechanizm dla Cloud (Atlassian Cloud, SonarCloud, gitlab.com) i self-hosted
(Jira Data Center, GitLab on-prem, SonarQube on-prem). Kolejność precedensu:
**env var → `~/.config/mcp-alm/config.json` → default** (tylko Figma/GitLab
mają default na publiczną chmurę; Jira/Confluence/Sonar wymagają explicit
URL — rzucają `AuthError` przy braku).

## Atlassian (Jira + Confluence)

Ten sam API token działa dla obu produktów w tym samym koncie Atlassian
Cloud.

1. Otwórz <https://id.atlassian.com/manage-profile/security/api-tokens>.
2. Kliknij **Create API token**. Zatytułuj `mcp-alm/<your-machine>`.
3. Skopiuj token (drugi raz go nie zobaczysz).
4. Eksport:

   ```bash
   export JIRA_BASE_URL=https://<your-domain>.atlassian.net
   export JIRA_EMAIL=<your-account-email>
   export JIRA_TOKEN=<paste>
   export CONFLUENCE_BASE_URL=$JIRA_BASE_URL
   export CONFLUENCE_EMAIL=$JIRA_EMAIL
   export CONFLUENCE_TOKEN=$JIRA_TOKEN
   ```

5. **Scope** jest per-user — token dziedziczy uprawnienia konta. Gdzie
   możliwe, używaj service account.

## Figma

Figma używa personal access token wysyłanego jako `X-Figma-Token` (NIE
`Authorization: Bearer`).

1. Otwórz <https://www.figma.com/developers/api#access-tokens>.
2. Kliknij **Create new personal access token**. Zatytułuj
   `mcp-alm/<your-machine>`.
3. Wybierz minimalne scopes — dla użytku read-first wystarczy `file:read`.
4. Eksport:

   ```bash
   export FIGMA_TOKEN=<paste>
   ```

## SonarQube / SonarCloud

User token, generowany z profilu konta.

1. SonarQube: My Account → Security → Generate Tokens.
2. SonarCloud: <https://sonarcloud.io/account/security>.
3. Wybierz typ tokena **User**. Zatytułuj `mcp-alm`.
4. Eksport:

   ```bash
   export SONAR_BASE_URL=<your-sonar-url>      # np. https://sonarcloud.io lub https://sonar.your-org.com
   export SONAR_TOKEN=<paste>
   ```

## GitLab

1. Profile → Edit profile → Access Tokens (lub
   <https://gitlab.com/-/profile/personal_access_tokens>).
2. Nazwa `mcp-alm`, expiration 90 dni, scopes:
   - `read_api` — wymagane.
   - `api` — tylko jeśli planujesz używać mutujących narzędzi.
   - Inne scopes — zostaw niezaznaczone.

3. Eksport:

   ```bash
   export GITLAB_TOKEN=<paste>
   # Self-hosted:
   export GITLAB_BASE_URL=https://gitlab.example.com/api/v4
   ```

## Gdzie umieścić komendy eksportu

| Powierzchnia                                         | Rekomendacja                                                                                                            |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Lokalny rozwój                                       | `~/.env.local` sourced ze shell rc. Nigdy nie commituj.                                                                 |
| Plik user-profile                                    | `~/.config/mcp-alm/config.json` (`chmod 600` na POSIX). Najprostsza opcja długoterminowa — przeżywa restarty terminala. |
| Host MCP (VS Code, IntelliJ, Claude Desktop, Cursor) | Per-server blok `env` w konfiguracji hosta — patrz [quickstart §7](../getting-started/quickstart.md#7-wiring-do-ide).   |
| CI / shared runner                                   | Secrets manager platformy hostingowej. Nigdy nie wklejaj realnego tokena w YAML.                                        |
| Headless serwer                                      | Container env z eksportu secrets-managera w czasie startu.                                                              |

## Rotacja

- Ustaw przypomnienie w kalendarzu na expiry tokena — większość dostawców
  domyśla 90 dni.
- Przy rotacji najpierw wygeneruj nowy token, podmień env, zrestartuj
  serwer, potem unieważnij stary.
- Unieważniony token surfacuje jako `AuthError(-32001)`. Patrz
  [kody błędów](../reference/error-codes.md).

## Co zrobić, gdy token wyciekł

1. **Natychmiast unieważnij** u upstream provider.
2. Sprawdź upstream audit log pod kątem nieautoryzowanej aktywności w oknie
   wycieku.
3. Zrotuj każdy inny token, który dzieli blast radius z wyciekłym credentialem.
4. Złóż [security report](../../SECURITY.md) — nawet self-inflicted leaki
   pomagają nam poprawić guardrails.
