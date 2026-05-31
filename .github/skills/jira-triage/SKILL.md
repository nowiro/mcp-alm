---
name: jira-triage
description: Triage a set of Jira issues — group by priority/severity, component, and epic, then propose an order of attack — using the read-only mcp-jira tools (jira.search_issues, jira.bulk_get_issues, jira.get_issue; for a whole sprint or board backlog, jira.get_sprint_issues / jira.get_board_backlog). Use when the user asks to triage, group, or prioritise a backlog, sprint, or JQL filter (e.g. "triage these bugs", "group open issues by component", "what to pick from the current sprint"). Read-only.
---

# jira-triage

Bierze zbiór issues z Jiry i zamienia go w **uporządkowany triage**: pogrupowany wg priorytetu,
komponentu i epika, z propozycją kolejności działania. Read-only.

## Kiedy się uruchamia

Gdy user prosi o triage / grupowanie / priorytetyzację backlogu, sprintu albo filtra JQL
("zrób triage tych bugów", "pogrupuj otwarte issues per komponent", "co brać najpierw z tego sprintu").

## Wejście

- `jql` — zapytanie JQL definiujące zbiór (np. `project = ABC AND status = Open`), **albo**
- `keys` — lista konkretnych kluczy (np. `ABC-1, ABC-2`), **albo**
- `sprintId` / `boardId` — cały sprint lub backlog boardu (id z `jira.list_boards` / `jira.list_sprints`).

## Procedura

1. **`jira.search_issues`** z JQL — zawsze z projekcją `fields` (np.
   `["summary","status","priority","components","parent","updated"]`), żeby pilnować budżetu tokenów.
   Dla listy kluczy użyj **`jira.bulk_get_issues`** zamiast wielu `jira.get_issue`.
   Dla całego sprintu użyj **`jira.get_sprint_issues`** (`sprintId`), a dla backlogu boardu
   **`jira.get_board_backlog`** (`boardId`) — z tą samą projekcją `fields` — zamiast ręcznie pisać JQL `sprint in openSprints()`.
2. **Pogrupuj** — najpierw po `priority`/severity, w obrębie po `components`, potem po epiku (`parent`).
3. **Ustal kolejność** — blockery i `Highest`/`High` najpierw; w remisie świeższe `updated` lub
   issue blokujące innych.
4. **Podsumuj skalę** — ile issues, rozkład per priorytet/komponent, ile bez komponentu/estymaty.

## Format odpowiedzi

1. **Nagłówek** — liczba issues + rozkład per priorytet.
2. **Grupy** — priorytet → komponent → lista `KEY summary (status)`.
3. **Order of attack** — ponumerowana lista top 5–10 z `KEY`, jednozdaniowym „dlaczego teraz".
4. (opcjonalnie) „Chcesz, żebym dla #1 ściągnął pełny opis (`jira.get_issue`)?"

## Czego NIE robić

- **Nie zmieniaj** statusów, nie komentuj, nie przypisuj — `transition`/`comment`/`assign` to zapis
  (write-guarded). Triage jest read-only.
- Nie pobieraj issue po jednym, jeśli `jira.bulk_get_issues` załatwia to jednym wywołaniem.
- Nie ciągnij pełnych opisów dla wszystkich — projekcja `fields` najpierw, detale na żądanie.
