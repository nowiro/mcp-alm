# 0007 — Druga bramka nad `src/shared/`: deterministyczny pipeline ekstrakcji

- Status: accepted
- Data: 2026-05-22
- Decision-makers: maintainers
- Consulted: —
- Informed: contributors do `src/shared/*-reshape.ts`

## Kontekst i problem

mcp-alm w 1.0.0 wystawia jedną bramkę nad warstwą `src/shared/` (auth,
http-client, `*-reshape`, `adf`, `field-registry`): **MCP stdio**.
Wywołania idą przez agenta (Copilot / Claude / inny LLM host), który
**podejmuje decyzje**:

- jakie narzędzie wywołać (`get_issue` vs `search_issues` vs `bulk_get_issues`),
- z jakimi parametrami (`fields`, `limit`, `budgetTokens`, `expand`),
- kiedy uznać zadanie za skończone.

To jest pożądane dla **interactive** use case'ów (eksploracja, code
review, ad-hoc query w trakcie rozmowy). Ale generuje fundamentalny
problem dla innych klas use case'ów:

- **Compliance**: "zrób snapshot stanu projektu X co tydzień" — wymaga
  identycznego shape outputu między runami.
- **Reproducible bug reports**: "tu są dokładnie te dane, które
  widziałem" — wymaga, żeby pull tego samego issue dał ten sam JSON.
- **Eval-sety dla LLM**: trzymamy committed fixtures z których inny
  pipeline trenuje / ewaluuje — wymaga bit-for-bit determinizmu.
- **Wykrywanie zmian (diff over time)**: porównanie snapshotów z dwóch
  runów — wymaga, żeby różnice w outpucie wskazywały na różnice w
  upstreamie, nie na decyzje agenta.

LLM z definicji jest niedeterministyczny — nawet przy `temperature=0`
zachowanie zmienia się przy każdym update'cie modelu po stronie hosta,
przy zmianie kontekstu rozmowy, przy różnych instrukcjach systemowych.

## Decision drivers

- **Determinizm** dla use case'ów ekstrakcji ≠ celowa swoboda dla
  use case'ów eksploracji. Nie chcemy okroić agenta dla compliance, ani
  zmuszać compliance'u do LLM-a dla swobody.
- **Single source of truth dla reshape**. Pole projekcji w
  `jira-reshape.ts` MUSI być identyczne dla obu bramek — divergencja
  ("MCP odda inny shape niż snapshot") to bug.
- **Reużycie istniejących kontroli bezpieczeństwa**. SSRF guard, proxy
  resolution, prywatne CA, retry, dedup, redakcja logów — wszystko żyje
  w `http-client.ts` i NIE powinno być przepisywane dla pipeline'u.
- **Brak third-party SDK dla LLM-a**. „Copilot SDK" w sensie biblioteki
  do importu — nie istnieje publicznie. Każde dodanie agenta
  jako _komponentu wewnętrznego_ (np. Anthropic Agent SDK) przerzuca
  problem w inne miejsce, nie rozwiązuje go.

## Rozważone opcje

1. **Status quo — tylko MCP stdio.** Compliance / reproducibility nie
   jest naszym problemem; user pisze własne narzędzie ekstrakcji.
2. **Dodatkowa bramka non-interactive (`src/extract-*.ts`)** sharedująca
   100% kodu reshape, ale czytająca parametry z committed configu.
3. **Programmatic SDK** (`@mcp-alm/sdk`) z fluent API dla użytkowników
   piszących własne narzędzia ekstrakcji. Większa powierzchnia, większe
   utrzymanie.
4. **CLI-only narzędzie z osobnym repo / pakietem** poza mcp-alm.

## Wybrana decyzja

Wybrana opcja **2** — druga bramka jako oddzielne entrypointy
(`src/extract-jira.ts`, `src/extract-confluence.ts`, planowane:
`extract-gitlab.ts`, `extract-sonar.ts`), reusujące 100%
`src/shared/`.

Konkretnie:

- Każdy `extract-<connector>.ts` ma `main()` zagatowane przez `if
(process.argv[1] === fileURLToPath(import.meta.url))` — pozwala
  importować schemę / renderer z testów bez auto-execute pipeline'u.
- Config (`extract.config.<connector>.json`) jest gitignored; szablon
  `extract.config.<connector>.example.json` jest committed.
- Output ląduje w `output/<connector>/<snapshot-name>/<id>.json` +
  `<id>.md` + `_manifest.json`. `output/` jest gitignored — committment
  snapshotów jest świadomą decyzją usera per scenario.
- Outbound headers identyfikują pipeline (`X-MCP-Server: extract-<connector>`,
  różne od `mcp-<connector>`) — audit log upstream rozróżnia ruch.
- Zero `assertWriteAllowed` — pipeline jest **read-only** z definicji.

### Konsekwencje

- ➕ Single source of truth: zmiana w `jira-reshape.ts` propaguje do
  obu bramek równocześnie. Niemożliwa divergencja.
- ➕ Determinizm dla scenariuszy compliance / reproducibility / eval-sets
  bez kompromisu na interactive use cases MCP.
- ➕ Reuse SSRF guard / proxy / retry / dedup z `http-client.ts` —
  pipeline ma identyczne security envelope co MCP.
- ➕ Snapshot diffing trywialne: `diff -ru baseline/ output/` z
  filtrem na pola `updated` / `version`.
- ➖ Dwie ścieżki kodu do utrzymania, choć dzielą ~90% kodu.
- ➖ Każdy nowy connector wymaga dwóch entrypointów (`server-*.ts` +
  `extract-*.ts`) — udokumentowane w AGENTS.md jako wymóg.
- ➖ Wzrost rozmiaru `bin` jeśli kiedyś będziemy publikować na npm.

## Plusy i minusy opcji

### Opcja 1 — Status quo

- ➕ Zero dodatkowego kodu.
- ➖ Compliance / reproducibility nie ma odpowiedzi w repo.
- ➖ Userzy implementują równoległe pipeline'y poza repo z divergencją
  od reshape.

### Opcja 2 — Druga bramka w repo (wybrane)

- ➕ Single source of truth.
- ➕ Reuse infrastruktury.
- ➕ Mała powierzchnia API (2 entrypointy zamiast SDK).
- ➖ Dwie ścieżki do utrzymania.

### Opcja 3 — Programmatic SDK

- ➕ Maksymalna elastyczność dla zaawansowanych userów.
- ➖ Stabilne API to długoterminowe zobowiązanie.
- ➖ Większa powierzchnia zagrożeń bezpieczeństwa (jak user kontroluje
  reuse SSRF guard?).
- ➖ Niewspółmierne do problemu — większość use case'ów to "zrzuć JSON,
  porównaj z baseline".

### Opcja 4 — Osobne repo

- ➕ Izolacja zależności.
- ➖ Tracimy SSOT dla reshape — divergencja gwarantowana w czasie.
- ➖ Trudniej zsynchronizować wersję upstream API i schema reshape.

## Plan implementacji

PR-sized bullets:

- [x] `src/extract-jira.ts` + `extract.config.jira.example.json` + spec.
- [x] `src/extract-confluence.ts` + `extract.config.confluence.example.json` + spec.
- [x] `docs/how-to/data-extraction.md` — howto + determinizm gwarancje + security note.
- [x] AGENTS.md, architecture.md, commitlint scope `extract`, PR template.
- [x] `src/extract-gitlab.ts` (issues + MRs + pipelines).
- [x] `src/extract-sonar.ts` (quality gate + issues + hotspots + measures).
- [x] Fixture roundtrip test dla Jira: raw API response → `buildExtractedIssue` → `toMatchInlineSnapshot`. Każda zmiana w reshape / assembly extras zostanie wyłapana.
- [ ] (Opcjonalnie, follow-up) End-to-end test z mockiem `fetch` przechodzącym przez całe `main()` dla pozostałych konektorów. Wymaga refactoru `buildExtractedPage` / per-type processors GitLab / Sonar żeby odseparować pure assembly od HTTP.
- [ ] (Opcjonalnie, follow-up) GitHub Actions workflow dla scheduled snapshotów. Wymaga decyzji o secret management + retencji artifactów.

## References

- rules: [`.github/instructions/llm-optimization.instructions.md`](../../.github/instructions/llm-optimization.instructions.md) — dlaczego nie ufamy LLM-owi dla determinizmu.
- howto: [`docs/how-to/data-extraction.md`](../how-to/data-extraction.md).
- powiązane ADR: [0002 — Zod walidacja](0002-zod-input-validation.md) (schema configu pipeline'u używa tego samego mechanizmu), [0005 — Natywny fetch](0005-native-fetch-no-axios.md) (pipeline reusuje `http-client.ts`).
