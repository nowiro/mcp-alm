# Jira custom fields — guide dla mcp-jira

## Problem

Jira REST API zwraca custom fields jako `customfield_NNNNN: <value>` w issue payload. Modele LLM nie znają tych ID — czytanie `customfield_10042: 5` nic nie mówi.

## Rozwiązanie: field-registry

`mcp-jira` przy starcie ładuje `/rest/api/3/field` (cached na proces) i mapuje:

```
customfield_10016 ↔ "Story Points"
customfield_10014 ↔ "Epic Link"
customfield_10005 ↔ "Sprint"
```

Wszystkie tool responses tłumaczą ID → readable name automatycznie. JQL też akceptuje readable names:

```jql
"Story Points" >= 5         -- działa, mcp-jira tłumaczy na cf[10016]
"Epic Link" = PROJ-100
```

## Workflow w narzędziach

| Tool                      | Customfield handling                                                    |
| ------------------------- | ----------------------------------------------------------------------- |
| `jira.get_issue`          | Zwraca pole `fields` z **readable names** jako keys.                    |
| `jira.search_issues`      | To samo + `fields: ["Story Points","Sprint"]` przyjmowany w request.    |
| `jira.create_issue`       | Akceptuje `customFields: { "Story Points": 5, "Sprint": "Sprint 23" }`. |
| `jira.bulk_create_issues` | Per row `customFields` mapa, applied w batch.                           |

## Common custom fields (Atlassian Cloud default)

| ID                  | Readable name | Type               |
| ------------------- | ------------- | ------------------ |
| `customfield_10000` | Development   | string (dev panel) |
| `customfield_10005` | Sprint        | array<sprint>      |
| `customfield_10014` | Epic Link     | string (issue key) |
| `customfield_10016` | Story Points  | number             |
| `customfield_10018` | Rank          | string (lexorank)  |
| `customfield_10100` | Account       | option             |

**Uwaga:** ID są **per-instance** — Twój `customfield_10016` może być inny niż w innej organizacji. Zawsze fetchuj registry od żywej instancji (mcp-jira robi to automatycznie).

## Anti-patterns

- ❌ Hardcoding `customfield_NNNNN` w klientowym kodzie — łamie się przy migracji instancji.
- ❌ Zapytania bez registry: `cf[10016] >= 5` — działa, ale nieprzezroczyste.
- ❌ Cache registry per-call — zbyt drogie. Cache per-process; reset przy SIGHUP jeśli admin zmienił schema.
- ✅ Używaj readable names wszędzie: `"Story Points" >= 5`.

## Debugging

Jeśli pole nie pojawia się jako readable name:

1. `jira.health()` zwróci `fieldsRegistered: <count>` — sprawdź czy registry załadowane.
2. Pole może być w trybie `restricted` (per project) — registry widzi pole, ale dostęp tool-call zwraca puste.
3. Pole może być deprecated → fetchowane jako `customfield_NNNNN` (registry nie ma mapowania) — eskaluj do admin.
