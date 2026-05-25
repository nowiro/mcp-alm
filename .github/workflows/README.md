# GitHub Actions

Lekkie workflows. End-to-end poniżej 4 minut na czystym cache.

| Plik                             | Trigger                    | Cel                                                                                 |
| -------------------------------- | -------------------------- | ----------------------------------------------------------------------------------- |
| [`ci.yml`](ci.yml)               | push, pull_request         | format check · lint · typecheck · test (z coverage) · build · `ai:validate` · audit |
| [`pr-checks.yml`](pr-checks.yml) | pull_request               | Conventional Commits per commit + tytuł PR + secret scan (gitleaks, pełna historia) |
| [`scorecard.yml`](scorecard.yml) | weekly cron + push to main | OpenSSF Scorecard — branch protection, signed commits, supply-chain hygiene → SARIF |

## Oczekiwane ustawienia repo

- **Branch protection na `main`** z wymaganymi status checkami: `Lint ·
typecheck · test · build`, `Production dependency audit (high+)`,
  `Conventional commits`, `PR title format`, `Secret scan (full repo)`.
- **`package-lock.json` jest committed** — `npm ci` wymusza
  deterministyczny install.
- **Brak GitHub Advanced Security wymagany.** Brak workflow CodeQL tutaj;
  static-analysis pokrywa `typescript-eslint` strict-type-checked +
  `eslint-plugin-security` + production audit job.
- **Scorecard** jest opt-in dla publicznego repo. Workflow jest dodany,
  ale `publish_results` jest `false` — przełącz na `true` gdy repo
  staje się public i chcesz profil na `scorecard.dev/viewer`.

## TODO — SHA pinning actions

Workflows używają floating tagów (`@v4`, `@v5`). Dla projektu z explicit
security posture rekomenduje się pinowanie do SHA (`@<40-char-sha>` z
komentarzem wersji obok). Dependabot z `versioning-strategy: increase`
będzie aktualizował te SHA przy nowych releaseach. Wymaga jednorazowego
audytu SHA → na razie nie zrobione, świadomy trade-off.

## Lokalne odpowiedniki

Każdy krok CI ma jedno-liniowy odpowiednik lokalny:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run ai:validate
npm run audit:prod
```

`npm run verify` uruchamia całą lokalną Definition of Done jednym strzałem.
