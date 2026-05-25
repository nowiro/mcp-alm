# Troubleshooting

Recipe-style. Najczęstsze failure modes — od najbardziej prawdopodobnych
do rzadkich. `npm run doctor` zazwyczaj wskazuje przyczynę pierwsze — jeśli
nie pomógł, zerknij niżej.

---

## "Authentication failed" / 401 / 403 z upstreamu

**Symptom:** wywołanie narzędzia kończy się błędem `-32001 AuthError`
albo `-32004 UpstreamError` z payload `{ status: 401 }` / `{ status: 403 }`.

**Diagnoza:**

```sh
npm run doctor
```

Doctor pokazuje czy token w ogóle jest załadowany. Jeśli `[ok] jira: token loaded`
ale upstream zwraca 401:

1. **Token wygasł** — Jira/Atlassian tokeny mają default 1 rok. GitLab i
   Sonar też mogą mieć ekspirację. Wygeneruj nowy, wklej do
   `~/.config/mcp-alm/config.json`.
2. **Token to nie API token, tylko hasło / session cookie** — Jira
   wymaga **API token**, nie hasła. Confluence to samo.
3. **Token nie ma uprawnień** do projektu/przestrzeni — sprawdź w UI
   Jira/GitLab/Sonar/Figma czy konto, dla którego token jest wystawiony,
   widzi zasób.
4. **`email` zamiast `username`** — Jira Cloud bierze e-mail, Data Center
   bierze username. Config ma pole `email`, ale dla DC wklejasz tam
   `username`.

**403 specyficzne:**

- Jira: konto może czytać issue, ale nie projekt — sprawdź scheme
  permissions w settings projektu.
- GitLab: token typu `read_repository` nie wystarcza do `list_issues`;
  potrzeba `read_api`.
- Sonar: użytkownik musi mieć `Browse` na projekcie.

---

## `npm run doctor` mówi "private host blocked"

**Symptom:**

```
[err] gitlab.baseUrl https://gitlab.internal.corp/api/v4 →
      private network host blocked by SSRF guard
      Set MCP_ALM_ALLOW_PRIVATE_HOSTS=true if intentional.
```

**Przyczyna:** SSRF guard w `http-client.ts` blokuje loopback / RFC1918 /
link-local domyślnie. Self-hosted Jira DC, GitLab self-hosted, SonarQube
on-prem często żyją na takich adresach.

**Fix:** ustaw env var **przed** startem serwera MCP (nie globalnie):

```jsonc
// .vscode/mcp.json (per-server)
{
  "command": "node",
  "args": ["./dist/server-gitlab.js"],
  "env": { "MCP_ALM_ALLOW_PRIVATE_HOSTS": "true" },
}
```

Dla IntelliJ — analogiczny blok w `mcp-servers.xml`.

**Nie** ustawiaj na poziomie shell (`export …`) — gdy ten env var jest
globalny dla wszystkich serwerów, łatwo zapomnieć i puścić publiczne SaaS
przez tę samą flagę.

---

## "self-signed certificate in certificate chain" / TLS errors

**Symptom:** błąd z node:tls, fetch failed, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

**Przyczyna:** korporacyjne MITM proxy podmienia certyfikat na private CA,
której Node nie zna.

**Fix:**

1. Wyeksportuj root CA korpo do pliku PEM (`corp-root.pem`).
2. Ustaw env var:

```jsonc
{ "env": { "NODE_EXTRA_CA_CERTS": "/absolute/path/to/corp-root.pem" } }
```

3. `npm run doctor` sprawdzi, czy bundle się ładuje (wypisze fingerprint
   pierwszego certu w bundle).

**NIE** używaj `NODE_TLS_REJECT_UNAUTHORIZED=0` — wyłącza wszystkie
weryfikacje TLS dla całego procesu, co otwiera MITM również na publiczne
SaaS-y.

---

## "EACCES" na `~/.config/mcp-alm/config.json`

**Symptom:** doctor mówi `[warn] config file permissions: 0644 (should be 0600)`.

**Fix (POSIX):**

```sh
chmod 600 ~/.config/mcp-alm/config.json
```

**Windows:** ACL — uprawnienia tylko dla bieżącego usera. PowerShell:

```ps1
icacls "$env:USERPROFILE\.config\mcp-alm\config.json" `
  /inheritance:r `
  /grant:r "${env:USERNAME}:F"
```

---

## Write tool zwraca `-32005 WriteDeniedError`

**Symptom:** `jira.create_issue` (lub inny write tool) odmawia z błędem
"write disabled" / "tool not on allowlist".

**Przyczyna:** write-guard jest deny-by-default. Wymaga DWÓCH env varów:

```jsonc
{
  "env": {
    "MCP_WRITE_ENABLED": "true",
    "MCP_WRITE_ALLOWLIST": "jira.create_issue,jira.add_comment",
  },
}
```

Lista jest **dokładnymi nazwami narzędzi**, przecinek-separated. Wildcard
(`jira.*`) nie jest wspierany — to świadoma decyzja, żeby allowlist była
audytowalna.

Dla destruktywnych: dodatkowo `MCP_DESTRUCTIVE_ALLOWLIST` +
`MCP_DESTRUCTIVE_CONFIRM` (16+ znaków). Patrz
[`docs/explanation/write-guard.md`](../explanation/write-guard.md).

---

## "stdout disrupted" / klient MCP rozłącza się od razu

**Symptom:** VS Code Copilot pokazuje "MCP server disconnected" zaraz po
boot.

**Przyczyna:** coś pisze do **stdout** z procesu serwera. Stdout to
transport MCP — każdy non-JSON bajt rozsynchronizowuje protokół.

**Diagnoza:** uruchom serwer ręcznie:

```sh
node dist/server-jira.js < /dev/null
```

Pierwsze 5 linii stdout MUSI być pustych albo JSON. Jeśli widzisz
`console.log(...)`, `process.stdout.write(...)` z plików serwera — to
bug, zgłoś.

**Najczęstsza przyczyna w forku:** ktoś dodał `console.log` do debugowania.
Logger jest na stderr (`createLogger` → `process.stderr.write`).

---

## "fetch failed" / `ENETUNREACH` / `ECONNREFUSED`

Proxy korporacyjne nie jest wykrywane.

**Diagnoza:**

```sh
npm run doctor
```

Powinien wypisać `[info] proxy: HTTPS_PROXY=http://corp-proxy:8080` jeśli
zmienne są ustawione.

**Fix:** ustaw `HTTPS_PROXY` (i opcjonalnie `HTTP_PROXY` dla http
upstreamów) w env servera:

```jsonc
{ "env": { "HTTPS_PROXY": "http://corp-proxy.internal:8080" } }
```

Lub na poziomie shell, jeśli wolisz globalnie.

**`NO_PROXY`:** lista domen / hostów, które omijają proxy. Format:
przecinek-separated, prefix-match. Np.
`NO_PROXY=localhost,127.0.0.1,internal.corp` — wszystko z `.internal.corp`
omija proxy.

**Tymczasowe wyłączenie proxy per-proces:** `MCP_ALM_DISABLE_PROXY=true`.
Przydatne dla local-dev gdzie system-wide proxy łapie nawet localhost.

---

## "Node version 18.x.x is not supported"

**Symptom:** `npm install` mówi `engine "node": ">=22.0.0"`.

**Fix:** Node 22+ wymagane. Z `nvm`/`fnm`:

```sh
nvm use            # czyta .nvmrc → 22
# albo
fnm use            # to samo
```

Bez version managera: https://nodejs.org/en/download/current

---

## Rate limit z upstreamu (429)

**Symptom:** `-32003 RateLimitError` z payload `{ retryAfter: 60 }`.

**Co się dzieje:** http-client robi automatic retry z exponential backoff plus jitter dla 429 i 5xx. Po wyczerpaniu retry budgetu rzuca błąd.

**Fix:**

1. Zmniejsz `limit` w narzędziu list-owym.
2. Zmniejsz `budgetTokens` w `search_issues` itp. — mniej stron =
   mniej requestów.
3. Dla Jira: jeśli kolokując wiele klientów Copilot, każdy z innego
   tokenu — rozważ wspólny token z wyższym tier limit, ale to wybór
   trade-off.

---

## "Tool not found: jira.foo"

**Symptom:** klient wywołuje narzędzie, którego serwer nie zna.

**Diagnoza:**

```sh
node tools/scripts/dev-client.mjs jira
```

Wypisze rzeczywistą listę z `tools/list`.

**Najczęstsza przyczyna:** klient ma cached schema z poprzedniego buildu.
Restart hosta MCP (VS Code: Command Palette → "Developer: Reload Window";
IntelliJ: Settings → AI Assistant → MCP → Reload).

---

## Diagnoza generyczna

Każdy serwer ma `<server>.health` — smoke test upstreamu + walidacja
tokenu. Wywołaj jako pierwszy krok przy dowolnym problemie:

```sh
node tools/scripts/dev-client.mjs jira jira.health '{}'
node tools/scripts/dev-client.mjs gitlab gitlab.health '{}'
```

A także `<server>.get_usage_history` — daje pełny in-memory ledger
ostatnich wywołań z latencją i estymowanymi tokenami. Pomaga zobaczyć,
co dokładnie agent zawołał i z jakim wynikiem.
