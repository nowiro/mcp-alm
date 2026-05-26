# Extract config — szablony

Szablony configów dla pipeline ekstrakcji (`npm run extract:<connector>`). Skopiuj do roota repo pod nazwą `extract.config.<connector>.json` (gitignored), wyedytuj i uruchom.

## Wzorzec użycia

```sh
# macOS / Linux / Git Bash
cp examples/extract-configs/jira.json extract.config.jira.json
npm run extract:jira
```

```powershell
# Windows PowerShell
Copy-Item examples\extract-configs\jira.json extract.config.jira.json
npm run extract:jira
```

Albo wskazując inny path eksplicitnie:

```sh
node dist/extract-jira.js examples/extract-configs/jira.json
```

## Dostępne szablony

| Plik              | Skrypt                       | Co ekstraktuje                                                  |
| ----------------- | ---------------------------- | --------------------------------------------------------------- |
| `jira.json`       | `npm run extract:jira`       | Snapshoty issues per JQL — wraz z changelog, comments, worklog. |
| `confluence.json` | `npm run extract:confluence` | Strony / drzewa / labels — z full body ADF → Markdown.          |
| `gitlab.json`     | `npm run extract:gitlab`     | Issues / MR-y / pipelines / jobs (z notes opcjonalnie).         |
| `sonar.json`      | `npm run extract:sonar`      | Quality gates / issues / hotspots / measures.                   |

## Co commitować

- ✅ **Szablony tutaj (`examples/extract-configs/*.json`)** — bez prawdziwych ID / kluczy.
- ❌ **`extract.config.<connector>.json` w roocie** — gitignored, zawiera Twoje konkretne projekty / JQL.
- ❌ **`output/`** — gitignored, generowany per-run snapshot.

## Dokumentacja pełna

Pełny przewodnik: [`docs/how-to/data-extraction.md`](../../docs/how-to/data-extraction.md).
