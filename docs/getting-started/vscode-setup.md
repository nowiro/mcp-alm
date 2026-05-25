# Konfiguracja VS Code (≥ 1.121)

> Natywne wsparcie MCP — nie potrzeba żadnego dodatkowego rozszerzenia
> ponad GitHub Copilot.

VS Code dostarczył pierwszorzędne wsparcie MCP w 1.99 i dopracował UX
(per-tool approval dialogs, server reload, secret inputs) do 1.121. mcp-alm
shipuje [`.vscode/mcp.json`](../../.vscode/mcp.json) używając natywnego
schematu VS Code — nie musisz kopiować definicji serwerów do User Settings.

## Wymagania

- **VS Code 1.121+**.
- Rozszerzenia **GitHub Copilot** + **GitHub Copilot Chat** zainstalowane i
  zalogowane.
- mcp-alm zbudowany lokalnie — `npm install && npm run build`.
- Tokeny w `~/.config/mcp-alm/config.json` (patrz
  [`how-to/configure-tokens.md`](../how-to/configure-tokens.md)).

## Krok po kroku

1. Otwórz repo w VS Code (`code .`).
2. Przy pierwszym otwarciu workspace, VS Code pokaże prompt **"This
   workspace contains MCP server definitions in `.vscode/mcp.json`. Trust
   the author?"** — wybierz **Trust**.
3. Otwórz **Copilot Chat** (`Ctrl/Cmd+Alt+I`).
4. Wpisz `/mcp.listServers`. Powinieneś zobaczyć pięć wpisów `alm-*` (jira,
   confluence, figma, sonar, gitlab).
5. Dla każdego serwera kliknij **Allow** gdy pojawi się prompt
   uruchomienia. Status zmienia się na **Running** a narzędzia serwera
   zaczynają pojawiać się w tool pickerze.
6. Pierwszy prompt inputu `mcp-write-enabled` pyta, czy włączyć narzędzia
   zapisu dla tego workspace. Default to **false** — zostaw tak, dopóki
   faktycznie nie potrzebujesz mutować Jira / Confluence / GitLab z IDE.

## Włączanie narzędzi zapisu (ostrożnie)

Mutujące narzędzia (`create_issue`, `add_comment`, `transition_issue`,
`merge_mr`, …) wymagają **obu**:

- `MCP_WRITE_ENABLED=true` (master switch — kontrolowany przez input
  `mcp-write-enabled` w `.vscode/mcp.json`).
- `MCP_WRITE_ALLOWLIST=<dokładna.nazwa.narzędzia>` listujący każde narzędzie,
  które chcesz dopuścić.

Żeby ustawić allowlist per workspace, edytuj `.vscode/mcp.json` i dodaj do
odpowiedniego bloku `env`, np.:

```jsonc
{
  "servers": {
    "alm-jira": {
      "type": "stdio",
      "command": "node",
      "args": ["${workspaceFolder}/dist/server-jira.js"],
      "env": {
        "MCP_WRITE_ENABLED": "${input:mcp-write-enabled}",
        "MCP_WRITE_ALLOWLIST": "jira.add_comment,jira.transition_issue",
      },
    },
  },
}
```

Przeładuj serwery (Copilot Chat → `/mcp.reloadServers`). Per-call approval
nadal jest wymuszany przez UI per-tool approval w VS Code przy pierwszym
wywołaniu każdego narzędzia — możesz wybrać **Allow Always** dla narzędzi
odczytu, ale zostaw narzędzia zapisu na **Allow Once**.

## Polityka per-tool approval

VS Code 1.99+ zapamiętuje per-tool approval per workspace. Rekomendowane
defaulty:

| Kategoria narzędzia                                                                    | Rekomendowana polityka                             |
| -------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `*.health`, `*.list_*`, `*.get_*`, `*.search_*`, `*.bulk_get_*`, `*.approximate_count` | Allow Always                                       |
| `*.add_comment`, `*.add_worklog`                                                       | Allow Once (zatwierdzaj każde wywołanie)           |
| `*.create_issue`, `*.create_pr`, `*.update_page`, `*.transition_*`, `*.link_*`         | Allow Once + double-check                          |
| `*.delete_*`, `*.merge_*`                                                              | Allow Once + wymagaj destruktywnego `confirmToken` |

VS Code pokazuje "diff preview" dla narzędzi zwracających dane strukturalne;
użyj go, żeby sprawdzić co Copilot zaraz wyśle do upstream przed
zatwierdzeniem.

## Ustawienia już wpięte w `.vscode/settings.json`

```jsonc
{
  "github.copilot.chat.codeGeneration.useInstructionFiles": true,
  "chat.promptFiles": true,
  "chat.promptFilesLocations": { ".github/prompts": true },
  "chat.instructionsFilesLocations": { ".github/instructions": true },
}
```

Mówią Copilot Chatowi, żeby załadował powierzchnie `.github/{instructions,prompts}/`.
Z nimi włączonymi, otwarcie chatu automatycznie pobiera reguły z
[`.github/copilot-instructions.md`](../../.github/copilot-instructions.md).

## Troubleshooting

### "Server failed to start: ENOENT node"

Upewnij się, że `node` jest na PATH, z którym VS Code się uruchamia. Na
macOS, jeśli zainstalowałeś Node przez Homebrew lub version manager,
uruchamiaj VS Code z shella (`code .`), żeby dziedziczył PATH; albo ustaw
explicite `terminal.integrated.env.osx`.

### Serwer pokazuje "Running" ale narzędzi brak

Uruchom `node dist/server-jira.js` z terminala i wyślij `tools/list`:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/server-jira.js
```

Jeśli odpowiedź jest pusta, build jest stary — uruchom `npm run build` i
przeładuj serwery.

### "AuthError: Missing jira secret"

Tokeny nie są tam, gdzie serwer się ich spodziewa. Uruchom `npm run doctor`,
napraw czerwone wpisy, przeładuj serwer.

### Dialog Workspace Trust nigdy się nie pokazuje

Workspace trust jest globalny per ścieżka workspace. Jeśli wcześniej
wybrałeś **Don't Trust**, plik jest po cichu ignorowany. Włącz ponownie
przez Command Palette → "Workspaces: Manage Workspace Trust".

### Proxy korporacyjne / prywatne CA

VS Code czyta swoje proxy z `http.proxy` — ale uruchamiane serwery MCP
czytają standardowe env vars `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`.
Ustaw je w shellu rc (żeby VS Code uruchamiany przez `code .` je
odziedziczył) lub w bloku `env` każdego wpisu serwera w `.vscode/mcp.json`.
Dla prywatnych CA ustaw też `NODE_EXTRA_CA_CERTS` (w tym samym miejscu).
Patrz [`enterprise-intranet.md`](enterprise-intranet.md).

## Patrz też

- [`enterprise-intranet.md`](enterprise-intranet.md) — proxy + CA bundle +
  instalacja air-gapped.
- [`intellij-setup.md`](intellij-setup.md) — odpowiednik dla IntelliJ.
- [`reference/configuration.md`](../reference/configuration.md) — każda env
  var, której serwery przestrzegają.
