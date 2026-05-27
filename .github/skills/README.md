# .github/skills/ — forward-compat placeholder

> **Status: empty (placeholder).** Ten katalog rezerwujemy pod ewentualny przyszły
> Copilot pattern `.github/skills/`. Dziś (2026-05) nie istnieje jeszcze stable
> spec ze strony GitHub Copilot — używamy `.github/prompts/` + `.github/agents/`.

## Dlaczego ten katalog istnieje (pusty)

[github/spec-kit](https://github.com/github/spec-kit) zaczął provisioning'ować
`.github/skills/` on demand podczas instalacji extension/preset (release 0.8.12,
2026-05-20). Sygnał, że GitHub Copilot prawdopodobnie wprowadzi ten katalog jako
nową kategorię artefaktów obok prompts/agents/instructions. Trzymamy placeholder
żeby:

1. **Reservować nazwę katalogu** — uniknąć kolizji gdy ten layout się ustabilizuje.
2. **Dokumentować decyzję** — czytelnik widzi `skills/` i wie z czego on jest, a nie szuka commitu.
3. **Ułatwić migrację** — gdy spec się ustabilizuje, dodajemy `*.skill.md` tutaj zamiast szukać i rozmieszczać po raz pierwszy.

## Co prompts / skills / instructions / agents znaczą u nas dziś

| Katalog                                                         | Cel dziś (stable)                                                                                                                                             | Status          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| [`.github/prompts/`](../prompts/)                               | Slash-commands w Copilot Chat (`/release`, `/diagnose`, …). Frontmatter `mode: agent\|edit\|ask` + `description`. Manualnie wywoływane przez `/<promptname>`. | **Used**        |
| [`.github/agents/`](../agents/)                                 | Custom chat modes (orchestrator, connector-author, …). VS Code 1.121+ wybiera z dropdownu nad inputem. Frontmatter `description` + `tools: [...]`.            | **Used**        |
| [`.github/instructions/`](../instructions/)                     | Auto-applied rules z polem `applyTo: <glob>`. Załadowane przy każdej sesji do plików matching glob.                                                           | **Used**        |
| [`.github/copilot-instructions.md`](../copilot-instructions.md) | Repo-wide instrukcje top-priority. Załadowane przy każdej sesji.                                                                                              | **Used**        |
| **`.github/skills/`** (tutaj)                                   | _TBD._ Czekamy na stable GitHub Copilot spec. Spec-kit już provisioning'uje, ale to ich extension catalog, nie naszą.                                         | **Placeholder** |

## Plan migracji (gdy spec się ustabilizuje)

Memory item w `ai-workspace/PLAN.md` przewidywał ten ruch: _"GitHub Copilot może
wprowadzić `.github/skills/` jako alternative do `.github/prompts/`. Nasz aktualny
setup (`prompts/*.prompt.md` + `agents/*.agent.md`) jest stable dziś, ale za
6-12 miesięcy może być deprecated/legacy."_

Triggery do działania:

- [ ] GitHub Copilot zaanonsował `chat.skillFilesLocations` lub analog w VS Code settings
- [ ] spec-kit lub Microsoft docs dokumentuje stable `.skill.md` frontmatter shape
- [ ] Pierwszy real-world example w community-catalog

Wtedy: portuj subset `.github/prompts/*.prompt.md` które bardziej pasują do "skill" (reusable, parametric task) niż "prompt" (single-shot slash-command). Update `.vscode/settings.json` żeby wskazywał na ten katalog.

## Co NIE robić

- **Nie wymyślaj formatów.** Brak frontmatter convention w tej chwili — czekamy na GitHub. Pisanie naszych `.skill.md` teraz = guaranteed rework.
- **Nie kopiuj zawartości** z `.github/prompts/`. To dziś działa; w przyszłości może migracja, ale dziś duplikuje.
- **Nie dodawaj `chat.skillFilesLocations`** do `.vscode/settings.json`. VS Code go nie zna i może wyrzucić warning.

## Źródło sygnału

- [spec-kit 0.8.12 commit `e54653e`](https://github.com/github/spec-kit/commit/e54653e) — _"fix: create skills directory on demand during extension/preset install"_
- Memory: `C:\Users\wojtek\.claude\projects\C--github\memory\PLAN.md` (ai-workspace)
