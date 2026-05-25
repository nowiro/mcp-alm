# Konfiguracja IntelliJ IDEA (≥ 2026.1.2)

> Integracja MCP przez plugin **GitHub Copilot** i wbudowany
> **AI Assistant**. Oba pluginy czytają ten sam rejestr serwerów MCP od
> wersji 2026.1.2.

## Wymagania

- **IntelliJ IDEA 2026.1.2+** (Ultimate lub Community; AI Assistant wymaga
  odpowiedniej subskrypcji JetBrains AI, GitHub Copilot wymaga subskrypcji
  Copilot).
- **Plugin GitHub Copilot** (`GitHub Copilot` w marketplace JetBrains)
  zainstalowany i zalogowany, **lub** AI Assistant włączony.
- mcp-alm zbudowany lokalnie — `npm install && npm run build`.
- Tokeny w `~/.config/mcp-alm/config.json` (patrz
  [`how-to/configure-tokens.md`](../how-to/configure-tokens.md)).

## Krok po kroku

1. Otwórz `mcp-alm` w IntelliJ.
2. **Settings (Ctrl+Alt+S)** → **Tools** → **AI Assistant** → **Model Context
   Protocol** (lub **Settings → Languages & Frameworks → GitHub Copilot →
   MCP Servers**, zależnie od użytego pluginu).
3. Kliknij **Import from file…** i wskaż
   [`.idea/mcp-servers.example.xml`](../../.idea/mcp-servers.example.xml).
4. **Edytuj każdy wpis serwera** i zamień `/absolute/path/to/mcp-alm` na
   absolutną ścieżkę do Twojego klona (IntelliJ **nie** rozwija
   `${PROJECT_DIR}` w tej konfiguracji; ścieżki muszą być absolutne).
5. **Apply**.
6. Otwórz tool window **AI Assistant** (lub GitHub Copilot Chat). Pięć
   wpisów `alm-*` powinno pojawić się na liście narzędzi — każdy
   rozwijalny, żeby zobaczyć swoje narzędzia odczyt / zapis.

## Włączanie narzędzi zapisu

Edytuj blok `<env>` dla odpowiedniego serwera w panelu MCP settings
IntelliJ (lub w lokalnej kopii `.idea/mcp-servers.example.xml` po
imporcie). Dodaj:

```xml
<env>
  <entry key="MCP_WRITE_ENABLED" value="true"/>
  <entry key="MCP_WRITE_ALLOWLIST" value="jira.add_comment,jira.transition_issue"/>
</env>
```

Przeładuj serwer (Settings → MCP → kliknij refresh obok serwera). Nowo
włączone narzędzia zapisu pojawiają się w tool pickerze.

Dla narzędzi destruktywnych (`*.delete_*`, `*.merge_*` w tym repo) ustaw
też:

```xml
<entry key="MCP_DESTRUCTIVE_ALLOWLIST" value="..."/>
<entry key="MCP_DESTRUCTIVE_CONFIRM" value="a-secret-only-you-know-min-16-chars"/>
```

Wywołujący (AI Assistant) musi przekazać `confirmToken: "<that-secret>"` w
argumentach narzędzia. Porównanie jest w stałym czasie.

## Per-tool approval

IntelliJ AI Assistant pyta przy każdym wywołaniu narzędzia domyślnie.
Często używane narzędzia **odczytu** możesz oznaczyć "Always allow" przez
ten sam prompt; narzędzia **zapisu** powinny zostać na per-call approval.

## Wybór pluginu: GitHub Copilot vs AI Assistant

|                                         | Plugin GitHub Copilot             | JetBrains AI Assistant              |
| --------------------------------------- | --------------------------------- | ----------------------------------- |
| Wsparcie MCP                            | od późnej jesieni 2025            | od 2026.1                           |
| Płatność                                | subskrypcja GitHub Copilot        | subskrypcja JetBrains AI            |
| Slash commands                          | tak (`/help`, `/explain`, custom) | tak                                 |
| Czyta `.github/copilot-instructions.md` | **tak** (najwyższy priorytet)     | nie (używa własnego pliku ustawień) |

Dla najlepszych rezultatów z regułami w tym repo (które celują w mechanizm
instruction-files Copilota), **plugin GitHub Copilot** jest rekomendowany.

## Ustawienia poza panelem MCP

| Ustawienie                                                     | Wartość          | Dlaczego                                                                                              |
| -------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------- |
| Settings → GitHub Copilot → Chat → Use repository instructions | ✅               | Automatycznie pobiera `.github/copilot-instructions.md`.                                              |
| Settings → Build, Execution, Deployment → HTTP Proxy           | Use system proxy | Większość networking IntelliJ przechodzi przez to; serwery MCP czytają env vars osobno (patrz niżej). |

## Troubleshooting

### Panel MCP pokazuje serwer jako "Stopped" bez błędu

Otwórz **Help → Show Log in Finder/Explorer** i poszukaj w `idea.log` linii
zaczynających się od `[mcp]`. Najczęstsza przyczyna to zła absolutna
ścieżka — szablon ma `/absolute/path/to/mcp-alm` a IntelliJ tego nie
rozwija.

### "Server started but no tools listed"

Uruchom `node /absolute/path/to/mcp-alm/dist/server-jira.js` z terminala i
wyślij `tools/list`:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node /absolute/path/to/mcp-alm/dist/server-jira.js
```

Jeśli zwraca pustą tablicę lub błąd, build jest stary lub tokeny brakują.
Uruchom `npm run doctor`.

### "AuthError: Missing jira secret"

Serwer MCP (uruchomiony przez IntelliJ) nie odziedziczył Twojego shell env.
Dwie opcje:

- Dodaj odpowiednie tokeny do bloku `<env>` wpisu serwera w MCP settings
  IntelliJ (IntelliJ trzyma je zaszyfrowane w OS keychain).
- **Lub** wypełnij `~/.config/mcp-alm/config.json` i uruchom `npm run
doctor` — serwer czyta plik w momencie żądania, niezależnie od tego, jak
  został uruchomiony.

### Proxy korporacyjne / prywatne CA

Serwery MCP czytają `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` i
`NODE_EXTRA_CA_CERTS` ze **swojego** środowiska — ustawienie "Use system
proxy" IntelliJ aplikuje się tylko do samego IntelliJ. Dodaj env vars do
bloku `<env>` każdego wpisu `<server>` lub ustaw je na poziomie OS, żeby
IntelliJ je odziedziczył przy starcie. Patrz
[`enterprise-intranet.md`](enterprise-intranet.md).

### Konflikty między pluginem GitHub Copilot a AI Assistant

Jeśli oba pluginy są zainstalowane i zaimportowałeś te same serwery do
obu, każdy plugin spawnuje własny proces dziecięcy per serwer (= 10
procesów dla 5 serwerów). Wybierz jeden plugin do codziennego użytku i
wyłącz MCP w drugim, żeby uniknąć duplikacji.

## Patrz też

- [`vscode-setup.md`](vscode-setup.md) — odpowiednik dla VS Code.
- [`enterprise-intranet.md`](enterprise-intranet.md) — proxy + CA bundle +
  air-gapped install + DLP.
- [`reference/configuration.md`](../reference/configuration.md) — każda env
  var, której serwery przestrzegają.
