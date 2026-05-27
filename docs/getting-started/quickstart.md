# Quickstart

> Install, build, uruchom jeden serwer MCP, wywołaj `tools/list`. Około 10
> minut.

## Wymagania

- **Node.js 22+** — wymóg deklarowany przez `package.json#engines.node` (`>=22.0.0`). `npm ci` zatrzyma się jeśli wersja Node jest za niska.
- **npm 10+** — dostarczany razem z Node 22, nie wymaga osobnej instalacji.
- **Git 2.40+** — dla hooków i shallow-fetch w CI.

## 1. Clone + install

```sh
git clone https://github.com/nowiro/mcp-alm.git
cd mcp-alm
# opcjonalnie: nvm install 22 && nvm use 22
npm ci             # używa package-lock.json
```

`npm install` (lub `npm ci`) uruchamia też skrypt `prepare`, który instaluje
hooki husky `pre-commit` / `commit-msg` / `pre-push`.

## 2. Jednolinijkowy bootstrap

```sh
npm run bootstrap
```

Idempotentny i bezpieczny do ponownego uruchomienia. Robi:

- weryfikuje wersję Node,
- instaluje deps (pomija, jeśli `node_modules` już istnieje; `--reinstall`
  wymusza),
- instaluje hooki git,
- zasiewa user-profile config w `~/.config/mcp-alm/config.json` (tryb `0600`
  na POSIX) wypełniony placeholderami `PASTE_YOUR_…`.

## 3. Konfiguracja tokenów

Edytuj zasiany config i wklej prawdziwe tokeny. Sekcje, których nie używasz,
mogą zostać jako placeholdery lub być usunięte.

```sh
# macOS / Linux
$EDITOR ~/.config/mcp-alm/config.json
chmod 600 ~/.config/mcp-alm/config.json

# Windows (PowerShell)
notepad "$env:USERPROFILE\.config\mcp-alm\config.json"
```

Przepis per-upstream (URL, scopes, gdzie wygenerować token):
[`docs/how-to/configure-tokens.md`](../how-to/configure-tokens.md). Pełna
referencja env vars: [`docs/reference/configuration.md`](../reference/configuration.md).

Jeśli wolisz env vars zamiast pliku config, ustaw odpowiednie zmienne
(`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`, itd.) przed uruchomieniem
serwera — env zawsze wygrywa nad config file.

## 4. Build

```sh
npm run build
```

Produkuje `dist/server-{jira,confluence,figma,sonar,gitlab}.js`.

## 5. Weryfikacja setupu

```sh
npm run doctor
```

`doctor`:

- waliduje user-profile config względem schematu Zod,
- sprawdza kształt każdego `baseUrl` (Confluence musi zawierać `/wiki`,
  GitLab musi zawierać `/api/v4`, itd.),
- pinguje każdy skonfigurowany `baseUrl` żądaniem `HEAD` (timeout 5 s),
- jeśli ustawione `NODE_EXTRA_CA_CERTS`, parsuje plik i liczy certyfikaty.

Zielony ✓ wszędzie = gotowe. Żółty ⚠ = informacyjne. Czerwony ✗ = napraw
zanim ruszysz dalej.

## 6. Smoke-test serwera ręcznie

Każdy konektor to samodzielny binarny mówiący JSON-RPC po stdio. Uruchom
serwer Jira i wyślij `tools/list`:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server-jira.js
```

Spodziewane: odpowiedź JSON-RPC listująca wszystkie narzędzia Jira z ich
schematami wejścia.

## 7. Wiring do IDE

| IDE                                                           | Setup w jednej linii                                                                                                                                                                                  | Pełny przewodnik                         |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **VS Code** ≥ 1.121                                           | Repo ma już [`.vscode/mcp.json`](../../.vscode/mcp.json). Otwórz projekt; Copilot Chat → MCP: List Servers → Reload; zaakceptuj prompt zaufania.                                                      | [`vscode-setup.md`](vscode-setup.md)     |
| **IntelliJ IDEA** ≥ 2026.1.2                                  | Settings → Tools → AI Assistant → MCP → Import from file → wskaż [`.idea/mcp-servers.example.xml`](../../.idea/mcp-servers.example.xml); zamień `/absolute/path/to/mcp-alm` na realną ścieżkę; Apply. | [`intellij-setup.md`](intellij-setup.md) |
| **Inne hosty MCP** (Claude Desktop, Cursor, własny Agent SDK) | Wklej odpowiednie wpisy z [`.mcp.json`](../../.mcp.json) do konfiguracji hosta.                                                                                                                       | host-specific                            |

## 8. Intranet korporacyjny?

Jeśli jesteś za proxy, za prywatnym CA lub działasz w pełni air-gapped,
przeczytaj [`enterprise-intranet.md`](enterprise-intranet.md) — pokrywa
przepisy na proxy, `NODE_EXTRA_CA_CERTS`, offline install, DLP i trwałe
audit traile.

## Kolejne kroki

- [Wyjaśnienie: architektura](../explanation/architecture.md) — co jest z
  czym połączone.
- [Jak: dodać nowy konektor ALM](../how-to/add-connector.md).
- [Referencja: konfiguracja](../reference/configuration.md) — każda env var.
