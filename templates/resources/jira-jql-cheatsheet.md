# JQL Cheatsheet — quick reference

## Najczęstsze operatory

| Operator                    | Przykład                                                       |
| --------------------------- | -------------------------------------------------------------- |
| `=`, `!=`                   | `status = "In Progress"`, `priority != Low`                    |
| `IN`, `NOT IN`              | `status IN (Open, "In Progress", Reopened)`                    |
| `~`, `!~`                   | `summary ~ "auth"` (contains), `description !~ "deprecated"`   |
| `IS`, `IS NOT`              | `assignee IS EMPTY`, `resolution IS NOT EMPTY`                 |
| `>`, `<`, `>=`, `<=`        | `priority > Medium`, `created >= -30d`                         |
| `WAS`, `WAS NOT`, `CHANGED` | `status WAS "In Progress" DURING ("2026-01-01", "2026-02-01")` |

## Funkcje

```jql
assignee = currentUser()
reporter IN membersOf("frontend-team")
sprint IN openSprints()
sprint IN closedSprints()
project IN projectsLeadByUser()
issueLink("blocks", PROJ-100)            -- issues, które blokują PROJ-100
parentEpic = PROJ-100                     -- legacy custom field; nowa konwencja: parent = ...
```

## Daty

- Relatywne: `-7d`, `-30d`, `-2w`, `-1M`, `startOfDay()`, `endOfWeek("-1")`.
- Absolutne: `"2026-05-26"`, `"2026-05-26 10:00"`.

```jql
updated >= -7d AND updated <= now()
created >= startOfDay("-30d")
resolved >= startOfWeek("-1") AND resolved < startOfWeek()
```

## Boolean

```jql
project = PROJ AND status != Done AND (priority IN (High, Highest) OR labels = security)
```

## Sortowanie

```jql
ORDER BY priority DESC, updated DESC
```

## Custom fields

W `mcp-jira` używaj **readable names** (połączone przez `field-registry`):

```jql
"Story Points" >= 5            -- zamiast cf[10016]
"Epic Link" = PROJ-100         -- zamiast customfield_10014
```

`mcp-jira` automatycznie tłumaczy `customfield_NNNNN` ↔ readable name w obu kierunkach.

## Anti-patterns

- ❌ `text ~ "*"` — wildcard everywhere, drogie + niemiarodajne.
- ❌ `ORDER BY` w samym query bez `LIMIT` — pełen scan.
- ❌ `created > "2020"` w large project — nie używa indeksu daty.
- ✅ `project = PROJ AND created >= -30d` — zawsze scope projektu + ograniczone okno.

## Common patterns

```jql
-- My open work
assignee = currentUser() AND resolution = Unresolved ORDER BY priority DESC, updated DESC

-- Sprint board
project = PROJ AND sprint IN openSprints() ORDER BY status, priority DESC

-- Blockers
project = PROJ AND issueLinkType = "is blocked by" AND status != Done

-- Recently resolved
project = PROJ AND resolved >= -7d ORDER BY resolved DESC

-- Unassigned high-priority
project = PROJ AND assignee IS EMPTY AND priority IN (High, Highest)
```

## Limity

- API `/rest/api/3/search/jql` zwraca max 100 issues per call (paginowane przez `nextPageToken`).
- `mcp-jira.search_issues` domyślnie 25, override do 100, walks paginated do `budgetTokens` (default 4 000).
