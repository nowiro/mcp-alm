# Deployment enterprise / intranet

> Przepisy uruchamiania mcp-alm w sieci korporacyjnej: proxy, prywatne CA,
> instalacja air-gapped, DLP, trwały audit log. Przykłady zakładają typowy
> polski / EU stack korporacyjny (squid / Forcepoint, prywatne root CA,
> Jira Data Center on-prem, GitLab self-hosted, SonarQube on-prem).

## TL;DR

| Problem                                                 | Mechanizm w mcp-alm                                                                     | Gdzie czytać dalej                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------- |
| Proxy korporacyjne                                      | `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` honorowane natywnie (undici `ProxyAgent`)       | [§1](#1-proxy-korporacyjne)                  |
| Prywatne root CA                                        | env var `NODE_EXTRA_CA_CERTS`, walidowane przez `npm run doctor`                        | [§2](#2-prywatne-root-ca)                    |
| Self-hosted ALM (Jira DC, GitLab, SonarQube) na RFC1918 | `MCP_ALM_ALLOW_PRIVATE_HOSTS=true` otwiera SSRF guard                                   | [§3](#3-self-hosted-upstreams-na-rfc1918)    |
| Instalacja air-gapped                                   | `npm ci --offline` przeciw lokalnemu mirrorowi rejestru; lockfile committed             | [§4](#4-instalacja-air-gapped)               |
| Outbound DLP                                            | Blokuj na egress proxy; mcp-alm emituje `X-MCP-Tool`, więc DLP może targetować polityki | [§5](#5-outbound-dlp)                        |
| Trwały audit trail                                      | Przekaż stderr JSON logs do syslog / Splunk / Elastic                                   | [§6](#6-trwa%C5%82y-audit-trail)             |
| Memory MCP / internet docs MCP                          | Nie ma w domyślnym `.mcp.json` — udokumentowany opt-in poniżej                          | [§7](#7-memory-i-internet-docs-mcp---opt-in) |
| GDPR / RODO                                             | Brak telemetrii, brak phone-home; wszystkie dane zostają na maszynie developera         | [§8](#8-gdpr--rodo)                          |

## 1. Proxy korporacyjne

mcp-alm czyta standardowe env vars i routuje wszystkie żądania upstream
przez undici `ProxyAgent` (lazy-loaded — zero kosztu gdy proxy nie jest
ustawione).

```sh
# Linux / macOS
export HTTPS_PROXY=http://proxy.your-org.com:8080
export HTTP_PROXY=http://proxy.your-org.com:8080
export NO_PROXY=localhost,127.0.0.1,.your-org.internal,.atlassian.net

# Windows PowerShell
$env:HTTPS_PROXY = "http://proxy.your-org.com:8080"
$env:HTTP_PROXY  = "http://proxy.your-org.com:8080"
$env:NO_PROXY    = "localhost,127.0.0.1,.your-org.internal,.atlassian.net"
```

`NO_PROXY` to CSV. Wiodąca kropka to suffix match — `.your-org.internal`
matchuje zarówno `jira.your-org.internal` jak i `your-org.internal`.

**Override per-proces:** `MCP_ALM_DISABLE_PROXY=true` wymusza direct
connection nawet jeśli env proxy jest ustawione — przydatne dla local dev
przy aktywnym systemowym proxy korporacyjnym.

### Proxy z uwierzytelnianiem

undici `ProxyAgent` wspiera HTTP CONNECT z Basic auth w URL:

```sh
export HTTPS_PROXY=http://USER:PASS@proxy.your-org.com:8080
```

URL-encode hasło, jeśli zawiera znaki specjalne.

### Proxy NTLM / Kerberos

undici nie wspiera natywnie negocjacji NTLM ani Kerberos. Standardowy
workaround to **cntlm** (lub **px**) działający na `127.0.0.1:3128` i
relay'ujący:

```sh
# Install cntlm (Debian/Ubuntu)
sudo apt install cntlm
# Edytuj /etc/cntlm.conf z Twoim domain + NTLM hash
sudo systemctl restart cntlm
# Wskaż mcp-alm na lokalny relay
export HTTPS_PROXY=http://127.0.0.1:3128
export MCP_ALM_ALLOW_PRIVATE_HOSTS=true   # cntlm sam jest na loopback
```

### PAC / WPAD

Nie jest auto-wykrywane. Jeśli sieć korporacyjna używa WPAD, przepuść URL
WPAD przez narzędzie zwracające konkretny proxy (np. `pacparser`) i ustaw
`HTTPS_PROXY` z jego outputu.

## 2. Prywatne root CA

Atlassian Data Center, GitLab self-hosted, SonarQube on-prem — większość z
nich siedzi za TLS termination używającym Waszego korporacyjnego root CA.
Node domyślnie **nie** czyta OS trust store na Linuxie; wskaż mu bundle:

```sh
# Linux / macOS
export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/corporate-ca-bundle.pem

# Windows PowerShell
$env:NODE_EXTRA_CA_CERTS = "C:\certs\corporate-ca-bundle.pem"

# Walidacja:
npm run doctor          # → "CA bundle: <path> (N certs)" ✓
```

**Format:** plik to konkatenacja certyfikatów PEM (`-----BEGIN
CERTIFICATE----- … -----END CERTIFICATE-----`). Skleisz kilka roots zwykłym
`cat`.

**Gotcha:** ustaw `NODE_EXTRA_CA_CERTS` **przed** uruchomieniem `node`.
Mutowanie go po starcie procesu nie działa.

## 3. Self-hosted upstreams na RFC1918

SSRF guard mcp-alm odmawia wywołań upstream do loopback, RFC1918 (`10/8`,
`172.16/12`, `192.168/16`), link-local (`169.254/16`, `fe80::/10`) i IPv6
ULA (`fc00::/7`) domyślnie. Dla on-prem Jira / GitLab / SonarQube na
prywatnym VLAN:

```sh
export MCP_ALM_ALLOW_PRIVATE_HOSTS=true
```

To **opt-in**, nie default — chcemy, żeby operatorzy potwierdzili jawnie,
że on-prem endpoint jest zamierzony, a nie celem SSRF.

## 4. Instalacja air-gapped

Dwie ścieżki:

### A. Lokalny mirror rejestru (rekomendowane)

Jeśli Twoja organizacja prowadzi Verdaccio / Sonatype Nexus / JFrog
Artifactory:

```sh
npm config set registry https://registry.your-org.internal/npm/
npm ci
```

Lockfile pinuje dokładne URL-e tarballów (`registry.npmjs.org/...`); npm
przepisuje host, ale weryfikuje ten sam integrity hash, więc skompromitowany
mirror nie może podstawić złośliwego pakietu.

### B. Vendored snapshot `node_modules`

Przenieś `node_modules/` z maszyny połączonej:

```sh
# Na maszynie połączonej
npm ci
tar czf mcp-alm-deps.tgz node_modules

# Na maszynie air-gapped
tar xzf mcp-alm-deps.tgz
npm ci --offline    # lub: npm rebuild
```

Wtedy `npm run build` działa bez żadnej sieci.

## 5. Outbound DLP

mcp-alm sam nie wymusza DLP — to należy do egress proxy. Żeby pomóc DLP
targetować polityki, każde żądanie upstream niesie:

- `User-Agent: mcp-<server>/<version>`
- `X-MCP-Server: mcp-<server>`
- `X-MCP-Tool: <tool.name>` (np. `jira.add_comment`)
- `X-Request-ID: <uuid>`

Czyli reguła proxy w stylu "blokuj każdy POST którego `X-MCP-Tool` zaczyna
się od `*.add_*` lub `*.create_*`, jeśli destination domain jest na
watchlist" to jedna linia w typowym DLP engine.

Dla treści komentarzy konkretnie (najprawdopodobniejszy wektor przypadkowego
wklejenia sekretu), rozważ dodanie reguły body-inspection, która skanuje
wysoko-entropijne stringi przed opuszczeniem proxy.

## 6. Trwały audit trail

In-memory `sessionTracker` mcp-alm jest **per-proces** i **dropowany przy
restarcie**. Dla compliance (SOX, ISO 27001, wewnętrzne data governance),
persystuj stream stderr JSON logów.

### systemd

```ini
[Service]
ExecStart=/usr/local/lib/mcp-alm/server-jira.js
EnvironmentFile=/etc/mcp-alm/jira.env
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
StandardError=append:/var/log/mcp-alm/jira.jsonl
```

Następnie wysyłaj `/var/log/mcp-alm/*.jsonl` przez log shipper (Fluent Bit,
Vector, Filebeat) do Splunk / Elastic / Loki / Sumo. Każda linia to JSON z
`ts`, `server`, `tool`, `correlationId`, `durationMs`, `ok` plus opcjonalne
`error` — od razu kompatybilne ze strukturalnymi searchami.

### Linux desktop / dev workstation

```sh
node dist/server-jira.js 2>> ~/.local/state/mcp-alm/jira.jsonl
```

Rotuj przez `logrotate` (plik to append-only JSON-line, bezpieczny do
truncate po rotacji).

### Windows

```powershell
node dist\server-jira.js 2>> "$env:LOCALAPPDATA\mcp-alm\jira.jsonl"
```

## 7. Memory i internet-docs MCP — opt-in

Domyślny `.mcp.json` shipuje **tylko** pięć konektorów ALM. Dwa serwery MCP
powszechnie bundle'owane w innych projektach są tu świadomie **wyłączone**:

- `@modelcontextprotocol/server-memory` — persystuje kontekst agenta na
  dysku jako JSON. **Problem w korpo:** wszystko co agent przeczyta (Jira
  tickety, strony Confluence, fragmenty source code) ląduje plain-text na
  workstacji. Większość enterprise DLP zabrania tego.
- `@upstash/context7-mcp` — pobiera up-to-date framework docs z publicznego
  internetu. **Problem w korpo:** zależy od dostępności `context7.com` i
  dodaje punkt egress internet.

Jeśli Twoja polityka bezpieczeństwa jawnie pozwala, włącz je w **user-level**
MCP config (nie w `.mcp.json`):

```jsonc
// VS Code user settings → "mcp.servers" lub ~/.config/Code/User/settings.json
{
  "mcp.servers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-memory@<pinned-version>"],
      "env": {
        "MEMORY_FILE_PATH": "/some/path/encrypted-volume/memory.json",
      },
    },
  },
}
```

**Zapnij wersję** (nie używaj `@latest` w enterprise — supply-chain risk +
nieodtwarzalny setup). Udokumentuj wybór w README zespołu.

## 8. GDPR / RODO

- **Brak telemetrii, brak phone-home.** mcp-alm nie wywołuje żadnego URL
  innego niż skonfigurowany `baseUrl` upstream.
- **Brak persystencji danych.** Session ledger jest in-memory, dropowany
  przy exit. Jeśli włączysz trwały audit log (§6), dane żyją w Twoim
  log store pod Twoją retention policy.
- **Tokeny** to jedyne PII at rest. Żyją w `~/.config/mcp-alm/config.json`
  (`0600` na POSIX, default ACL na Windows). Rotuj przez upstream service;
  mcp-alm czyta plik w momencie żądania, więc restart pobiera nową wartość.

## Patrz też

- [`docs/explanation/security-architecture.md`](../explanation/security-architecture.md) — pełny katalog kontroli.
- [`vscode-setup.md`](vscode-setup.md) i [`intellij-setup.md`](intellij-setup.md) — przepisy IDE-specific z env vars w kontekście.
- [`reference/configuration.md`](../reference/configuration.md) — każda env var.
