# 0003 — Write-guard w runtime, domyślnie wyłączony

- Status: accepted
- Data: 2026-05-08
- Decision-makers: maintainers
- Consulted: security review
- Informed: kontrybutorzy

## Kontekst i problem

LLM-y robią pewne siebie błędy. Konektor pozwalający modelowi
`jira.create_issue`, `gitlab.create_mr` lub `confluence.update_page` może
zrobić prawdziwą szkodę, jeśli wywołany niezamierzenie. Potrzebujemy
deterministycznego, audytowalnego, łatwego-do-flipowania mechanizmu
bramkowania zapisów.

## Decision drivers

- **Default safe** — żadna mutacja nie powinna się zdarzyć, dopóki
  człowiek explicite nie włączy.
- **Audytowalne** — jedno miejsce do sprawdzenia, czy zapisy są on.
- **Process-scoped** — decyzja bezpieczeństwa należy do człowieka
  uruchamiającego serwer, nie do modelu wybierającego argumenty.
- **Per-narzędzie granularność** — flipowanie Jira create nie powinno
  auto-flipować Jira delete.

## Rozważone opcje

1. **Master switch + per-tool allowlist (`MCP_WRITE_ENABLED` + `MCP_WRITE_ALLOWLIST`) — wybrane.**
2. **Per-konektor env var (`JIRA_WRITE_ENABLED`).**
3. **Tool argument flag (`{ apply: true }`) na każdym mutującym wywołaniu.**
4. **Compile-time constant — brak zapisów dopóki nie zrebuildujesz.**

## Wybrana decyzja

Wybrana **opcja 1**: każde mutujące narzędzie woła
`assertWriteAllowed(toolName)` z `src/shared/write-guard.ts`. Guard
wymaga **dwóch** rzeczy:

1. `MCP_WRITE_ENABLED=true` (master switch).
2. Dokładna nazwa narzędzia na `MCP_WRITE_ALLOWLIST=<tool1>,<tool2>,…`.

Pusta allowlist = deny-all. Defaulty są deny-deny: brak env vars =
żadne write tool się nie uruchomi.

Dla narzędzi destruktywnych (`*.delete_*`, `*.merge_*`) — drugi tier
przez `assertDestructiveAllowed(toolName, confirmToken)` wymagający też
`MCP_DESTRUCTIVE_ALLOWLIST` i `confirmToken` matching
`MCP_DESTRUCTIVE_CONFIRM` (≥ 16 znaków, porównanie constant-time).

Dodatkowo — trzeci tier wprowadzony w [ADR 0006](0006-resource-name-confirmation.md):
caller musi echo'wać bieżącą nazwę zasobu jako `confirmResourceName` (chroni
przed wrong-resource delete'em).

### Konsekwencje

- ➕ Safe by default; mutacja wymaga opt-in na dwóch poziomach.
- ➕ Jedna funkcja pomocnicza = jedno miejsce do audytu.
- ➕ Per-narzędzie granularność (przez allowlist).
- ➕ Trywialnie testowalne.
- ➖ Operator musi pamiętać o ustawieniu env var.
- ➖ Brak per-call confirmation (poza destruktywnymi) — fixed kosztem
  prostoty.

## Plusy i minusy

### Opcja 1 — Master + allowlist (wybrane)

- ➕ Granularne ale proste.
- ➕ Process-scoped.
- ➕ Wsparcie destruktywnych jako naturalne rozszerzenie.

### Opcja 2 — Per-konektor env var

- ➕ Każdy konektor independent.
- ➖ Brak granularności per-narzędzie.
- ➖ Bardziej env vars do pamiętania.

### Opcja 3 — Tool argument flag

- ➕ Per-call granularność.
- ➖ Przenosi decyzję bezpieczeństwa do modelu.
- ➖ Tworzy atrakcyjny cel dla prompt injection.

### Opcja 4 — Compile-time constant

- ➕ Zapisy nie mogą wystrzelić bez rebuildu.
- ➖ Ludzie ZNAJDĄ workaround (alternate builds, custom forks).
- ➖ Friction zapobiega legitymnemu użyciu; zachęca do dangerous
  shortcuts.

## Plan implementacji

- [x] `src/shared/write-guard.ts` eksportuje `assertWriteAllowed(toolName)`
      i `assertDestructiveAllowed(toolName, confirmToken)`.
- [x] Każde mutujące narzędzie woła odpowiedni assert po Zod parse i
      przed jakimkolwiek upstream HTTP call.
- [x] Testy kontraktowe asercją: z unset env → throws; z env + allowlist
      → przechodzi.
- [x] Dokumentuje każdą var w [`reference/configuration.md`](../reference/configuration.md).

## References

- [Wyjaśnienie: wzorzec write-guard](../explanation/write-guard.md) —
  wzorzec w szczegółach.
- [Referencja: konfiguracja](../reference/configuration.md) — każda var
  write-guarda.
- [`.github/instructions/security.instructions.md`](../../.github/instructions/security.instructions.md) — reguły agent-facing.
