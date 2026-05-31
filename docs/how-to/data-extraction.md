# Data extraction — deterministyczny pipeline

> **Wspierane konektory**: Jira, Confluence, GitLab, SonarQube/SonarCloud.
> Figma celowo pominięta — REST API Figmy operuje na drzewach node'ów,
> nie na "zasobach" w sensie ekstrakcji compliance.

mcp-alm wystawia dwie bramki do tej samej warstwy ekstrakcji:

1. **MCP stdio** (głównych pięć serwerów) — interactive, agent (Copilot)
   decyduje co i jak wołać. **Niedeterministyczne z definicji**: dla "tej
   samej rozmowy" Copilot może wybrać inne narzędzie, inne parametry,
   inny zakres pól.

2. **Skrypty `extract-*.ts`** — non-interactive, parametry pochodzą z
   committed configu. **Deterministyczne**: dla identycznego configu i
   identycznego stanu upstreamu output jest bit-for-bit identyczny
   (modulo daty `updated` / `version`).

Obie bramki dzielą 100% kodu reshape (`jira-reshape.ts`,
`confluence-reshape.ts`, `adf.ts`, `field-registry.ts`) — gdy poprawisz
projekcję pola dla MCP, propaguje się do snapshotów też.

## Kiedy używać której bramki

| Cel                                                       | Bramka               |
| --------------------------------------------------------- | -------------------- |
| Eksploracja, ad-hoc query w środku zadania                | MCP (Copilot)        |
| Code review wspierany przez "pokaż mi tę stronę"          | MCP (Copilot)        |
| Snapshot stanu projektu do raportu                        | Skrypt `extract-*`   |
| Compliance audit: "zrzuć wszystkie issues z X co miesiąc" | Skrypt + cron        |
| Reproducible bug report: "tu są dokładnie te dane"        | Skrypt + commit JSON |
| Trening eval-setów dla LLM                                | Skrypt (snapshot)    |

## Quickstart

```sh
# 1. Build
npm run build

# 2. Skopiuj szablon configu z examples/extract-configs/ do roota (prawdziwy config jest gitignored)
#    macOS / Linux / Git Bash:
cp examples/extract-configs/jira.json extract.config.jira.json
#    Windows PowerShell:
#    Copy-Item examples\extract-configs\jira.json extract.config.jira.json
# Wyedytuj JQL pod swój projekt

# 3. Uruchom
npm run extract:jira
```

Output ląduje w `./output/jira/<snapshot-name>/`:

```
output/jira/active-bugs/
  ABC-101.json        # canonical shape — pełne dane
  ABC-101.md          # human-readable rendering
  ABC-102.json
  ABC-102.md
  ...
  _manifest.json      # metadata runa: JQL, timestamp, lista kluczy, wersja toolingu
```

## Config — Jira

```jsonc
{
  "outputDir": "./output/jira",
  "snapshots": [
    {
      "name": "active-bugs", // [a-z0-9-], używane jako podkatalog
      "jql": "project = ABC AND status != Done", // dowolny JQL
      "maxIssues": 500, // safety cap (max 10 000)
      "include": {
        "changelog": true, // pełna historia zmian
        "comments": true, // wszystkie komentarze (ADF → MD)
        "worklog": true, // worklog entries
        "attachments": true, // lista załączników (metadata, nie pliki)
        "renderedFields": true, // expand renderedFields w response
      },
      "render": ["json", "markdown"], // wymagany min. 1 element
    },
  ],
}
```

## Config — GitLab

3 typy snapshotów (`discriminatedUnion` po `type`). `projectId` może być numeryczny (`"12345"`) lub path (`"group/subgroup/project"`):

```jsonc
// 1. Issues z filtrami (state, labels)
{
  "name": "open-issues",
  "type": "issues",
  "projectId": "group/project",
  "state": "opened",          // "opened" | "closed" | "all"
  "labels": "bug,P1",         // opcjonalnie — comma-separated
  "maxItems": 500,
  "includeNotes": true,       // pełna lista notes per issue
  "render": ["json", "markdown"]
}

// 2. MR-y z opcjonalnym pociągnięciem zmian (changes summary)
{
  "name": "merged-mrs",
  "type": "mrs",
  "projectId": "group/project",
  "state": "merged",          // "opened" | "closed" | "merged" | "locked" | "all"
  "maxItems": 200,
  "includeNotes": true,
  "includeChanges": true,     // doładuj listę zmienionych plików (`/changes` endpoint)
  "render": ["json", "markdown"]
}

// 3. Pipeline'y + listing jobów per pipeline
{
  "name": "main-pipelines",
  "type": "pipelines",
  "projectId": "group/project",
  "ref": "main",              // opcjonalnie zawęża do brancha
  "maxItems": 100,
  "includeJobs": true,
  "render": ["json", "markdown"]
}
```

Per item zapisywane jest do `output/gitlab/<snapshot>/{issue,mr,pipeline}-<id>.{json,md}` plus `_manifest.json` z metadanymi runa.

## Config — SonarQube / SonarCloud

4 typy snapshotów — quality gate / issues / hotspots / measures. Sonar jest najlepszym kandydatem na cron-ed compliance snapshoty (QG status co tydzień, diff over time):

```jsonc
// 1. Quality Gate — typowy compliance audit
{
  "name": "qg-main",
  "type": "quality_gate",
  "projectKey": "my-project",
  "branch": "main",            // opcjonalnie
  "render": ["json", "markdown"]
}

// 2. Issues — listowanie z filtrem severity/type
{
  "name": "critical-bugs",
  "type": "issues",
  "projectKey": "my-project",
  "severities": ["CRITICAL", "BLOCKER"],
  "types": ["BUG"],
  "maxItems": 1000,
  "render": ["json", "markdown"]
}

// 3. Security hotspots
{
  "name": "hotspots-to-review",
  "type": "hotspots",
  "projectKey": "my-project",
  "status": "TO_REVIEW",       // "TO_REVIEW" | "REVIEWED"
  "maxItems": 500,
  "render": ["json", "markdown"]
}

// 4. Measures — metryki projektu (coverage, ncloc, bugs, ...) — jeden fetch
{
  "name": "core-measures",
  "type": "measures",
  "projectKey": "my-project",
  "metrics": ["coverage", "duplicated_lines_density", "ncloc", "bugs"],
  "render": ["json", "markdown"]
}
```

Inaczej niż w Jira/Confluence/GitLab — Sonar pisze **jeden plik per snapshot** (`_summary.json` + `_summary.md`) zamiast pliku per zasób. Wynika to z natury danych: QG status to jedna wartość, lista issues jest płaska, measures to tabela metryk.

## Config — Confluence

3 typy snapshotów (`discriminatedUnion` po `type`):

```jsonc
// 1. Jedna strona
{ "name": "team-charter", "type": "page", "pageId": "123456789", "render": ["json", "markdown"] }

// 2. Strona + descendants (BFS do `depth` poziomów)
{
  "name": "engineering-handbook",
  "type": "tree",
  "rootPageId": "987654321",
  "depth": 3,                  // 1 = sam root, 2 = root + dzieci, …
  "maxPages": 200,             // safety cap (max 5 000)
  "render": ["json", "markdown"]
}

// 3. Wszystkie strony z danym labelem (opcjonalnie zawężone do space)
{
  "name": "rfcs",
  "type": "label",
  "label": "rfc",
  "space": "ENG",              // opcjonalne — bez = całość organizacji
  "maxPages": 500,
  "render": ["json", "markdown"]
}
```

Per strona pobierane jest:

- Body (ADF → Markdown, **bez** 5 000-char cap z `confluence.get_page` —
  pipeline ściąga pełną treść)
- Comments (footer **+** inline; oba endpointy, paginowane)
- Attachments (metadata)
- Labels
- Ancestors (path od roota)
- Children (ID-ki — żeby móc zrekonstruować drzewo offline)

## Determinizm — co gwarantujemy

✅ **Te same parametry + ten sam stan upstreamu = identyczny output** (modulo daty).

Gwarancje pochodzą z:

- Reshape funkcje są **czyste** (input → output, brak side effects)
- Klucze w output są w **stałej kolejności** (jira-reshape ma `key → id →
url → summary → status → …` zakodowane jako stała kolejność literałów)
- Paginacja jest **deterministyczna** — extract-jira sortuje po
  `ORDER BY` z JQL (jeśli go nie podasz, kolejność Jira może być
  niestabilna — **podaj zawsze**)
- HTTP client robi retry z jitter, ale wynik finalny jest niezależny od
  kolejności prób
- JSON serializacja używa `JSON.stringify(_, null, 2)` — deterministyczna

❌ **Czego NIE gwarantujemy:**

- Daty `updated`, `version`, `created` (zmieniają się z każdym edytem
  upstream — to nie nasz pipeline)
- Tożsamości plików gdy w międzyczasie ktoś dodał/usunął issue
- Identyczności gdy między runami zmieniono `customfield_*` mapowanie
  (registry pobiera z upstream)

## Snapshot testing — porównywanie runów

Najprostszy pattern dla "wykryj zmianę":

```sh
# Pierwszy run = baseline
npm run extract:jira
cp -r output/jira/active-bugs fixtures/snapshots/jira-active-bugs-baseline

# Kolejny run = comparison
npm run extract:jira
diff -ru fixtures/snapshots/jira-active-bugs-baseline output/jira/active-bugs | \
  grep -v '"updated":' | grep -v 'runStartedAt' | grep -v 'runFinishedAt'
```

Filtrujemy daty bo te z definicji się zmieniają. Wszystko inne — różnica
= sygnał (issue zmieniony, nowy comment, etc.).

## Security

Wszystkie kontrole z głównego serwera obowiązują **identycznie**:

- Token loadowany z env lub `~/.config/mcp-alm/config.json` (POSIX 0600)
- SSRF guard blokuje RFC1918 chyba że `MCP_ALM_ALLOW_PRIVATE_HOSTS=true`
- HTTPS_PROXY / NODE_EXTRA_CA_CERTS honorowane
- Outbound headers `User-Agent`, `X-MCP-Server: extract-jira` (różny od
  `mcp-jira` dla audit-loga) — możesz filtrować na upstream tymi nagłówkami
- Brak `assertWriteAllowed` — skrypty są **read-only** z definicji, nie
  ma writes w surface

**Output committed do repo?** Twoja decyzja:

- `output/` jest gitignored domyślnie (safe default)
- Jeśli chcesz commitować snapshoty do raportów, **najpierw zweryfikuj
  manualnie**, że JSON-y nie zawierają wrażliwych danych (tickety
  security, custom fieldy z PII, etc.)

## Scheduling (opcjonalnie)

Pipeline ekstrakcji (`npm run extract:jira`, `extract:confluence`, …) to zwykłe skrypty CLI —
zautomatyzujesz je **dowolnym** schedulerem (cron, Windows Task Scheduler, systemd timer, runner
CI Twojego wyboru). Repo celowo **nie** dorzuca żadnego workflowu.

Wymagania: tokeny trzymaj w env / secret store (nigdy w repo — patrz `SECURITY.md`); zadbaj o
politykę retencji snapshotów (`output/` jest gitignored). Lokalizacja secretów + retencja to
decyzja firmowa, nie kod repo.
