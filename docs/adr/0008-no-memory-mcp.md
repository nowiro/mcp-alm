# 0008 — Brak memory-MCP w stacku

- Status: accepted
- Data: 2026-05-31
- Decision-makers: maintainer (nowiro)
- Consulted: security-auditor (instructions), orchestrator
- Informed: użytkownicy `mcp-alm`

## Kontekst i problem

GitHub Copilot wprowadził **Copilot Memory** (GA + rozszerzona kontrola usuwania / scope / CLI, maj 2026),
a ekosystem MCP ma serwery pamięci (np. `@modelcontextprotocol/server-memory`). Czy `mcp-alm` powinien
dostarczać lub rejestrować memory-MCP, żeby agent pamiętał kontekst między sesjami?

## Decision drivers

- **DLP / data-egress** — `mcp-alm` celuje w intranet / air-gapped; treści z Jiry / Confluence / GitLab to dane wrażliwe.
- **Determinizm** — narzędzia mają być deterministyczne per input; trwała pamięć wprowadza ukryty, mutowalny stan.
- **Powierzchnia ataku** — npx-launched serwer pamięci to dodatkowy proces + storage poza kontrolą repo.
- **Budżet tokenów** — auto-recall pamięci zaśmieca kontekst nieprzewidywalnie.

## Rozważone opcje

1. **Rejestrować memory-MCP** (np. `server-memory`) w `.vscode/mcp.json`.
2. **Brak memory-MCP** — trwały kontekst tylko przez committed artefakty (instrukcje, prompty, docs) + sesyjny in-memory ledger.
3. **Własny memory-MCP z guardami** — implementacja z redakcją i opt-in storage.

## Wybrana decyzja

Wybrana opcja **2 — brak memory-MCP**, ponieważ ryzyko DLP i niedeterminizm przeważają nad wygodą
trwałej pamięci. Trwały „kontekst" jest jawny i wersjonowany: `.github/instructions/`,
`.github/prompts/`, `docs/`; obserwowalność sesji daje in-memory `*.get_usage_history` (kasowany przy wyjściu).

### Konsekwencje

- ➕ Zero ukrytego stanu i data-egress; spójne z intranet posture i write-guardem.
- ➕ Copilot Memory (host-side) pozostaje wyborem **użytkownika**, nie czymś, co repo narzuca.
- ➖ Brak cross-session recall po stronie serwera — użytkownik powtarza kontekst albo świadomie używa hostowego Memory.

## Plan implementacji

- [x] Nie rejestrować serwerów pamięci w `.vscode/mcp.json`.
- [x] Brak `CLAUDE.md` / `.claude/` (osobna decyzja: single AI host = GitHub Copilot).
- [ ] Re-ewaluować, jeśli pojawi się memory-MCP z natywną redakcją i on-prem storage.

## References

- rules: `.github/instructions/security.instructions.md`, `.github/instructions/tokens.instructions.md`
- upstream: GitHub Copilot Memory — changelog 2026-05-26 (controls for deletion / scope / CLI)
