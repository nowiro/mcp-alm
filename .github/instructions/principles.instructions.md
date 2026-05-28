---
applyTo: '**'
description: Zasady inżynierskie — DRY, SOLID, KISS, YAGNI, kompozycja nad dziedziczeniem
---

# Zasady inżynierskie

**Złote reguły** — meta-reguły, na których opiera się każdy agent gdy nie ma pewności. Nie zastępują reguł zakresowych (security, mcp-server, connectors, tokens) — są tym, co tamte reguły wcielają.

## 1. DRY — Don't Repeat Yourself

Każda istotna wiedza w jednym miejscu. Duplikacja = każda zmiana wymaga manual sync; pierwszy zapomniany sync to bug.

- Zod schemas: deklaracja raz, import wszędzie.
- Stałe (timeouty, budżety, limity) w `src/shared/` jako exported named constants.
- `description` MCP tooli: jedna canonical fraza, nie powielana w docs.

**Wyjątek — Rule of three:** pierwsza duplikacja OK, druga podejrzana, trzecia ekstrahuje helper.

## 2. SOLID

- **SRP** — jedna funkcja / moduł, jeden powód do zmiany. `http-client.ts` = HTTP retry/dedup/ETag, nie reshape. `field-registry.ts` = discovery + reshape, nie HTTP. Każdy `server-*.ts` = composition root, brak biznesowej logiki.
- **OCP** — otwarte na rozszerzenia, zamknięte na modyfikacje. Nowy tool = nowy `defineTool({...})`, nie edycja istniejących handlerów.
- **LSP** — subtypy wymienne. `AuthConfig` to discriminated union; `http-client.ts` obsługuje każdą wariację jednolicie.
- **ISP** — małe interfejsy. `HttpClient.request()` jedna metoda, nie 5 (get/post/put/patch/delete).
- **DIP** — zależności na abstrakcje. `defineTool({ handle })` — handler nie wie o transporcie MCP ani konstrukcji ctx.

## 3. KISS

Jeśli wymaga wyjaśnienia, jest za skomplikowane. Brak Builder gdy wystarczy literałowy obiekt, brak Factory gdy `new Cls(...)`, brak Observer gdy `await`.

## 4. YAGNI

Pierwsza implementacja najprostsza. Druga wymusi refactor — wtedy abstrakcja powstaje z prawdziwym kontekstem.

- Jedna konfiguracja → multi-tenant gdy faktycznie pojawi się druga.
- Hard-coded `https://api.figma.com` aż do prośby o Figma Enterprise → wtedy `FIGMA_BASE_URL`.
- stdio działa → HTTP transport gdy ktoś poprosi.

## 5. Composition over inheritance

Kompozycja funkcji / typów / obiektów. Dziedziczenie = tight coupling + fragile API.

- Konektory to funkcje, nie subklasy `BaseConnector`.
- Pipeline `extract.ts` = `paginate → reshape → budget` (każdy kawałek osobno testable).

## 6. Fail fast, fail loud

Błędy na granicy, nie głęboko.

- External payload → Zod walidacja na granicy. Odrzucaj wcześnie.
- Brak silent coerce `null` na defaulty — ujawnij brakujący input.
- AI output → schema-bound (Zod), nigdy free-text parse na business decisions.

## 7. Convention over configuration

- Pliki: `kebab-case`.
- Tool naming: `<server>.<verb>_<noun>` (`jira.get_issue`, `gitlab.list_mrs`).
- Commits: Conventional Commits.

Gdy nowy kontrybutor pyta "gdzie X?", odpowiedź już jest w `.github/` lub `docs/`.

## 8. Reversibility — małe, bezpieczne kroki

Duże zmiany straszne. Wiele małych = rutyna.

- Jeden concern per PR.
- ADR dla trudnych do odwrócenia decyzji.
- `dryRun: true` na write tools — zobacz request body przed wystrzeleniem.

## 9. Kod jest czytany więcej niż pisany

- Nazwy zamiast komentarzy.
- Explicit types na granicach API (nie inferred).
- Jedno zdanie per linia markdown (czyste diffy).

## 10. Wrap external dependencies

Każda external zależność (REST upstream, SDK, low-level lib) **musi żyć za wrapperem** w `src/shared/`, nigdy importowana bezpośrednio z serwera / konektora.

✅ `await http.request<JiraIssueRaw>({ path: '/rest/api/3/issue/...' })` — jeden HttpClient cross-konektor.
✅ Reshape przez `reshapeJiraIssue(...)` / `fieldRegistry`, nigdy raw `customfield_NNNNN`.
✅ Handler woła connector function, nie surowy `fetch`.

**Wyjątki** (≤ 1 plik per low-level API): owner wrappera (`http-client.ts`, `log.ts`) + jego spec test.

## Jak agenci to stosują

Każdy agent ładuje ten plik na początku zadania. Gdy dwa podejścia spełniają spec, agent wybiera bliższe zasadom i notuje trade-off w hand-off bloku. Code reviewer cytuje **id zasady** (`SRP`, `KISS`) przy odrzucaniu — nie mgliste "wygląda źle".

## Czym to NIE jest

- **Nie checklistą.** PR nie musi demonstrować każdej zasady.
- **Nie przykazaniami.** Realny kod czasem narusza ze zmierzonego powodu — udokumentuj.
- **Nie substytutem dla reguł zakresowych** w `.github/instructions/{security,mcp-server,connectors,tokens}.instructions.md`.

## Zobacz też

[`core.instructions.md`](core.instructions.md) · [`security.instructions.md`](security.instructions.md) · [`llm-optimization.instructions.md`](llm-optimization.instructions.md) · [`mcp-server.instructions.md`](mcp-server.instructions.md) · [`connectors.instructions.md`](connectors.instructions.md)
