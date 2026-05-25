# Observability

mcp-alm jest świadomie **bez external observability stack** — nie eksportuje
metryk do Prometheusa, nie wysyła traceów do OpenTelemetry, nie pisze do
żadnego sinkku poza stderr. Powód: prosty proces stdio, jedna instancja
per user, brak długiej retencji. Nie potrzeba Grafany dla 100 wywołań
dziennie z jednego IDE.

Co dostajesz zamiast tego — wszystko in-process, w pamięci:

## 1. Stderr logger

Każde wywołanie narzędzia produkuje JSON-line log na **stderr**:

```json
{
  "ts": "2026-05-22T13:00:00.000Z",
  "server": "mcp-jira",
  "tool": "jira.get_issue",
  "correlationId": "01HM...",
  "durationMs": 412,
  "ok": true
}
```

Lub failure:

```json
{
  "ts": "...",
  "tool": "jira.get_issue",
  "correlationId": "...",
  "durationMs": 23,
  "ok": false,
  "error": "Issue does not exist: AB-9999"
}
```

**Co jest redaktowane:** wartości pod kluczami `authorization`,
`*-token`, `*-key`, `password`, `secret`, `cookie`, `x-figma-token` —
rekursywnie, na dowolnej głębokości. Defense-in-depth: logger w ogóle
nie dostaje nagłówka Authorization, ale gdy ktoś przekaże stub
zewnętrznej odpowiedzi do `logger.log({ payload })`, redakcja sprząta.

**Gdzie idzie:** stderr procesu serwera. VS Code Copilot zbiera to do
Output panelu (View → Output → "MCP Servers"). IntelliJ analogicznie
przez AI Assistant log.

**Co NIE jest logowane:**

- Pełne payloady requestów / responsów (tylko meta: tool, duration, ok).
- Nagłówki HTTP.
- Same dane biznesowe (issue summaries, page bodies).

Świadoma decyzja: log nie służy debugowi dat, służy debugowi infrastruktury.

## 2. In-memory session ledger

Każdy serwer ma `sessionTracker` — append-only ring buffer ostatnich N
wywołań w pamięci procesu. Każdy wpis:

```ts
{
  server: string,           // 'mcp-jira'
  tool: string,             // 'jira.search_issues'
  correlationId: string,    // ULID, end-to-end z _meta
  inputChars: number,       // długość JSON-stringified inputu
  outputChars: number,      // długość JSON-stringified responsu
  tokensEstimate: number,   // ~chars/4 + struct overhead
  durationMs: number,       // wall-clock latencja
  ok: boolean,
  error?: string,           // gdy ok=false
}
```

**Retencja:** tylko czas życia procesu serwera. Restart IDE → wyzerowany.
**Brak persystencji do pliku, brak eksportu na zewnątrz.**

## 3. `<server>.get_usage_history` tool

Każdy serwer wystawia narzędzie odczytu, które zwraca aktualny ledger:

```json
{
  "calls": [
    {
      "tool": "jira.search_issues",
      "correlationId": "01HM...",
      "durationMs": 412,
      "inputChars": 87,
      "outputChars": 4231,
      "tokensEstimate": 1058,
      "ok": true
    },
    ...
  ],
  "summary": {
    "totalCalls": 23,
    "totalTokens": 12_400,
    "okRate": 0.957,
    "p50DurationMs": 180,
    "p95DurationMs": 2_100
  }
}
```

**Po co:** rozumienie kosztu i latencji bez external stack. Agent
Copilota może sam wywołać `get_usage_history` w środku sesji, żeby
zdecydować czy zostało budżetu na kolejny `search_issues` z dużym
`limit`.

## 4. `_meta` envelope na każdej odpowiedzi

Każdy response z każdego narzędzia jest opakowany:

```json
{
  "data": { ... },         // właściwy wynik
  "_meta": {
    "correlationId": "01HM...",
    "server": "mcp-jira",
    "tool": "jira.get_issue",
    "durationMs": 412,
    "tokensEstimate": 287,
    "truncated": false,          // gdy true, output był obcięty przez budget
    "rateLimit": {               // gdy upstream podał nagłówki rate-limit
      "remaining": 234,
      "resetAt": "2026-05-22T13:05:00Z"
    }
  }
}
```

**Korzyść dla agenta:** może podjąć decyzję na podstawie `tokensEstimate`
("za drogo, zwęź `fields`") albo `truncated` ("muszę zawołać z next
cursor") **bez** dodatkowej rundy do serwera.

## 5. Outbound headers

Każdy fetch do upstreamu niesie identyfikujące nagłówki:

```
User-Agent: mcp-jira/1.0.0
X-MCP-Server: mcp-jira
X-MCP-Version: 1.0.0
X-MCP-Tool: jira.get_issue
X-Request-ID: 01HM...
```

**Korzyść:** Twoje dashboardy rate-limitu i audit-log na upstreamie
(Jira, GitLab) mogą:

- Filtrować ruch z mcp-alm od ruchu z UI / aplikacji.
- Przypisać każdy upstream request do konkretnego wywołania MCP
  (`X-Request-ID` == `correlationId`).
- Identyfikować, które narzędzie zrobiło call (`X-MCP-Tool`).

To **jedyna telemetria, która opuszcza Twoją maszynę** — i ląduje
wyłącznie u upstream API, do którego i tak musisz iść, żeby zrobić swoją
pracę. Brak ruchu do mcp-alm ownerów. Brak ruchu do third-party
analytics.

## Co zrobić, gdy potrzebujesz więcej (enterprise)

Jeśli compliance wymaga **trwałego audit logu** wywołań narzędzi
poza pamięcią pojedynczego procesu — patrz
[`docs/getting-started/enterprise-intranet.md`](../getting-started/enterprise-intranet.md),
sekcja "DLP i audit trail". Rekomendowany pattern:

1. Wrapper script wokół `node dist/server-X.js`, który tee'uje stderr do
   pliku z rotacją (logrotate / WinEvent).
2. SIEM agent zbiera te pliki — Splunk forwarder, Wazuh, etc.
3. Korelacja po `correlationId` z audit logiem upstreamu (Jira ma
   `audit_log`, GitLab ma `audit_events`).

To NIE jest wbudowane w mcp-alm świadomie — żeby nie wymuszać policy,
która dla pojedynczego dewelopera w domu jest overkillem.

## Co nie jest pokryte

- **Distributed tracing** (W3C Trace Context, OpenTelemetry) — można
  dodać przez `propagate traceparent` z `_meta` do outbound headers, ale
  obecnie tego nie ma. ADR niezbędne przed dodaniem.
- **Metryki w formacie Prometheus** — analogicznie. Można generować z
  ledgera, ale nie ma w core.
- **Trwała persystencja ledgera** — świadoma decyzja, patrz wyżej.
