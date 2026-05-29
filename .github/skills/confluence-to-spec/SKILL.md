---
name: confluence-to-spec
description: Turn a Confluence page (and optionally its child pages) into a structured Markdown specification — context, requirements, acceptance criteria, open questions — using the read-only mcp-confluence tools (confluence.get_page, confluence.search_pages). Use when the user asks to convert, extract, or distil a Confluence page into a spec, PRD, or structured doc. Read-only on Confluence; emits the spec to chat or a local file only.
---

# confluence-to-spec

Bierze stronę Confluence i przerabia ją na **ustrukturyzowany spec w Markdown**: kontekst, wymagania,
kryteria akceptacji, non-goals i otwarte pytania. Read-only na Confluence — wynik trafia do czatu
albo do lokalnego pliku.

## Kiedy się uruchamia

Gdy user prosi o zamianę / ekstrakcję / destylację strony Confluence do specu, PRD albo
ustrukturyzowanego dokumentu ("zrób spec z tej strony", "wyciągnij wymagania z tego Confluence").

## Wejście

- `pageId` — id strony, **albo**
- `title` + `spaceKey` — wtedy najpierw `confluence.search_pages` (CQL `space = "KEY" AND title ~ "..."`),
  żeby ustalić `pageId`.

## Procedura

1. **`confluence.get_page`** — tool zwraca już body przekonwertowane z ADF na Markdown
   (nie parsuj surowego ADF ręcznie).
2. **Podstrony (opcjonalnie)** — jeśli user chce uwzględnić dzieci, użyj `confluence.search_pages`
   (po labelu lub parencie) i scal kontekst.
3. **Reshape do template specu** — zmapuj treść na sekcje: `Context`, `Requirements`,
   `Acceptance criteria`, `Non-goals`, `Open questions`.
4. **Oznacz luki `[?]`** — czego strona NIE rozstrzyga (zamiast zgadywać).

## Format odpowiedzi

Spec w Markdown z sekcjami j.w. Na końcu krótka lista „Czego brakuje na stronie" (pozycje `[?]`),
żeby user wiedział co doprecyzować u źródła.

## Czego NIE robić

- **Nie aktualizuj** strony Confluence (`confluence.update_page`/`create_page` to zapis — write-guarded).
- **Nie wymyślaj** wymagań, których nie ma na stronie — brakujące oznacz `[?]`.
- Nie wklejaj surowego ADF/HTML — pracuj na Markdown zwróconym przez `confluence.get_page`.
