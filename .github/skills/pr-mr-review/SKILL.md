---
name: pr-mr-review
description: Review a GitLab merge request — pull its diff and context via the mcp-gitlab read tools and produce a structured, line-by-line review in chat. Use when the user asks to review or critique an MR or its changes. Read-only; does not post back to GitLab.
---

# pr-mr-review

Przegląda GitLab MR: pobiera diff + kontekst przez **read-only** toole `mcp-gitlab` i zwraca
ustrukturyzowany review (per plik, line-by-line) w czacie. **Nie pisze do GitLaba** — `mcp-alm` nie
ma toola do postowania komentarzy, więc review trafia do usera (read-first, write-guarded).

## Kiedy się uruchamia

Gdy user prosi o przegląd MR-a ("zreviewuj MR 42 w projekcie X", "co sądzisz o tych zmianach").

## Wejście

- `projectId` — numeryczne id albo `group/project` path.
- `iid` — numer MR per-projekt (nie globalny `id`).

## Procedura

1. **`gitlab.get_mr`** `{ projectId, iid }` — tytuł, state, branche, labels, stats. Jeśli `merged`/`closed`,
   uprzedź usera, że review jest post-hoc.
2. **`gitlab.merge_request_changes`** `{ projectId, iid, maxBytesPerFile: 8000 }` — per-file diff. Zwróć
   uwagę na `diffTruncated: true` (duży plik → review częściowy, zaznacz to).
3. **(jeśli istotny CI)** — `gitlab.list_pipelines` (ref = source branch) → `gitlab.get_pipeline_jobs` →
   `gitlab.get_job_log` dla failujących jobów, by powiązać uwagi z czerwonym pipeline.
4. **(jeśli trzeba pełnego kontekstu pliku)** — `gitlab.get_file_content` `{ projectId, path, ref }`;
   diff bez otoczenia bywa mylący.
5. **Zbuduj review** — per plik, uwagi z `newPath:line`, każda z kategorią
   (correctness / security / style / test-gap) i severity (blocker / major / minor / nit).

## Format odpowiedzi

1. **Podsumowanie MR** — tytuł, `source → target`, stats (+/− linie, # plików), status CI.
2. **Uwagi per plik** — `path` → lista `linia: [severity][kategoria] uwaga`.
3. **Werdykt** — `approve` / `changes-requested` / `needs-discussion` + 1–2 zdania.
4. **Nota** — „Komentarze nie są postowane do GitLaba (brak write-toola); skopiuj, co istotne."

## Czego NIE robić

- Nie udawaj, że komentarz trafił do GitLaba — `mcp-alm` tego nie potrafi.
- Nie używaj `gitlab.merge_mr` / `gitlab.create_*` (write, za `MCP_WRITE_ALLOWLIST`) — review jest read-only.
- Nie review'uj bez pobrania diffu — opinia bez `merge_request_changes` to zgadywanie.
- Nie zakładaj globalnego `id` MR — używaj per-projekt `iid`.
