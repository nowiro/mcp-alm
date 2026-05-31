# Architecture Decision Records — mcp-alm

> Jeden krótki plik markdown per nietrywialna decyzja. Append-only. Nowe
> decyzje dostają nowy plik; superseded decyzje zostają z `Status:
superseded by NNNN`.

## Proces

1. Wyłap decyzję wartą udokumentowania (wzorzec ograniczający przyszłą
   pracę, lub wybór z nieoczywistymi tradeoffami).
2. Skopiuj [`0000-template.md`](0000-template.md) do `NNNN-<slug>.md`,
   gdzie `NNNN` to następny wolny numer.
3. Wypełnij. Trzymaj poniżej 200 linii.
4. Otwórz PR. Reviewerzy skupiają się na **Decision drivers** i
   **Consequences** — to one będą ponownie czytane za 6 miesięcy.
5. Po mergu zaktualizuj indeks niżej.

## Legenda statusów

- **proposed** — drafted, awaiting review.
- **accepted** — merged; codebase to odzwierciedla.
- **superseded** — zastąpiony przez późniejszy ADR; cross-link w obie
  strony.
- **deprecated** — już nieistotne; trzymane dla kontekstu historycznego.

## Indeks

| #    | Tytuł                                                                                          | Status   | Data       |
| ---- | ---------------------------------------------------------------------------------------------- | -------- | ---------- |
| 0001 | [Transport MCP stdio](0001-mcp-stdio-transport.md)                                             | accepted | 2026-05-08 |
| 0002 | [Zod dla walidacji input/output](0002-zod-input-validation.md)                                 | accepted | 2026-05-08 |
| 0003 | [Write-guard w runtime](0003-write-guard-runtime.md)                                           | accepted | 2026-05-08 |
| 0004 | [Tokeny tylko przez env vars](0004-token-env-only.md)                                          | accepted | 2026-05-08 |
| 0005 | [Natywny fetch, bez axios](0005-native-fetch-no-axios.md)                                      | accepted | 2026-05-08 |
| 0006 | [Tier 3 write-guard: potwierdzenie nazwy zasobu](0006-resource-name-confirmation.md)           | accepted | 2026-05-22 |
| 0007 | [Druga bramka nad `src/shared/`: pipeline ekstrakcji](0007-extract-pipeline-second-gateway.md) | accepted | 2026-05-22 |
| 0008 | [Brak memory-MCP w stacku](0008-no-memory-mcp.md)                                              | accepted | 2026-05-31 |

## Konwencje

- Nazwa pliku: `NNNN-<kebab-slug>.md`. Numery zero-padded do 4 cyfr.
- Jedna decyzja per plik.
- Cross-link między powiązanymi ADR w sekcji **References**.
- Tekst ADR to source of truth. Komentarze w kodzie mogą referować ADR,
  ale nigdy nie restateują go.
