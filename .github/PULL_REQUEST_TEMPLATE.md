<!--
Tytuł PR / commitu MUSI być Conventional Commits: `type(scope): subject`
Types: feat | fix | docs | style | refactor | perf | test | build | ci | chore | revert
Scopes: jira | confluence | figma | sonar | gitlab | shared | auth | http | write-guard | log | errors | ci | deps | docs | release | security | extract
Przykłady:
  feat(jira): add get_sprint tool
  fix(auth): handle missing JIRA_TOKEN gracefully
  chore(deps): bump @modelcontextprotocol/sdk to 1.30.0
-->

## Podsumowanie

<!-- 1–3 punkty. Co zmienione i dlaczego. Unikaj powtarzania diffu. -->

## Powiązane

- Issue: #
- ADR (jeśli jakikolwiek): docs/adr/

## Typ

- [ ] feat
- [ ] fix
- [ ] refactor
- [ ] perf
- [ ] docs
- [ ] test
- [ ] chore / ci / build

## Scope

- [ ] jira / confluence / figma / sonar / gitlab (konektor)
- [ ] shared / auth / http / write-guard / log / errors
- [ ] ci / deps / docs / release / security
- [ ] extract (pipeline `src/extract-*.ts`)

## Checklist bezpieczeństwa

- [ ] Brak tokenów, secretów ani credentiali w diffie
- [ ] Wartości tokenów są ładowane z env lub `~/.config/mcp-alm/config.json` (nigdy hardcoded)
- [ ] Nagłówki auth nigdy nie docierają do linii logu
- [ ] Mutujące narzędzia wołają `assertWriteAllowed()` przed mutacją
- [ ] Destruktywne narzędzia wołają `assertDestructiveAllowed()` ORAZ akceptują argument `confirmToken`
- [ ] Serwer MCP nigdy nie pisze do stdout (logi idą do stderr)
- [ ] `npm run audit:prod` przechodzi

## Definition of Done

- [ ] `npm run format:check` przechodzi
- [ ] `npm run lint --max-warnings=0` przechodzi
- [ ] `npm run typecheck` przechodzi
- [ ] `npm test` przechodzi
- [ ] `npm run build` przechodzi
- [ ] `npm run ai:validate` przechodzi
- [ ] Commit message + tytuł PR zgodne z Conventional Commits

## Plan testów

<!-- Bulleted checklist, którą reviewer może re-runąć, np. boot serwera + tools/list. -->

-
-

## Ryzyko & rollback

<!-- Co się może zepsuć? Jak cofnąć, jeśli się zepsuje? -->
