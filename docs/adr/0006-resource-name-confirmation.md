# 0006 — Tier 3 write-guard: potwierdzenie nazwy zasobu

- Status: accepted
- Data: 2026-05-22
- Decision-makers: maintainers
- Consulted: security review
- Informed: kontrybutorzy

## Kontekst i problem

ADR [0003](0003-write-guard-runtime.md) wprowadził dwupoziomowy write-guard:
tier 1 (env enable + per-tool allowlist) i tier 2 (destructive allowlist +
shared-secret `confirmToken`). Pokrywa to przypadek "nie powinno się dać
zapisać w ogóle" i "destruktywne wymaga dodatkowego secret".

**Nie pokrywa** wzorca "agent zna secret, ale wpisał zły `pageId`". LLM,
który dostał poprawny `MCP_DESTRUCTIVE_CONFIRM` w env, może z bardzo wysoką
pewnością wywołać `confluence.delete_page` z `pageId` ze stałego kontekstu,
który stał się stale (page została przeniesiona / zmieniła nazwę / należy
do innego projektu). W tym scenariuszu tier 2 przepuszcza wywołanie, bo
secret jest poprawny — ale zasób, który ginie, nie jest tym, który agent
zamierzał skasować.

Przykład real-world: GitHub od lat wymaga, by przy usuwaniu repozytorium
wpisać jego nazwę dosłownie. AWS robi to samo dla S3 bucketów. Pattern jest
znany; brakuje go w mcp-alm.

## Decision drivers

- **Defence in depth na poziomie semantycznym.** Tier 1/2 zabezpieczają
  środowisko (process env, secret w handsie operatora); tier 3 ma
  zabezpieczyć **decyzję** (czy ten konkretny resource jest tym co miał być).
- **Failure mode powinien być inny niż tier 1/2.** Operator widzący
  `WriteDeniedError` myśli "muszę ustawić env var". Operator widzący
  `ConfirmationError` myśli "muszę zweryfikować, że agent operuje na
  właściwym zasobie". Różne remediation paths → różne typy błędów.
- **Pattern musi być cheap dla agenta.** Wymagać od agenta echa nazwy
  zasobu, którą i tak musiał znać żeby decyzję podjąć — to free.
- **Latency overhead jest akceptowalny.** Jedno dodatkowe GET przed delete
  to ~50 ms; bezpieczeństwo > prędkość dla destructive ops.

## Rozważone opcje

1. **Resource-name echo + constant-time compare — wybrane.** Wymusza echo
   bieżącej nazwy zasobu jako parametr `confirmResourceName`; handler GET'uje
   zasób tuż przed delete, porównuje constant-time.
2. **Cool-down period.** Wymagać dwóch wywołań w odstępie ≥ X sekund.
   Odrzucone — nie chroni przed agentem mającym ten sam stale kontekst dwa
   razy z rzędu.
3. **Resource-version (ETag / If-Match).** Wysłać `If-Match: <version>` w
   DELETE. Częściowo pokrywa case (chroni przed concurrent modification),
   ale nie zmusza agenta do samodzielnego potwierdzenia identyczności.
   Komplementarne, nie alternatywne.
4. **Out-of-band UI confirmation.** Push notification do operatora, czeka
   na approval. Odrzucone — wymaga dodatkowej infrastruktury (notifier,
   stateful storage), threat model się komplikuje.
5. **Brak tier 3, polegamy tylko na host UI per-tool approval (VS Code /
   IntelliJ).** Odrzucone — host UI pokazuje argumenty narzędzia, ale
   operator nie sprawdza nazwy zasobu manualnie. Patrz threat model.

## Wybrana decyzja

Wybrana **opcja 1**: nowy helper
`assertResourceConfirmation(toolName, actualResourceName, providedResourceName)`
w [`src/shared/write-guard.ts`](../../src/shared/write-guard.ts). Helper
rzuca `ConfirmationError` (`-32009`) gdy:

- bieżąca nazwa zasobu jest pusta (safety bail-out),
- caller nie przekazał `confirmResourceName` lub przekazał empty string,
- przekazana nazwa nie matchuje bieżącej (case-sensitive, exact, bez
  trimowania), porównanie przez `crypto.timingSafeEqual`.

Każde destruktywne narzędzie musi:

1. Wywołać `assertDestructiveAllowed(toolName, input.confirmToken)` (tier 2).
2. Wykonać upstream GET na targetowanym zasobie.
3. Wyciągnąć human-readable name (`title` / `path` / `summary` / `name`).
4. Wywołać `assertResourceConfirmation(toolName, fetchedName, input.confirmResourceName)`.
5. Dopiero potem wykonać DELETE.

### Konsekwencje

- ➕ Agent nie może skasować "innego" zasobu nawet z poprawnym secret —
  musi mu odpowiadać też name. Wrong-resource accidents przestają być
  możliwe pojedynczym wywołaniem.
- ➕ Pattern jest familiar dla operatorów (GitHub, AWS, GitLab UI używają
  tego samego).
- ➕ Distinct error type (`-32009`) pozwala hostowi (VS Code / IntelliJ /
  Claude Desktop) routować inaczej niż `WriteDeniedError`.
- ➕ Trywialnie testowalne — pure function.
- ➖ Każdy destruktywny request kosztuje +1 upstream GET. Akceptowalne dla
  destructive ops (rzadkie z definicji).
- ➖ Implementatorzy nowych delete tools muszą pamiętać o trzech krokach
  (GET → confirm → DELETE). Pattern w
  [`.github/instructions/mcp-server.instructions.md`](../../.github/instructions/mcp-server.instructions.md)
  i [`.github/prompts/new-connector.prompt.md`](../../.github/prompts/new-connector.prompt.md).

## Plan implementacji

- [x] `src/shared/errors.ts` eksportuje `ConfirmationError` (`-32009`).
- [x] `src/shared/write-guard.ts` eksportuje `assertResourceConfirmation`.
- [x] `src/shared/write-guard.spec.ts` zawiera testy: success path, missing
      provided name, empty provided name, case-mismatch, whitespace, prefix,
      empty actual name (safety bail-out), error tool routing.
- [x] `docs/explanation/write-guard.md` dokumentuje tier 3 z przykładem
      handler'a.
- [x] `docs/reference/configuration.md` opisuje parametr `confirmResourceName`.
- [x] `docs/reference/error-codes.md` lista `-32009`.
- [x] `.github/instructions/{security,mcp-server}.instructions.md` wymagają
      patternu dla każdego `delete_*` tool.
- [x] `.github/prompts/new-connector.prompt.md` Definition of Done dla
      destruktywnych narzędzi.

## References

- [ADR 0003 — Write-guard w runtime](0003-write-guard-runtime.md) — fundament,
  na którym tier 3 jest dobudowany.
- [Wyjaśnienie: wzorzec write-guard](../explanation/write-guard.md#trzeci-poziom--potwierdzenie-nazwy-zasobu) — wzorzec w szczegółach.
- [Referencja: kody błędów](../reference/error-codes.md) — `-32009` ConfirmationError.
- [`src/shared/write-guard.ts`](../../src/shared/write-guard.ts) — implementacja.
