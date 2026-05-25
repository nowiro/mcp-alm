# Jak: zdeployować obok hosta MCP

> Trzy kształty deploymentu: local dev, MCP-host-managed, self-hosted
> runner.

## A. Local dev (default)

Najszybsza ścieżka. Host MCP uruchamia każdy serwer jako proces dziecięcy.

1. Buduj raz: `npm run build`.
2. Dodaj wpisy per-konektor do konfiguracji hosta — patrz [quickstart §7](../getting-started/quickstart.md#7-wiring-do-ide).
3. Zrestartuj hosta. Tokeny przychodzą z bloku `env`.

Najlepszy do: solo development, praca offline, brak shared state.

## B. MCP-host-managed (VS Code Copilot / IntelliJ AI Assistant / Claude Desktop / Cursor)

Tak samo jak A, ale binarki żyją w shared location (np.
`/usr/local/lib/mcp-alm/`):

1. `npm run build`.
2. `cp dist/server-jira.js /usr/local/lib/mcp-alm/` (lub na inną stabilną
   ścieżkę).
3. Zaktualizuj konfigurację hosta, żeby wskazywała na ścieżki absolutne.
4. Tokeny nadal przychodzą z bloku `env` hosta — nigdy nie inline'uj ich
   w shell scriptach, które host uruchamia.

Ten kształt pozwala wielu hostom (np. VS Code Copilot + Cursor) dzielić te
same binarki.

## C. Self-hosted long-running proces

Dla shared-team deployment (np. linuxowy box hostujący serwery MCP
dostępne przez SSH-tunneled stdio bridge).

1. Buduj binarki na maszynie docelowej.
2. Użyj process supervisor (`systemd`, `pm2`) żeby trzymać każdy
   `server-*.js` running.
3. Tokeny przychodzą z secret store supervisor'a — np.
   `EnvironmentFile=/etc/mcp-alm/jira.env` dla systemd.
4. Sieć wychodząca: tylko HTTPS do upstream API. Bez portów wchodzących.
5. Plan upgrade: green/blue (uruchom nowy binarny obok starego; zaktualizuj
   supervisora; zatrzymaj stary).

Przykładowy fragment unit systemd:

```ini
[Service]
ExecStart=/usr/local/lib/mcp-alm/server-jira.js
EnvironmentFile=/etc/mcp-alm/jira.env
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
```

Najlepszy do: użytek zespołowy, audit logging, integracja z corporate
identity.

## Cross-cutting

### Logowanie

Wszystkie serwery logują JSON do **stderr** (stdout to transport MCP).
Pipe stderr do swojego agregatora:

- systemd: `journalctl -u mcp-jira`.
- pm2: `pm2 logs mcp-jira`.
- Docker: stderr jest przechwytywany przez runtime domyślnie.

### Healthcheck

Serwery nie wystawiają HTTP healthchecka — MCP jest stdio-only z
definicji (patrz [ADR-0001](../adr/0001-mcp-stdio-transport.md)). Dla
sygnału zdrowia process-level, konektywność hosta MCP do serwera JEST
healthcheckiem.

### Limity zasobów

Dla kształtu C, ustaw `LimitNOFILE`, `MemoryLimit` i CPU cap w unicie
supervisor'a. Serwery są I/O-bound; CPU powyżej 1 core rzadko pomaga.

### Upgrade

Conventional Commits + workflow release produkują tagi z wersjami. Żeby
zrobić upgrade:

1. `git fetch && git checkout v<x.y.z>`.
2. `npm ci && npm run build`.
3. Zrestartuj supervised processes.

Roll-back to ten sam flow z poprzednim tagiem.

## Czego ten repo NIE dostarcza

- ❌ Dockerfile — out of scope dla serwerów stdio-only; hosty MCP
  uruchamiają je bezpośrednio.
- ❌ Helm charts — z tego samego powodu.
- ❌ Multi-tenant gateway — to byłoby osobne repo, z własnym threat model.
