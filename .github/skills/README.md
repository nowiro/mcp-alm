# .github/skills/ — Copilot Agent Skills

> **Status: active.** Agent Skills to stabilna funkcja GitHub Copilota (VS Code agent mode,
> Copilot CLI, cloud agent), oparta o otwarty standard [agentskills.io](https://agentskills.io).
> Ten katalog jest **auto-discovered** przez Copilota — każdy podkatalog `<name>/SKILL.md`
> to jeden skill. Nie trzeba żadnego ustawienia w `.vscode/settings.json`.

## Czym jest skill (i jak ma się do prompt / agent / instruction)

Skill = folder z instrukcją (i opcjonalnie skryptami/zasobami), który **Copilot sam ładuje
gdy uzna za potrzebne** — na podstawie pola `description`. Działa _progressive disclosure_:
metadata zawsze w kontekście, treść `SKILL.md` dopiero przy dopasowaniu do zadania, a dodatkowe
pliki dopiero gdy instrukcja je zreferencjonuje. Dzięki temu wiele skilli nie zapycha okna kontekstu.

| Katalog                                  | Cel                                             | Wywołanie         | Status    |
| ---------------------------------------- | ----------------------------------------------- | ----------------- | --------- |
| `.github/prompts/*.prompt.md`            | Slash-commands (`/release`, `/security-review`) | ręczne `/<name>`  | **Used**  |
| `.github/agents/*.agent.md`              | Wewnętrzne persony ładowane przez orchestrator  | przez chatmode    | **Used**  |
| `.github/chatmodes/*.chatmode.md`        | Tryby widoczne w VS Code mode pickerze          | dropdown          | **Used**  |
| `.github/instructions/*.instructions.md` | Auto-applied rules (`applyTo: <glob>`)          | automat per glob  | **Used**  |
| `.github/copilot-instructions.md`        | Repo-wide instrukcje top-priority               | każda sesja       | **Used**  |
| **`.github/skills/<name>/SKILL.md`**     | Reusable, parametric task; model decyduje kiedy | **model-decided** | **Ready** |

Reguła rozdziału **prompt vs skill**:

- **prompt** — single-shot, użytkownik świadomie wpisuje `/<name>` (np. `release`, `security-review`).
- **skill** — model sam sięga, gdy `description` pasuje do zadania; może dołączać bundled skrypty.

## Format (stable — agentskills.io)

Każdy skill to **folder**, a nie pojedynczy plik:

```
.github/skills/
  <skill-name>/
    SKILL.md          # wymagany
    scripts/          # opcjonalnie (np. .mjs wołane z instrukcji)
    examples/         # opcjonalnie
```

`SKILL.md` to Markdown z YAML frontmatter:

```markdown
---
name: pr-mr-review
description: Review a GitLab merge request line by line via the mcp-gitlab read tools and return the review in chat. Use when the user asks to review an MR/PR. Read-only — does not post to GitLab.
---

# Treść — kroki, przykłady, referencje do scripts/…
```

Reguły formatu:

- Wymagane pola: `name` + `description`.
- `name` **musi** równać się nazwie folderu; dozwolone `a-z`, `0-9`, `-`; maks. 64 znaki.
- `description` ≤ 1024 znaki — to ono decyduje o auto-matchowaniu, więc opisz **co** robi i **kiedy** użyć (po angielsku, zgodnie z language policy dla opisów konsumowanych przez tooling).
- Auto-discovery z `.github/skills/` — **bez** żadnego settingu. (Dodatkowe lokalizacje: `chat.agentSkillsLocations`; dziedziczenie z parent repo: `chat.useCustomizationsInParentRepositories`.)
- Otwarty standard — `SKILL.md` z `.claude/skills/` można 1:1 skopiować lub symlinkować tutaj.

Walidacja: `npm run ai:validate` sprawdza obecność `name`/`description`, regułę `name == folder`
oraz to, że skille leżą w podkatalogach (nie luzem jako flat `*.md`). Logika w
[`tools/scripts/validate-ai-config.mjs`](../../tools/scripts/validate-ai-config.mjs), sekcja 6.

## Stan w tym repo

Dziś: **brak skilli** — katalog zawiera tylko ten README. Kandydaci do portu z `.github/prompts/`
→ skill (reusable, model-decided, mogą wołać skrypty), gdy zdecydujemy się ruszyć:

- **pr-mr-review** — line-by-line review MR/PR z komentarzami postowanymi via GitLab/GitHub.
- **jira-triage** — triage i grupowanie issues z Jiry (severity, komponenty, epiki).
- **confluence-to-spec** — strona Confluence → ustrukturyzowany spec MD.

Uwaga na kontrakt repo: connectory `mcp-alm` są **read-first, write-guarded**. Każdy skill,
który potrafi pisać (komentarz w MR, transition w Jirze), musi respektować ten guard i jawnie
prosić o potwierdzenie zapisu — patrz [`.github/instructions/connectors.instructions.md`](../instructions/connectors.instructions.md).

## Historia decyzji

- Wcześniej ten katalog był **placeholderem** „czekamy na stable spec GitHuba; nie wymyślaj formatu".
- Spec jest stabilny: GitHub Copilot ogłosił Agent Skills 2025-12-18, wsparcie `SKILL.md` w VS Code
  (agent mode) ustabilizowane ~2026-04. README zaktualizowane **2026-05-29** — placeholder → active.
- Najwcześniejszy sygnał (zachowany dla kontekstu): spec-kit 0.8.12 provisioning `.github/skills/`.

## Źródła

- [VS Code — Use Agent Skills](https://code.visualstudio.com/docs/copilot/customization/agent-skills)
- [GitHub Docs — About agent skills](https://docs.github.com/en/copilot/concepts/agents/about-agent-skills)
- [Changelog — Copilot now supports Agent Skills (2025-12-18)](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/)
