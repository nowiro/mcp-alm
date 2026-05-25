---
applyTo: '**/*.md'
description: Split PL/EN — polski dla prozy, angielski dla kodu, gita, powierzchni czytanych przez tooling
---

# Konwencja językowa

| Powierzchnia                                                                                                        | Język                                                                    | Dlaczego                                                                      |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Czat z użytkownikiem                                                                                                | **Polski**                                                               | Użytkownik to preferuje; może przełączyć na angielski na żądanie.             |
| Proza w dokumentach (`README.md`, `SECURITY.md`, `AGENTS.md`, `CHANGELOG.md`, `docs/**.md`, `.github/**.md`, ADR-y) | **Polski**                                                               | Czytane przez ludzi; polski to język ojczysty zespołu.                        |
| Kod (`src/**`, `tools/**`, testy)                                                                                   | **Angielski**                                                            | Czytane przez kompilator, LLM i external kontrybutorów.                       |
| Identyfikatory (nazwy plików, funkcji, typów)                                                                       | **Angielski**                                                            | Tooling zakłada ASCII identifiers.                                            |
| Historia git (subject commitów, nazwy branchów)                                                                     | **Angielski**                                                            | Tooling-friendly; scope Conventional Commits jest angielski.                  |
| Stringi `description` narzędzi MCP                                                                                  | **Angielski**                                                            | Wysyłane do LLM przy każdym `tools/list`. Polski tokenizuje się ~1.4× drożej. |
| Inline code comments                                                                                                | Angielski przy wyjaśnianiu **co**, może polski dla niuansów **dlaczego** | Komentarze służą głównie ludziom robiącym review.                             |

## Reguły praktyczne

1. **Descriptions narzędzi MCP są angielskie.** Pojawiają się w kontekście
   LLM przy każdym `tools/list`. Polski jest 30-40 % droższy w tokenach.
2. **Identyfikatory w kodzie są angielskie.** Nazwy zmiennych, funkcji,
   typów, plików. To dotyczy też opisów testów.
3. **Proza w dokumentach defaultuje do polskiego.** Mieszane zespoły PL/EN
   znajdują PL prozę z EN identyfikatorami jako najłatwiejszą do czytania
   i najmniej podatną na błędy.
4. **Nazwy plików i struktura katalogów są angielskie.** Nawet polskie
   docs żyją pod `docs/getting-started/quickstart.md`, nie
   `docs/start/szybki-start.md`.
5. **Git** — branche i subject commitów po angielsku; body commita może
   być po polsku, jeśli ułatwia zrozumienie zmiany.

## Notatki dla agentów AI (GitHub Copilot, MCP-aware coding agents)

1. **Proza w czacie: polska** (chyba że użytkownik przełączy).
2. **Generowany kod, commity, opisy narzędzi: angielski.**
3. **Nowa proza w dokumentach defaultuje do polskiego** (zgodnie z tabelą
   wyżej).
