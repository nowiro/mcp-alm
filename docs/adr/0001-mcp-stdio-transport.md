# 0001 — Transport MCP stdio, jeden binarny per konektor ALM

- Status: accepted
- Data: 2026-05-08
- Decision-makers: maintainers
- Consulted: project maintainers
- Informed: kontrybutorzy

## Kontekst i problem

Model Context Protocol wspiera wiele transportów (stdio, HTTP, SSE).
Musimy wybrać jeden dla shipowania `mcp-alm`. Musimy też zdecydować, czy
shipować jeden binarny hostujący wszystkie konektory, czy jeden binarny
per upstream system.

## Decision drivers

- **Least privilege** — tokeny Jira i GitLab nie powinny żyć w tym samym
  procesie.
- **Niezależne porażki** — outage Sonara nie powinien położyć narzędzi
  Jira.
- **Kompatybilność hosta** — Claude Desktop, Cursor, VS Code Copilot,
  IntelliJ AI Assistant wszyscy wspierają serwery stdio MCP; tylko
  niektórzy wspierają HTTP. Stdio to lowest common denominator.
- **Postawa bezpieczeństwa** — stdio jest implicite local-only; HTTP
  wymaga od nas myślenia o auth, TLS, network exposure.
- **Konfigurowalność per integracja** — każdy wpis konfiguracji hosta MCP
  mapuje na jeden serwer; użytkownicy mogą wyłączyć lub podstawić jeden
  konektor bez dotykania pozostałych.

## Rozważone opcje

1. **HTTP server hostujący wszystkie konektory na jednym porcie.**
2. **Jeden stdio server hostujący wszystkie konektory przez tool namespacing.**
3. **Jeden binarny stdio per konektor (wybrane).**

## Wybrana decyzja

Wybrana **opcja 3**: `dist/server-jira.js`, `server-confluence.js`,
`server-figma.js`, `server-sonar.js`, `server-gitlab.js`. Każdy mówi
JSON-RPC po stdio.

### Konsekwencje

- ➕ Tokeny dla jednego systemu ALM nigdy nie ładują się do procesu
  innego.
- ➕ Konfiguracja hosta MCP (np. `claude_desktop_config.json`) mapuje
  czysto na "jeden wpis per konektor".
- ➕ Wyłączenie Sonara oznacza usunięcie jednego wpisu z konfiguracji
  hosta, bez dotykania tego repo.
- ➕ Niezależne crash domains — SIGSEGV w figma nie pociąga jira.
- ➖ Trochę więcej boilerplate per konektor (osobny plik `server-*.ts`).
- ➖ Pięć binarek do utrzymania w sync — adresowane przez współdzielenie
  `src/shared/` i baseline contract test.

## Plusy i minusy

### Opcja 1 — HTTP single-port

- ➕ Jeden proces do uruchomienia.
- ➖ Auth, TLS, network exposure stają się naszym problemem.
- ➖ Trudniejsze do drop-in do hosta stdio-only.

### Opcja 2 — Stdio single binary

- ➕ Jeden proces do uruchomienia.
- ➖ Wszystkie tokeny załadowane do jednej przestrzeni adresowej —
  niszczy least-privilege.
- ➖ Tool namespacing (`jira.*`, `gitlab.*`) staje się osobnym problemem.

### Opcja 3 — Stdio per konektor (wybrane)

- ➕ Najlepsze dopasowanie do modelu bezpieczeństwa.
- ➕ Matchuje sposób, w jaki hosty MCP już myślą o serwerach.
- ➖ Pięć bins, pięć entry points; mityguje to `src/shared/` i spójne
  konwencje nazw narzędzi.

## Plan implementacji

- [x] Jeden plik `server-*.ts` per system ALM w `src/`.
- [x] Każdy listuje narzędzia z `name: "<connector>.<verb>"` i rejestruje
      je z `@modelcontextprotocol/sdk`.
- [x] Cała wspólna logika żyje w `src/shared/` (auth, http-client, log,
      write-guard, errors, mcp-server).
- [x] Mapa `bin` w `package.json` wystawia każdy jako CLI.
- [ ] Przyszłość: opcjonalny transport HTTP za feature flagiem dla
      headless deployments — to byłby osobny ADR.

## References

- [Wyjaśnienie: architektura](../explanation/architecture.md) — diagram
  sekwencji wywołania narzędzia.
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk)
  — transport abstraction na której budujemy.
