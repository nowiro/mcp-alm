# mcp-alm — indeks dokumentacji

> Mapa każdego dokumentu w repo. Gdy dodajesz dok, podlinkuj go tutaj.

## Dla kogo?

Wybierz swoją rolę; każdy wpis kieruje do najmniejszego zestawu dokumentów,
który da Ci produktywność.

| Rola                                                         | Zacznij od                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Nowy kontrybutor**                                         | [README](../README.md) → [getting-started/quickstart](getting-started/quickstart.md) → [AGENTS](../AGENTS.md)                                                                                                                                   |
| **Developer używający mcp-alm**                              | [getting-started/quickstart](getting-started/quickstart.md) → [getting-started/vscode-setup](getting-started/vscode-setup.md) (lub [intellij-setup](getting-started/intellij-setup.md)) → [reference/configuration](reference/configuration.md) |
| **DevOps / SRE / Platform**                                  | [getting-started/enterprise-intranet](getting-started/enterprise-intranet.md) → [explanation/security-architecture](explanation/security-architecture.md) → [how-to/deploy](how-to/deploy.md) → [SECURITY](../SECURITY.md)                      |
| **Audytor bezpieczeństwa**                                   | [SECURITY](../SECURITY.md) → [explanation/security-architecture](explanation/security-architecture.md) → [adr](adr/)                                                                                                                            |
| **PM / analityk**                                            | [explanation/architecture](explanation/architecture.md) → [adr](adr/)                                                                                                                                                                           |
| **Agent GitHub Copilot**                                     | [`.github/copilot-instructions.md`](../.github/copilot-instructions.md) → [`.github/{instructions,prompts}/`](../.github/) → [`.github/architecture.md`](../.github/architecture.md)                                                            |
| **Inny MCP-aware agent (Cursor, Claude Desktop, Agent SDK)** | [`AGENTS.md`](../AGENTS.md) → [`.github/instructions/`](../.github/instructions/)                                                                                                                                                               |

## Sekcje (Diátaxis)

### `getting-started/` — pierwsze 30 minut

- [Quickstart](getting-started/quickstart.md) — install, build, uruchom
  jeden serwer MCP, wywołaj `tools/list`.
- [Konfiguracja VS Code](getting-started/vscode-setup.md) — natywna
  rejestracja MCP przez `.vscode/mcp.json`, per-tool approval,
  troubleshooting.
- [Konfiguracja IntelliJ IDEA](getting-started/intellij-setup.md) — import
  `.idea/mcp-servers.example.xml`, integracja z pluginem GitHub Copilot.
- [Deployment enterprise / intranet](getting-started/enterprise-intranet.md)
  — proxy korporacyjne, prywatne bundle CA, instalacja air-gapped, DLP,
  trwały audit log.

### `how-to/` — przepisy zorientowane na zadanie

- [Dodanie nowego konektora ALM](how-to/add-connector.md)
- [Konfiguracja tokenów](how-to/configure-tokens.md)
- [Deployment na self-hosted runner](how-to/deploy.md)
- [Troubleshooting](how-to/troubleshooting.md) — recipe-style fixy dla
  najczęstszych failure modes (401, SSRF, TLS, proxy, write-guard).
- [Data extraction (deterministic pipeline)](how-to/data-extraction.md) —
  druga bramka równoległa do MCP: skrypty `extract-jira` / `extract-confluence`
  dla snapshotów / compliance audytu / eval-setów.

### `reference/` — referencja informacyjna

- [Konfiguracja](reference/configuration.md) — env vars, defaulty, kolejność
  precedensu.
- [Kody błędów](reference/error-codes.md) — kody błędów JSON-RPC z remediacją.
- [Narzędzia](reference/tools.md) — pełna lista narzędzi każdego z pięciu
  serwerów, klasa (read/write/destructive), opis.
- **MCP Prompts + Resources** — preconfigured slash-commands i read-only docs
  są udokumentowane bezpośrednio w głównym [README.md](../README.md) (sekcje
  "MCP Prompts — preconfigured slash-commands" i "MCP Resources —
  preconfigured docs context"). Pełne tabele URI per serwer + wzorce użycia
  w Copilot Chat.

### `explanation/` — projekt i uzasadnienie

- [Architektura](explanation/architecture.md) — komponenty, sekwencje,
  mermaid.
- [Architektura bezpieczeństwa](explanation/security-architecture.md) —
  model zagrożeń, defence in depth.
- [Wzorzec write-guard](explanation/write-guard.md) — jak mutacje są
  bramkowane.
- [Observability](explanation/observability.md) — logger, in-memory ledger,
  `_meta` envelope, outbound headers, brak external stack i dlaczego.

### `adr/` — Architecture Decision Records

- [Indeks](adr/README.md)
