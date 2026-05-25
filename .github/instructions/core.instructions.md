---
applyTo: '**'
description: Reguły core mcp-alm — aplikują się do każdego pliku
---

# Reguły core

Te reguły są nienegocjowalne. Nadpisują wszystko inne **z wyjątkiem** jawnej
instrukcji użytkownika w czacie. Pliki niższego priorytetu (inne reguły,
prompty, workflows) rozszerzają je, ale nigdy nie osłabiają.

Ten plik pracuje w parze z [`principles.instructions.md`](principles.instructions.md) — tam są
_inżynierskie_ zasady (DRY, SOLID, KISS, YAGNI).

## 1. Prawda przed akcją

1.1 Przeczytaj odpowiedni kod zanim ogłosisz, że go znasz. Nigdy nie
wymyślaj ścieżek plików, nazw funkcji, wersji pakietów ani API.
1.2 Gdy nie masz pewności, otwórz upstream docs (Atlassian, Figma, SonarQube,
GitLab REST API, `@modelcontextprotocol/sdk`, Zod). Cytuj źródło w odpowiedzi.
1.3 Pamięć ≠ ground truth — najpierw weryfikuj przeciw repo.

## 2. Najmniejsza rozsądna zmiana

2.1 Bug fix zmienia tylko to, co potrzebne dla buga. Żadnych drive-by
refactorów.
2.2 Nowy feature używa istniejących prymitywów (`extract`, `BudgetTracker`,
`HttpClient`, `assertWriteAllowed`) zanim wprowadzi nowe.
2.3 Trzy podobne linie są lepsze niż przedwczesna abstrakcja.
2.4 Żadnych pół-skończonych implementacji. Jeśli krok nie może się
zakończyć, ujawnij blocker i zatrzymaj się — nie zaklejaj go.

## 3. Odwracalność i blast radius

3.1 Zawsze bezpieczne: edycja plików w `src/`, `docs/`; uruchamianie testów,
lintu, typecheck.
3.2 Najpierw potwierdź: usuwanie plików, force-push, mutowanie shared infra,
publikowanie pakietów.
3.3 Zabronione bez jawnej zgody użytkownika: `--no-verify`, `git reset
--hard`, history rewrites, zapis sekretów do tracked file, otwieranie PR
przeciw `main` z czerwonym CI.

## 4. Definition of Done

Zmiana jest **done** tylko gdy wszystko z `npm run verify` przechodzi
lokalnie:

- ✅ `npm run format:check`
- ✅ `npm run lint` (`--max-warnings=0`)
- ✅ `npm run typecheck`
- ✅ `npm test`
- ✅ `npm run build`
- ✅ `npm run ai:validate`
- ✅ Conventional commit message + scoped PR description
- ✅ Docs zaktualizowane gdy behaviour się zmienia

## 5. Komunikacja

5.1 Bądź zwięzły. Stwierdzaj wyniki i decyzje; pomijaj narrację.
5.2 Cytuj ścieżki plików jako `path/to/file.ts:42` żeby użytkownik mógł
kliknąć.
5.3 Ujawniaj niepewność — powiedz "nie wiem, oto jak się dowiedzieć" zanim
zgadniesz.
5.4 Na końcu tury: jedno zdanie co się zmieniło, jedno co dalej.

## 6. Logi decyzji

6.1 Decyzje architektoniczne idą do `docs/adr/NNNN-<slug>.md` (template
MADR).
6.2 Większe zmiany feature są streszczane w `CHANGELOG.md` przy release.

## 7. Forbidden patterns

- ❌ API keys / sekrety w source, komentarzach, commit messages, plikach
  `.github/`.
- ❌ `any` (TypeScript) poza uzasadnionymi, skomentowanymi wyjątkami.
- ❌ `console.log` z serwera (stdout to MCP transport — używaj
  `src/shared/log.ts` → stderr).
- ❌ Default exports poza plikami config.
- ❌ `axios` lub inny HTTP klient — tylko natywny `fetch` przez
  `src/shared/http-client.ts`.
- ❌ Pomijanie **Definition of Done** bo zmiana "wygląda mała".
- ❌ Commit tokena gdziekolwiek (env / user-profile config / nigdzie indziej).
