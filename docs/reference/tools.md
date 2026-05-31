# Narzędzia — referencja

Pełna lista narzędzi wystawianych przez każdy z pięciu serwerów MCP.
Inputy są walidowane przez schematy Zod w `src/server-<connector>.ts` —
to jest źródło prawdy, ten dokument jest wygodnym indeksem.

**Konwencje:**

- **Nazwa**: `<server>.<verb>_<noun>` (np. `jira.get_issue`).
- **Klasa**: `read` (bez side effects), `write` (mutacja, deny-by-default),
  `destructive` (wymaga `confirmToken` + resource name).
- **Pagination**: gdzie endpoint upstream paginuje, narzędzie używa
  `extract()` pipeline z `budgetTokens` limitem (default 2500).
- **Response shape**: `{ data, _meta }` envelope — patrz
  [`docs/explanation/observability.md`](../explanation/observability.md).

---

## `mcp-jira`

Źródło: [`src/server-jira.ts`](../../src/server-jira.ts).

### Read

| Tool                     | Klasa | Opis                                                                        |
| ------------------------ | ----- | --------------------------------------------------------------------------- |
| `jira.get_issue`         | read  | Issue po kluczu (`ABC-123`); opcjonalnie z changelogiem, comments, worklog. |
| `jira.search_issues`     | read  | JQL search z budget-aware paginacją (cursor `nextPageToken`).               |
| `jira.bulk_get_issues`   | read  | Wiele issues w jednej rundzie (do 50).                                      |
| `jira.approximate_count` | read  | Szacowana liczba wyników JQL (tańsza od pełnego search).                    |
| `jira.list_projects`     | read  | Wszystkie projekty widoczne dla tokenu.                                     |
| `jira.list_versions`     | read  | Fix-versions / releases projektu (newest first); filtr po statusie.         |
| `jira.list_boards`       | read  | Agile boards (scrum/kanban); filtr po projekcie / typie / nazwie.           |
| `jira.get_board_config`  | read  | Konfiguracja boardu — kolumny (→ statusy) + estimation field.               |
| `jira.get_board_backlog` | read  | Backlog boardu — issues poza sprintami (kandydaci do sprintu).              |
| `jira.list_sprints`      | read  | Sprinty na boardzie; domyślnie `active` + `future`.                         |
| `jira.get_sprint`        | read  | Jeden sprint po id (state, daty, goal).                                     |
| `jira.get_sprint_issues` | read  | Issues w sprincie, budget-aware; opcjonalny JQL.                            |
| `jira.list_transitions`  | read  | Dostępne transitions dla danego issue.                                      |
| `jira.get_comments`      | read  | Comments na issue; ADF rendowany do Markdown.                               |
| `jira.get_worklogs`      | read  | Worklog entries — autor, time spent, started.                               |
| `jira.get_changelog`     | read  | Pełna historia zmian — kto, kiedy, jakie pole z czego na co.                |
| `jira.jql_builder`       | read  | Buduje JQL ze strukturalnego filtra (typesafe Zod schema → string).         |
| `jira.health`            | read  | Smoke test: `/myself` endpoint, waliduje token.                             |
| `jira.get_usage_history` | read  | In-memory ledger ostatnich wywołań w tej sesji.                             |

### Write (deny-by-default — wymaga `MCP_WRITE_ENABLED=true` + allowlist)

| Tool                         | Klasa | Opis                                                                     |
| ---------------------------- | ----- | ------------------------------------------------------------------------ |
| `jira.create_issue`          | write | Tworzy issue (projectKey + summary + issueType). Wspiera `dryRun: true`. |
| `jira.bulk_create_issues`    | write | Wielokrotny create w jednej rundzie.                                     |
| `jira.transition_issue`      | write | Wykonuje transition (np. To Do → In Progress).                           |
| `jira.add_comment`           | write | Dodaje comment; body jako Markdown, konwertowane do ADF.                 |
| `jira.add_worklog`           | write | Time tracking entry.                                                     |
| `jira.link_issues`           | write | Tworzy link (`blocks`, `relates`, …) między issues.                      |
| `jira.move_issues_to_sprint` | write | Przenosi issues do sprintu (do 50 kluczy). Wspiera `dryRun: true`.       |

Brak operacji destruktywnych w Jira surface — `delete_issue` nie jest
wystawiony świadomie.

---

## `mcp-confluence`

Źródło: [`src/server-confluence.ts`](../../src/server-confluence.ts).

### Read

| Tool                               | Klasa | Opis                                                               |
| ---------------------------------- | ----- | ------------------------------------------------------------------ |
| `confluence.get_page`              | read  | Strona po ID lub po (space + title); body w storage/view/markdown. |
| `confluence.search_pages`          | read  | CQL search z budżetem; cursor pagination v2.                       |
| `confluence.search_pages_by_label` | read  | Skrót na CQL `label = "..."`.                                      |
| `confluence.list_spaces`           | read  | Spaces widoczne dla tokenu.                                        |
| `confluence.list_children`         | read  | Dzieci strony (jedna głębokość lub całe drzewo z budżetem).        |
| `confluence.list_ancestors`        | read  | Łańcuch parent → root.                                             |
| `confluence.get_attachments`       | read  | Załączniki strony — nazwa, typ MIME, rozmiar, URL.                 |
| `confluence.get_comments`          | read  | Inline + footer comments na stronie.                               |
| `confluence.health`                | read  | Smoke test: `/current-user`.                                       |
| `confluence.get_usage_history`     | read  | Ledger.                                                            |

### Write

| Tool                     | Klasa | Opis                                                              |
| ------------------------ | ----- | ----------------------------------------------------------------- |
| `confluence.add_comment` | write | Inline / footer comment do strony.                                |
| `confluence.create_page` | write | Nowa strona w przestrzeni (parent + title + body).                |
| `confluence.update_page` | write | Aktualizacja istniejącej (wymaga version dla optimistic locking). |
| `confluence.attach_file` | write | Upload załącznika do strony.                                      |

---

## `mcp-figma`

Źródło: [`src/server-figma.ts`](../../src/server-figma.ts).

Read-only z polityki — REST API Figmy nie ma write surface w
publicznym v1.

| Tool                        | Klasa | Opis                                                               |
| --------------------------- | ----- | ------------------------------------------------------------------ |
| `figma.get_file`            | read  | Cały plik Figmy — drzewo node'ów, components, styles.              |
| `figma.get_file_nodes`      | read  | Wybrane node'y po ID (lekkie od `get_file`).                       |
| `figma.get_image_urls`      | read  | Renderowane URL-e PNG/SVG dla node'ów (1× / 2× / 4×).              |
| `figma.get_comments`        | read  | Comments na pliku.                                                 |
| `figma.list_team_projects`  | read  | Projekty w teamie.                                                 |
| `figma.list_project_files`  | read  | Pliki w projekcie.                                                 |
| `figma.get_team_components` | read  | Components published w teamie.                                     |
| `figma.get_team_styles`     | read  | Styles published w teamie (colors, typography, effects).           |
| `figma.export_tokens`       | read  | Design tokens (W3C-style format) ekstraktowane z published styles. |
| `figma.health`              | read  | Smoke test: `/me`.                                                 |
| `figma.get_usage_history`   | read  | Ledger.                                                            |

---

## `mcp-sonar`

Źródło: [`src/server-sonar.ts`](../../src/server-sonar.ts).

Read-only z polityki — pisanie do quality gate'ów / issues nie jest
wystawione świadomie (mutacja tego stanu to decyzja platform team'u, nie
indywidualnego agenta).

| Tool                          | Klasa | Opis                                                          |
| ----------------------------- | ----- | ------------------------------------------------------------- |
| `sonar.quality_gate`          | read  | Status quality gate'u dla projektu/branch/PR.                 |
| `sonar.get_quality_gate_diff` | read  | Diff QG między dwoma punktami w czasie (branch vs main).      |
| `sonar.list_issues`           | read  | Issues w projekcie z filtrami (severity, type, resolution).   |
| `sonar.list_hotspots`         | read  | Security hotspots — review status, vulnerability probability. |
| `sonar.get_hotspot`           | read  | Szczegóły jednego hotspota.                                   |
| `sonar.list_projects`         | read  | Wszystkie projekty widoczne dla tokenu.                       |
| `sonar.measures`              | read  | Metryki projektu (coverage, duplications, complexity, …).     |
| `sonar.health`                | read  | Smoke test: `/system/status` + `/users/current`.              |
| `sonar.get_usage_history`     | read  | Ledger.                                                       |

---

## `mcp-gitlab`

Źródło: [`src/server-gitlab.ts`](../../src/server-gitlab.ts).

### Read

| Tool                           | Klasa | Opis                                                                  |
| ------------------------------ | ----- | --------------------------------------------------------------------- |
| `gitlab.get_mr`                | read  | Merge request po projektID + IID.                                     |
| `gitlab.list_mrs`              | read  | Lista MR-ów z filtrami (state, author, assignee, target_branch).      |
| `gitlab.list_issues`           | read  | Lista issues z filtrami.                                              |
| `gitlab.list_pipelines`        | read  | Pipeline'y projektu — status, ref, source.                            |
| `gitlab.get_pipeline_jobs`     | read  | Joby pipeline'a — name, stage, status, duration.                      |
| `gitlab.get_job_log`           | read  | Job log z ekstrakcją błędów (head + tail + matched ERROR/FAIL lines). |
| `gitlab.merge_request_changes` | read  | Diff MR-a z budgetem.                                                 |
| `gitlab.get_artifacts`         | read  | Metadata artefaktów (listing, nie download).                          |
| `gitlab.get_commit`            | read  | Commit po SHA — author, message, stats, parent SHAs.                  |
| `gitlab.list_branches`         | read  | Branches projektu z filtrem (regex).                                  |
| `gitlab.get_file_content`      | read  | Content pliku z repo (jedna ścieżka, opcjonalnie ref).                |
| `gitlab.health`                | read  | Smoke test: `/user`.                                                  |
| `gitlab.get_usage_history`     | read  | Ledger.                                                               |

### Write

| Tool                  | Klasa | Opis                                               |
| --------------------- | ----- | -------------------------------------------------- |
| `gitlab.create_issue` | write | Nowy issue (title + description + labels).         |
| `gitlab.create_mr`    | write | Nowy MR (source_branch + target_branch + title).   |
| `gitlab.merge_mr`     | write | Merge MR-a (wymaga MR-a w stanie `can_be_merged`). |

---

## Globalne env vars wpływające na narzędzia

Pełna referencja: [`docs/reference/configuration.md`](configuration.md).

Najważniejsze:

| Env var                       | Domyślnie | Efekt                                                              |
| ----------------------------- | --------- | ------------------------------------------------------------------ |
| `MCP_WRITE_ENABLED`           | `false`   | Włącza warstwę write — bez tego wszystkie write tools blokują się. |
| `MCP_WRITE_ALLOWLIST`         | (pusta)   | Comma-separated dokładne nazwy narzędzi write.                     |
| `MCP_DESTRUCTIVE_ALLOWLIST`   | (pusta)   | Allowlist dla narzędzi klasy destructive.                          |
| `MCP_DESTRUCTIVE_CONFIRM`     | (pusty)   | 16+ znaków, porównywany constant-time z `confirmToken`.            |
| `MCP_ALM_ALLOW_PRIVATE_HOSTS` | `false`   | Pozwala SSRF guardowi przepuścić RFC1918 / loopback.               |
| `MCP_ALM_DISABLE_PROXY`       | `false`   | Wyłącza honorowanie `HTTPS_PROXY` per-proces.                      |
| `HTTPS_PROXY` / `HTTP_PROXY`  | (system)  | Proxy korporacyjne (undici `ProxyAgent` lazy-loaded).              |
| `NO_PROXY`                    | (system)  | Lista hostów omijających proxy.                                    |
| `NODE_EXTRA_CA_CERTS`         | (none)    | PEM bundle z prywatnymi root CA.                                   |
