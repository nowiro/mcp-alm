---
mode: agent
description: Resolve open [?] placeholders in a docs/specs spec via structured Q&A, then re-validate. The clarify step of the SDD ladder (specify → clarify → plan → analyze → implement). Writes only the target spec.md and never fabricates — unanswered items stay draft. Use when a scaffolded spec still has [?] before planning.
---

# /clarify — domknij spec przed planem

Zamienia placeholdery `[?]` w `docs/specs/<slug>/spec.md` w konkrety przez **ustrukturyzowane Q&A**,
zanim powstanie plan i kod. Środkowy krok drabiny SDD:

```
specify (workflow:<verb>) → /clarify → plan → /analyze → implement
```

Scaffolder (`workflow:new-connector` / `workflow:add-tool`) zostawia `[?]` w sekcjach specu, a
`validate-sdd.mjs` traktuje `[?]` w nie-draft specie jako błąd. Ten prompt jest **resolverem** tych
dziur. Pisze wyłącznie do docelowego `spec.md`, w obrębie sandboxa `PROJECT_ROOT`.
Kanon: `mcp-workspace/docs/sdd/methodology.md`.

## Wejście

- `/clarify <slug>` — konkretny spec, **albo**
- bez argumentu — przeskanuj `docs/specs/*/spec.md` po `[?]`, pokaż kandydatów i zapytaj który.

## Procedura

1. **Zbierz luki.** Wypisz każdą linię `[?]` z nagłówkiem sekcji (`## Kontekst`, `## User story`,
   `## Acceptance criteria`, `## Success metrics`, `## Non-goals`, `## Open questions`). Dołóż luki
   implicytne: AC nie w formie Given/When/Then, metryki bez liczb, nieostry zakres.
2. **Pytaj pojedynczo.** Jedno pytanie naraz, najpierw `Acceptance criteria` i zakres. Do każdego
   **zaproponuj konkretny default/opcje**. Limit ~5–7 pytań na przebieg — resztę zostaw jako `[?]`.
3. **Zapisz odpowiedzi do specu:** podmień `[?]` in-place; dopisz sekcję `## Clarifications` z logiem
   `data — pytanie → odpowiedź`; gdy **nie został żaden `[?]`**, ustaw frontmatter `status: clarified`.
4. **Re-waliduj.** Uruchom `npm run sdd:check`. Flip do `clarified` przejdzie tylko, gdy wszystkie `[?]`
   są domknięte (skrypt wymusza uczciwość). Zaraportuj green/red.
5. **Hand-off.** Zaproponuj `/analyze`, a potem implementację (delegacja do specjalisty).

## Format odpowiedzi

- W trakcie: pojedyncze pytania z proponowanym defaultem.
- Na koniec: lista domkniętych `[?]` (sekcja → wartość), status specu (`draft` / `clarified`),
  wynik `sdd:check` i następny krok.

## Czego NIE robić

- **Nie zmyślaj.** „Nie wiem / pomiń" → zostaw `[?]` i **trzymaj `status: draft`**.
- Nie dotykaj kodu ani planu — `/clarify` rusza tylko `spec.md`.
- Nie wychodź poza `PROJECT_ROOT`. Nie zadawaj 15 pytań naraz — sekwencyjnie, priorytet na to, co blokuje plan.
