# CQL Cheatsheet — Confluence search

## Operatory

| Operator       | Przykład                                                      |
| -------------- | ------------------------------------------------------------- |
| `=`, `!=`      | `space = "ENG"`, `type != "blogpost"`                         |
| `IN`, `NOT IN` | `space IN ("ENG", "OPS")`                                     |
| `~`            | `title ~ "onboarding"` (fuzzy), `text ~ "deploy"` (full-text) |
| `>`, `<`, `>=` | `lastModified > "2026-01-01"`, `created >= now("-30d")`       |

## Funkcje

```cql
contributor = currentUser()
contributor IN membersOf("frontend-team")
ancestor = "123456"                       -- page id; wszystko pod tym page
parent = "123456"                         -- direct children
```

## Daty

- Relatywne: `now("-7d")`, `now("-1M")`, `startOfDay()`.
- Absolutne: `"2026-05-26"`.

```cql
lastModified >= now("-7d") AND lastModified <= now()
created >= "2026-01-01" AND created < "2026-02-01"
```

## Boolean + sortowanie

```cql
space = "ENG" AND type = "page" AND title ~ "RFC" ORDER BY lastModified DESC
```

## Labels

```cql
label = "rfc"                             -- pojedynczy
label IN ("rfc", "adr", "decision")       -- OR
label = "rfc" AND space = "ENG"
```

`mcp-confluence.search_pages_by_label` to convenience wrapper który składa CQL z `labels[]` + opcjonalny `space`.

## Macros + content types

```cql
type = "page"                             -- domyślnie
type = "blogpost"
type = "comment"
type = "attachment"
macro = "code"                            -- pages z code blocks
macro = "info"                            -- pages z info panels
```

## Anti-patterns

- ❌ `text ~ "*"` — gigantic scan, wolne.
- ❌ Brak `space =` w large instances — przeszukuje wszystkie spaces.
- ❌ `ORDER BY` bez `LIMIT` — pulls all pages.
- ✅ `space = "ENG" AND type = "page" AND lastModified > now("-30d")` — zawsze scope + okno.

## Common patterns

```cql
-- Recently updated in space
space = "ENG" AND type = "page" AND lastModified > now("-7d") ORDER BY lastModified DESC

-- Pages I authored
contributor = currentUser() AND created > now("-30d")

-- Onboarding-related
space = "ENG" AND (title ~ "onboarding" OR title ~ "getting started" OR title ~ "intro")

-- Architecture decisions
label = "adr" AND space = "ENG" ORDER BY created DESC

-- Pages under a parent
ancestor = "123456" ORDER BY title ASC
```

## Limity

- `/wiki/rest/api/search` max 250 per page, paginowane przez `start`/`limit`.
- `mcp-confluence.search_pages` budget-aware do `budgetTokens` (default 2 500).
