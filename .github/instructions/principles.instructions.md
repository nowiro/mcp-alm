---
applyTo: '**'
description: Zasady inżynierskie — DRY, SOLID, KISS, YAGNI, kompozycja nad dziedziczeniem
---

# Zasady inżynierskie

To **złote reguły**, na których opiera się każdy agent i kontrybutor gdy
nie ma pewności. Siedzą obok [`core.instructions.md`](core.instructions.md)
na szczycie łańcucha priorytetu. Nie zastępują reguł zakresowych
(security, mcp-server, connectors, tokens) — są meta-regułami, które te
reguły wcielają.

## 1. DRY — Don't Repeat Yourself

Każda istotna wiedza ma żyć w jednym miejscu w systemie. Duplikacja
wymusza, że każda zmiana musi być zsynchronizowana ręcznie — pierwszy
zapomniany sync to bug.

- Reguły walidacji (Zod schemas) deklarowane raz, importowane.
- Stałe (timeouty, budżety, limity) w `src/shared/` jako exportowane
  named constants, nie inline.
- Treści `description` narzędzi MCP: jedna canonical fraza per narzędzie,
  nie powielana w docs.

**Wyjątek:** _Rule of three_. Pierwsza duplikacja jest OK. Druga jest
podejrzana. Trzecia ekstrahuje wspólny helper.

## 2. SOLID

### SRP — Single Responsibility

Jedna funkcja / klasa / moduł ma jeden powód do zmiany.

- `http-client.ts` — wrapper HTTP (retry, dedup, ETag, body cap). Nie
  parsuje payloads, nie reshape'uje.
- `field-registry.ts` — discovery + reshape Jira custom fields. Nie woła
  HTTP.
- Każdy `server-*.ts` — composition root jednej integracji ALM. Nie
  trzyma logiki biznesowej.

### OCP — Open / Closed

Moduły otwarte na rozszerzenia, zamknięte na modyfikacje. Dodanie nowego
narzędzia w `server-jira.ts` to dodanie `defineTool({...})`, nie edycja
istniejących handlerów.

### LSP — Liskov Substitution

Subklasy / implementacje muszą być wymienne. W praktyce dla tego repo —
typy `AuthConfig` dla różnych konektorów (Jira, Confluence, Figma, …) są
discriminated union; konsument (`http-client.ts`) musi obsługiwać każdą
wariację jednolicie.

### ISP — Interface Segregation

Małe interfejsy zamiast wielkich. `HttpClient` ma jedną metodę
`request()`. Nie ma `get`, `post`, `put`, `patch`, `delete` jako osobne
metody — bo wtedy testy musiałyby mockować wszystkie z nich.

### DIP — Dependency Inversion

Zależności na abstrakcje (interface), nie konkrety. `defineTool` przyjmuje
`handle(input, ctx)` — handler nie wie o transporcie MCP ani o sposobie,
w jaki ctx został zbudowany.

## 3. KISS — Keep It Simple, Stupid

Jeśli rozwiązanie potrzebuje wyjaśnienia, jest za skomplikowane.

- Brak wzorca _Builder_ tam, gdzie wystarczy obiekt literałowy.
- Brak _Factory_ tam, gdzie wystarczy `new Cls(...)`.
- Brak _Observer_ tam, gdzie wystarczy `await`.

## 4. YAGNI — You Aren't Gonna Need It

Nie buduj abstrakcji "na zapas". Pierwsza implementacja jest najprostsza.
Druga wymusi refactor — i właśnie wtedy abstrakcja powstaje z prawdziwym
contextem.

- Jedna konfiguracja na początek; multi-tenant gdy faktycznie pojawi się
  druga.
- Hard-coded `https://api.figma.com` aż do momentu, gdy ktoś poprosi o
  Figma Enterprise — wtedy `FIGMA_BASE_URL`.
- Brak transportu HTTP w MCP serwerach — stdio działa; HTTP gdy ktoś
  poprosi.

## 5. Composition over inheritance

Większość problemów daje się rozwiązać kompozycją funkcji / typów /
obiektów. Dziedziczenie wprowadza tight coupling i daje fragile API.

- Konektory to funkcje, nie subklasy abstrakcyjnej `BaseConnector`.
- Pipeline ekstrakcji (`extract.ts`) komponuje `paginate → reshape →
budget` — każdy kawałek to osobna funkcja, którą można testować
  niezależnie.

## 6. Fail fast, fail loud

Błędy na granicy, nie głęboko w kodzie.

- Każdy external payload jest walidowany na granicy (Zod). Odrzucaj
  wcześnie.
- Nie coerce po cichu `null` na defaulty — ujaw brakujący input.
- Output modelu AI: schema-bound (Zod) — nigdy nie parse free text na
  business decisions.

## 7. Convention over configuration

Wybierz konwencję, udokumentuj raz, stosuj wszędzie.

- Nazwy plików: `kebab-case`.
- Nazwy narzędzi MCP: `<server>.<verb>_<noun>` (`jira.get_issue`,
  `gitlab.list_mrs`).
- Commits: Conventional Commits.

Gdy nowy kontrybutor (człowiek lub AI) pyta "gdzie powinien iść X?",
odpowiedź powinna już być w `.github/` lub `docs/`.

## 8. Reversibility — małe, bezpieczne kroki

Duże zmiany są straszne. Wiele małych zmian to rutyna.

- Jeden concern na PR. Reviewable w jednym posiedzeniu.
- ADR dla decyzji trudnych do odwrócenia.
- `dryRun: true` na narzędziach mutujących pozwala zobaczyć request body
  przed wykonaniem.

## 9. Kod jest czytany więcej niż pisany

Optymalizuj dla następnego czytelnika, nie aktualnego writera.

- Nazwy zamiast komentarzy.
- Explicit types zamiast inferred na granicach API.
- Jedno zdanie na linię markdown dla czystych diffów.

## 10. Wrap external dependencies

Każda zewnętrzna zależność (REST API upstream, SDK, low-level library)
musi żyć za wrapperem w `src/shared/`, **nie być importowana bezpośrednio
z serwera ani konektora**.

**Patterns ✅:**

- `await http.request<JiraIssueRaw>({ path: '/rest/api/3/issue/...' })` —
  jeden HttpClient cross-konektor.
- Reshape + walidacja przez `reshapeJiraIssue(...)` / `fieldRegistry`
  zamiast bezpośredniego dotykania `raw.fields.customfield_NNNNN`.
- Handler narzędzia woła connector function, nie surowy `fetch` —
  connector pamięta o limitach, retries, dedup.

**Wyjątki** (≤ 1 plik dotykający bibliotekę):

- Owner pliku samego wrappera (`src/shared/http-client.ts`,
  `src/shared/log.ts`) — może importować low-level API.
- Stricte testowy spec dla adaptera (`*.spec.ts` obok) — może referować
  biblioteki do mockowania.

## Jak agenci to stosują

Każdy agent ładuje ten plik na początku zadania. Gdy dwa konkurujące
podejścia spełniają immediate spec, agent wybiera to bliższe tym zasadom
i notuje trade-off w swoim hand-off bloku. Code reviewer cytuje **id
zasady** (np. _SRP_, _KISS_) przy odrzucaniu — nie mgliste "to wygląda
źle".

## Czym te NIE są

- **Nie checklistą.** PR nie musi demonstrować każdej zasady.
- **Nie przykazaniami.** Realny kod czasem narusza zasadę ze zmierzonego
  powodu. Udokumentuj powód.
- **Nie substytutem dla reguł zakresowych.** Reguły z
  `.github/instructions/{security,mcp-server,connectors,tokens}.instructions.md`
  nadal obowiązują.

## Zobacz też

- [`core.instructions.md`](core.instructions.md) — nienegocjowalne
  cross-cutting reguły.
- [`security.instructions.md`](security.instructions.md) — reguły
  bezpieczeństwa.
- [`llm-optimization.instructions.md`](llm-optimization.instructions.md)
  — oszczędność tokenów + deterministyczne skrypty.
- [`mcp-server.instructions.md`](mcp-server.instructions.md) —
  konwencje serwera MCP.
- [`connectors.instructions.md`](connectors.instructions.md) — kontrakt
  konektora.
