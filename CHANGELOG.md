# Changelog

Wszystkie znaczące zmiany w tym projekcie są dokumentowane w tym pliku.

Format bazuje na [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), a
projekt stosuje [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`.github/workflows/release.yml`** — workflow publikujący `@nowiro/mcp-alm` na npm registry przy push tagów `v*`. Uses `npm publish --provenance --access public` (SLSA-3-grade attestation). Pre-flight: repo owner ustawia secret `NPM_TOKEN` (Automation token scoped do `@nowiro` org).
- **`README.md`** — sekcja "Uruchomienie bez klonowania (npx)" pokazująca `mcp.json` snippet z `npx -y -p @nowiro/mcp-alm <bin>` dla VS Code Copilot Chat oraz Claude Desktop / Cursor. Bez `git clone`, bez `npm install`, bez `npm run build` po stronie usera.
- **MCP Resources** (`resources/list` + `resources/read`) — każdy z 5 serwerów eksponuje read-only docs ładowane przez Copilot jako deterministyczny kontekst. URIs: `mcp-jira://docs/{jql-cheatsheet,custom-fields-guide}`, `mcp-confluence://docs/cql-cheatsheet`, `mcp-gitlab://docs/pipeline-patterns`, `mcp-sonar://docs/severity-guide`, `mcp-figma://docs/design-tokens-spec`. Token saving: cheatsheet ładowany raz, cache'owany przez Copilot Chat — bez halucynacji JQL/CQL syntax.
- **`src/shared/resource.ts`** — `ResourceDefinition` + `defineResource` + helper `defineMarkdownResource({ uri, name, description, file })` który resolwuje path z `templates/resources/<file>.md` przez `import.meta.url` (działa cross-platform niezależnie od `cwd` callera).
- **`templates/resources/`** — 6 markdown źródeł: `jira-jql-cheatsheet.md`, `jira-custom-fields-guide.md`, `confluence-cql-cheatsheet.md`, `gitlab-pipeline-patterns.md`, `sonar-severity-guide.md`, `figma-design-tokens-spec.md`. Edytowalne bez restartu Copilota.
- **`README.md`** — sekcja "MCP Resources — preconfigured docs context" z tabelą URI + wzorcem użycia w VS Code Copilot Chat.

### Changed

- **`package.json`** — pakiet przygotowany do publikacji na npm:
  - `name` → `@nowiro/mcp-alm` (scoped),
  - usunięte `"private": true`,
  - dodane `homepage`, `repository`, `bugs`, `keywords`,
  - `files: ["dist","README.md","LICENSE","CHANGELOG.md"]` ogranicza tarball do prebuiltu + metadanych,
  - `publishConfig: { access: "public", provenance: true }`,
  - `scripts.prepublishOnly: "npm run build"` gwarantuje świeży `dist/` w tarballu.
- **`src/shared/mcp-server.ts`** — `StartOptions` rozszerzone o `resources: readonly ResourceDefinition[]`; serwer rejestruje teraz `ListResourcesRequestSchema` + `ReadResourceRequestSchema` z capability `resources: {}`.
- **SHA-pinning wszystkich GitHub Actions** — `actions/checkout`, `actions/setup-node`, `actions/upload-artifact`, `amannn/action-semantic-pull-request`, `gitleaks/gitleaks-action`, `ossf/scorecard-action`, `github/codeql-action/upload-sarif` w `ci.yml`, `pr-checks.yml` i `scorecard.yml` zmienione z floating tag (np. `@v4`) na konkretne commit SHA. OpenSSF Scorecard przestanie flagować "Pinned-Dependencies". `release.yml` startuje z floating tags + TODO do spinowania przed merge na main.
- **`README.md`** + **`CHANGELOG.md`** — `<your-org>` → `nowiro`.

## [1.1.0] — 2026-05-25

### Added

- **`LICENSE`** (MIT) — wcześniej brak pliku, `package.json#license` było `UNLICENSED`. Zharmonizowano z `CODE_OF_CONDUCT.md` + `CONTRIBUTING.md` (open source posture).
- **`examples/extract-configs/README.md`** — instrukcje use'owania szablonów configów (cross-platform: `cp` na POSIX, `Copy-Item` na PowerShell).
- **CI matrix Windows + macOS + Linux** — `verify` job uruchamia się na 3 OS równolegle przez `strategy.matrix.os`. Coverage + dist artifacts upload tylko z Linuxa (deduplikacja). Wcześniej: tylko `ubuntu-latest`.

### Changed

- **`package.json#license`** — `UNLICENSED` → `MIT`. Bez tego forki / contributions były niejasne prawnie.
- **`src/shared/user-config.ts`** — `REPO_SLUG` jest teraz **dynamiczny**: resolwowany z `$MCP_ALM_REPO_SLUG` env (override) lub `package.json#name` (walk-up z `import.meta.url`), z fallbackiem na literal `'mcp-alm'`. Po forku pod inną nazwę config dir podąża za package name automatycznie.
- **`AGENTS.md`** — przepisany jako **cienki pointer** (~95 → ~60 LoC). Pełen rulebook nadal w `.github/copilot-instructions.md`; AGENTS.md zawiera tylko skrót i mapę instrukcji.
- **`extract.config.*.example.json` × 4** przeniesione z roota repo do **`examples/extract-configs/`** (bez `.example.` w nazwie). `docs/how-to/data-extraction.md` i `.gitignore` zaktualizowane.

### Removed

- 4 pliki `extract.config.{jira,confluence,gitlab,sonar}.example.json` z roota repo (przeniesione do `examples/extract-configs/`).

## [Older entries]

### Added

- **Deterministyczny pipeline ekstrakcji** (druga bramka równoległa do MCP) — `src/extract-jira.ts` i `src/extract-confluence.ts`. Reusuje 100% kodu reshape (`jira-reshape`, `confluence-reshape`, `adf`, `field-registry`), ale parametry pochodzą z committed configu zamiast od agenta. Output: per-zasób JSON + Markdown + `_manifest.json`. Use case: snapshoty / compliance audit / eval-sety / reproducible bug reports. Szczegóły w [`docs/how-to/data-extraction.md`](docs/how-to/data-extraction.md). Run: `npm run extract:jira` / `npm run extract:confluence`.
- `extract.config.jira.example.json`, `extract.config.confluence.example.json` — szablony configów (prawdziwe configi są gitignored).
- `src/extract-jira.spec.ts`, `src/extract-confluence.spec.ts`, `src/extract-gitlab.spec.ts`, `src/extract-sonar.spec.ts` — testy ExtractConfig schemy (defaulty, walidacja, discriminated unions) + deterministic snapshot testy rendererów.
- `src/extract-jira.spec.ts` — fixture roundtrip dla `buildExtractedIssue` (6 testów z `toMatchInlineSnapshot`): minimal raw → canonical shape, ADF description → Markdown, changelog → normalized entries, attachments → normalized list, `snapshot.include` flags respektowane, deep-equal + bit-for-bit JSON identyczność dwóch runów. Strażnik determinizmu output shape'u — każdy nieświadomy refactor reshape / extras zostanie zatrzymany przez inline snapshot diff.
- `buildExtractedIssue` i `RawIssue` exportowane z `src/extract-jira.ts` — interfejs do testów fixture (nie część runtime API; ale stabilizujemy pod kątem snapshot stability).
- `src/extract-gitlab.ts` + `extract.config.gitlab.example.json` — pipeline dla GitLab (snapshot types: `issues`, `mrs`, `pipelines`). Per-zasób JSON/Markdown + manifest. Notes pobierane przez `/notes` endpoint, opcjonalne `changes` summary dla MR-ów, listing jobów per pipeline.
- `src/extract-sonar.ts` + `extract.config.sonar.example.json` — pipeline dla SonarQube/SonarCloud (snapshot types: `quality_gate`, `issues`, `hotspots`, `measures`). Najlepszy use case to cron-ed QG snapshots dla compliance (diff over time). Output to jeden `_summary.{json,md}` per snapshot (płaska natura danych).
- [`docs/adr/0007-extract-pipeline-second-gateway.md`](docs/adr/0007-extract-pipeline-second-gateway.md) — formalna decyzja architektoniczna o dwóch bramkach nad `src/shared/`.
- Scope `extract` w `commitlint.config.mjs` i `.github/PULL_REQUEST_TEMPLATE.md` — Conventional Commits dla zmian w pipeline'ach.

### Changed

- `AGENTS.md` — sekcja "Dwie bramki" + wpis w tabeli "Gdzie idzie nowa praca": deterministyczny pipeline → `src/extract-<connector>.ts`.
- `docs/explanation/architecture.md` — obie bramki w "Kształt w skrócie" + layout repo.
- **DRY refactor pipeline'ów ekstrakcji** — nowy `src/shared/extract-runtime.ts` z helperami współdzielonymi przez 4 skrypty (`snapshotNameSchema`, `renderFormatsSchema`, `createScriptLogger`, `loadJsonConfig`, `parseCursorFromLink`, `writePipelineOutputs`, `writeManifest`, `runIfMain`). Każdy `extract-*.ts` skrócony o ~40 linii boilerplate'u (`log`/`loadConfig`/`isDirectInvocation`/inline writers). +19 testów. Zachowane behavior — wszystkie 327 testów dalej pass.
- **DRY refactor MCP serwerów**:
  - `usageHistoryTool(serverName)` w `src/shared/mcp-server.ts` — factory zastępujący 5× zduplikowany `defineTool({ name: '<server>.get_usage_history', ... })` block. Każdy `server-*.ts` dodaje tylko `usageHistoryTool(SERVER_NAME)` do listy tools.
  - `createNamedHttpClient(name, auth)` w `src/shared/http-client.ts` — wrapper nad `createHttpClient` z konwencyjnymi opcjami (`userAgent`, `serverName`, `serverVersion`). Zastępuje 9× (5 serwerów + 4 extract-scripts) identyczny 5-linijkowy options block.
  - `bootMcpServerIfEnabled(options)` w `src/shared/mcp-server.ts` — wrapper nad `startMcpServer` respektujący `MCP_NO_BOOT=true` escape hatch. Zastępuje 5× zduplikowany 3-linijkowy `if` gate na końcu każdego `server-*.ts`. Magic env-var name jest teraz w jednym miejscu — łatwiej renamować w przyszłości.
  - Usuniete dead `sessionTracker` imports + `GetUsageHistoryInput` schemy z 5 serwerów (po przejściu na factory pattern). Usunięty unused `startMcpServer` import gdzie zastąpiony przez `bootMcpServerIfEnabled`.
  - Stale JSDoc nad `export { tools }` (5×, referencujący nieistniejący `gen-tools-docs.mjs`) zastąpiony jednoliniowym komentarzem forwardującym do `bootMcpServerIfEnabled` — zero stale references.
- `docs/how-to/add-connector.md` — szablon kodu nowego serwera używa teraz `createNamedHttpClient`, `bootMcpServerIfEnabled`, `usageHistoryTool` zamiast 8-linijkowego boilerplate'u; doc trzyma się aktualnej powierzchni shared.
- **`buildManifest(scriptName, startedAt, snapshot, extras)` w `src/shared/extract-runtime.ts`** — centralizuje wspólny envelope manifestu (`snapshot`, `runStartedAt`, `runFinishedAt`, `render`, `tooling`) zamiast 4× powtarzać te same pola w każdym `extract-*.ts`. Pipeline'y podają tylko `extras` (jql / type / projectId / itemCount / itemIds). +3 testy. Removed `version`/`getRepoVersion` import z 4 extract scripts (helper liczy version internally).
- Usuniete dead `ExtractConfigT` exports z 4 extract-\*.ts (zero call sitów).
- **`adfToMarkdownSafe`** wyciągnięty do `src/shared/adf.ts` — tolerant wrapper nad `adfToMarkdown` dla `unknown` inputu (zwraca `undefined` zamiast `''` dla pustego). Usuwa duplikację identycznego `adfToMd` helpera z `extract-jira.ts` i `extract-confluence.ts`. +4 testy.
- `eslint.config.mjs` — `security/detect-non-literal-fs-filename` off także dla `src/shared/extract-runtime.ts` (te same przesłanki co dla `user-config.ts`).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SUPPORT.md` — standardowy pakiet OSS dla ludzi (dla agentów: dalej `AGENTS.md` + `.github/instructions/`).
- `.github/ISSUE_TEMPLATE/{bug,feature,config}.yml` — strukturalne formularze issue (YAML, GitHub forms).
- `.editorconfig`, `.nvmrc` (Node 22), `.npmrc` (`engine-strict=true`) — spójność edytora i wersji Node.
- `vitest.config.ts` — eksplicytna konfiguracja zamiast defaultów; coverage thresholds startowe 50% (do podniesienia po zmierzeniu baseline).
- `tools/scripts/dev-client.mjs` — minimalny klient stdio do ręcznego testowania serwerów MCP bez IDE.
- `.github/workflows/scorecard.yml` — OpenSSF Scorecard (weekly cron, opt-in publish dopiero gdy repo publiczne).
- `docs/reference/tools.md` — pełna referencja narzędzi (~50) każdego serwera z klasą read/write/destructive.
- `docs/how-to/troubleshooting.md` — recipe-style fixy dla najczęstszych failure modes (401, SSRF, TLS, proxy, write-guard).
- `docs/explanation/observability.md` — logger, in-memory ledger, `_meta` envelope, outbound headers, brak external stack i dlaczego.

### Changed

- `package.json#license`: `MIT` → `UNLICENSED` (pasuje do `private: true`; brak `LICENSE` w repo).
- `README.md` — usunięta sekcja "Licencja" i license badge.
- `.gitignore` — usunięta stała wzmianka `pnpm run bom` (skrypt nigdy nie istniał); `sbom-*.json` pattern zostaje defensywnie.
- CHANGELOG — fix wprowadzającego w błąd opisu uruchamiania (`npx mcp-<connector>` było obietnicą bez pokrycia, bo pakiet jest `private`); compare links używają `<your-org>` zamiast `OWNER`.
- `.github/workflows/README.md` — udokumentowany nowy `scorecard.yml` + TODO dla SHA pinningu actions.

## [1.0.0] — 2026-05-22

Pierwsza stabilna wersja `mcp-alm`. Wcześniejsze wersje 0.x były internal
pre-release; ich szczegóły zostały zarchiwizowane. Ten wpis opisuje **stan
as-is w 1.0.0**, nie historię zmian.

### Powierzchnia

- **5 serwerów MCP** (stdio transport): `mcp-jira`, `mcp-confluence`, `mcp-figma`, `mcp-sonar`, `mcp-gitlab`.
- Każdy serwer ma wpis `bin` w `package.json` (`mcp-<connector>` → `dist/server-<connector>.js`) i może być uruchomiony przez `node dist/server-<connector>.js` lub po `npm link` jako `mcp-<connector>` na PATH. Pakiet jest `private: true` — nie publikuje się na npm.
- Naming narzędzi: `<server>.<verb>_<noun>` (np. `jira.get_issue`, `confluence.search_pages`, `gitlab.list_mrs`).
- Pełna lista narzędzi: tabela "Co dostajesz" w [`README.md`](README.md).

### Security — write-guard trzypoziomowy

- **Tier 1 (mutating)**: `MCP_WRITE_ENABLED=true` + dokładna nazwa narzędzia na `MCP_WRITE_ALLOWLIST`. Pusta allowlist = deny-all.
- **Tier 2 (destructive)**: dodatkowo nazwa na `MCP_DESTRUCTIVE_ALLOWLIST` + `confirmToken` matching `MCP_DESTRUCTIVE_CONFIRM` (≥ 16 znaków, porównanie `crypto.timingSafeEqual`).
- **Tier 3 (resource-name confirmation)**: agent dodatkowo echo'wuje bieżącą nazwę zasobu (page title, repo path, issue summary) jako `confirmResourceName`. Handler fetchuje zasób tuż przed mutacją i porównuje constant-time. Chroni przed wrong-resource delete'em nawet gdy `confirmToken` jest poprawny.
- Defaulty: **deny-deny-deny**. Brak env vars / brak nazwy = nic destruktywnego się nie uruchamia.

### Security — input / output

- Każde narzędzie MCP ma Zod schema dla inputu. Brak `any` na granicach.
- SSRF guard w `src/shared/http-client.ts` blokuje loopback / RFC1918 / link-local / IPv6 ULA. Opt-in dla on-prem przez `MCP_ALM_ALLOW_PRIVATE_HOSTS=true`.
- Logger redaktuje rekursywnie wartości pod kluczami `authorization`, `*-token`, `*-key`, `password`, `secret`, `cookie`, `x-figma-token`. Stdout zarezerwowany dla transportu MCP — logi idą wyłącznie do stderr.
- Token storage: process env lub `~/.config/mcp-alm/config.json` (POSIX `0600`). Nigdy w repo.

### Intranet / enterprise

- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` honorowane natywnie przez undici `ProxyAgent` (lazy-loaded — non-proxy envs pay zero cost).
- `NODE_EXTRA_CA_CERTS` walidowane przez `npm run doctor` — bundle z prywatnymi root CA dla Jira Data Center / GitLab self-hosted / SonarQube on-prem.
- `MCP_ALM_DISABLE_PROXY=true` dla local-dev z aktywnym system-wide corporate proxy.

### IDE support

- **VS Code ≥ 1.121** — natywna rejestracja MCP przez `.vscode/mcp.json` z per-tool approval. Współpraca z GitHub Copilot.
- **IntelliJ IDEA ≥ 2026.1.2** — import szablonu `.idea/mcp-servers.example.xml` przez wbudowany AI Assistant.

### Wymagania

- **Node.js 22+** (ESM, native `fetch`). Wymóg zadeklarowany w `package.json#engines.node` (`>=22.0.0`), walidowany przez `npm ci` i `npm run doctor`.
- **npm** (lockfile `package-lock.json` committed; `npm ci` w CI).
- **TypeScript 5.9** (devDependency, nie wymaga się od konsumenta).

### Diagnostyka

- `npm run doctor` — env vars, proxy detection, CA bundle, Node version vs `package.json#engines.node`.
- `npm run verify` — `format:check` + `lint` + `typecheck` + `test` + `build` + `ai:validate`.
- `<server>.health` tool na każdym serwerze — smoke-test upstream + token validity.

### Stabilne API od 1.0.0

- **MCP tool surface** — zestaw narzędzi w każdym serwerze. Nowe są dodawane minorem; istniejące nie znikają bez majora.
- **Env vars** — `JIRA_*`, `CONFLUENCE_*`, `FIGMA_*`, `SONAR_*`, `GITLAB_*`, `MCP_WRITE_*`, `MCP_DESTRUCTIVE_*`, `MCP_ALM_*`. Pełna referencja: [`docs/reference/configuration.md`](docs/reference/configuration.md).
- **User-config schema** — `~/.config/mcp-alm/config.json` z polami `<connector>.{baseUrl,email,token}`. Schema w [`src/shared/user-config.ts`](src/shared/user-config.ts).
- **Kody błędów JSON-RPC** — `-32001` AuthError, `-32002` NotFoundError, `-32003` RateLimitError, `-32004` UpstreamError, `-32005` WriteDeniedError, `-32007` ValidationError, `-32008` SecurityError, `-32009` ConfirmationError. Pełna referencja: [`docs/reference/error-codes.md`](docs/reference/error-codes.md).

### Powiązane

- [`docs/explanation/architecture.md`](docs/explanation/architecture.md) — komponenty, sekwencje, diagram.
- [`docs/explanation/security-architecture.md`](docs/explanation/security-architecture.md) — model zagrożeń, defence in depth.
- [`docs/explanation/write-guard.md`](docs/explanation/write-guard.md) — szczegóły wszystkich trzech tier'ów.
- [`docs/adr/`](docs/adr/) — formalne decyzje architektoniczne (ADR-y 0001–0006).

[unreleased]: https://github.com/nowiro/mcp-alm/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/nowiro/mcp-alm/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/nowiro/mcp-alm/releases/tag/v1.0.0
