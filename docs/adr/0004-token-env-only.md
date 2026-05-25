# 0004 — Tokeny przez env vars lub user-profile config, nigdy argv ani stdin

- Status: accepted
- Data: 2026-05-08
- Decision-makers: maintainers
- Consulted: security review
- Informed: kontrybutorzy

## Kontekst i problem

Każdy konektor ALM mówi z upstream API z personal access token. Musimy
wybrać, jak token wchodzi do procesu i jak jest przechowywany, gdy już
tam jest.

## Decision drivers

- **Brak wycieku do logów** — argv często ląduje w `ps`, syslog, audit
  logs, crash dumps.
- **Brak wycieku do stdin** — stdin to transport MCP; mieszanie
  transportu tokena couple'owałoby bezpieczeństwo z protokołem.
- **Permisywne on-disk artifacts** — `.env` files są użyteczne dla dev,
  ale to operator decyduje, czy je używać.
- **Audytowalność** — jedno miejsce do sprawdzenia "czy ta binarka
  potrzebuje tokena?" to `reference/configuration.md`.

## Rozważone opcje

1. **Env vars + opcjonalny user-profile config JSON (wybrane).**
2. **CLI argument (`--token=...`).**
3. **stdin handshake przy starcie.**
4. **Integracja z secrets managerem (Vault / 1Password CLI).**

## Wybrana decyzja

Wybrana **opcja 1**: tokeny są resolved przy każdym użyciu w
`src/shared/auth.ts` w kolejności:

1. Process environment variable (np. `JIRA_TOKEN`) — wygrywa dla CI /
   kontenerów / shell exports.
2. User-profile config file (`~/.config/mcp-alm/config.json`, walidowane
   Zod) — wygrywa dla local IDE use (paste once, reuse across sessions).
3. `AuthError` — nigdy default, nigdy silently.

Tokeny żyją w module scope, nigdy eksportowane, nigdy logowane.

### Konsekwencje

- ➕ Brak ryzyka `ps -ef` ujawniającego token.
- ➕ Konfiguracje hostów MCP mają już blok `env` — naturalna integracja.
- ➕ Trywialnie zamienić tokeny przez restart procesu z innym env.
- ➕ User-profile config przeżywa restart terminala — wygodne dla
  developera.
- ➕ Kompatybilne z secrets managerami (operator pulluje secret i
  eksportuje go).
- ➖ Operator musi pamiętać o ustawieniu env var lub stworzeniu pliku
  config.
- ➖ Plik config to one disk artifact do zabezpieczenia (`chmod 600` na
  POSIX, default ACL `%USERPROFILE%` na Windows).

## Plusy i minusy

### Opcja 1 — Env + user-profile config (wybrane)

- ➕ Process-scoped, niewidoczne w argv.
- ➕ Standard for 12-factor apps.
- ➕ User-profile config przeżywa shell restart.
- ➖ Plik config to one disk artifact.

### Opcja 2 — CLI argument

- ➕ Widoczne przy starcie.
- ➖ Widoczne w `ps`; logowane w shell history; embedded w process tables.

### Opcja 3 — stdin handshake

- ➕ Token nigdy na disku ani w argv.
- ➖ Couple'uje bezpieczeństwo z transportem MCP.
- ➖ Hosty MCP nie wspierają arbitrary preludes.

### Opcja 4 — Secrets manager integration

- ➕ Best for prod.
- ➖ Dodaje hard dependency na konkretny manager.
- ➖ Operatorzy mogą zintegrować Vault/1Password eksportując z nich do
  env — opcja 1 to pokrywa.

## Plan implementacji

- [x] `src/shared/auth.ts` resolves tokens w kolejności env → user-config
      → throw.
- [x] `src/shared/user-config.ts` ładuje `~/.config/mcp-alm/config.json`,
      waliduje Zod.
- [x] Wrapper HTTP attachuje token jako nagłówek per żądanie.
- [x] `src/shared/log.ts` rekursywnie redaktuje `authorization`,
      `*-token`, `*-key`, `password`, `secret`, `cookie`.
- [x] Token nigdy nie pojawia się w input ani output narzędzia
      (schematy Zod tego nie pozwalają).

## References

- [Wyjaśnienie: architektura bezpieczeństwa](../explanation/security-architecture.md) — pełny token-handling flow.
- [Referencja: konfiguracja](../reference/configuration.md) — każda var
  tokena listowana.
- [12-factor app: config](https://12factor.net/config) — wzorzec, który
  to followuje.
