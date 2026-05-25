# 0002 — Zod dla walidacji input narzędzi

- Status: accepted
- Data: 2026-05-08
- Decision-makers: maintainers
- Consulted: maintainers
- Informed: kontrybutorzy

## Kontekst i problem

Każde narzędzie MCP otrzymuje `arguments` jako `unknown` z warstwy
JSON-RPC. Potrzebujemy runtime-safe sposobu walidacji kształtu input'u i
produkcji typed values, oraz walidacji outputów przed ich zwróceniem.
Model może halucynować nazwy pól, typy, zakresy; chcemy fail fast i jasno.

## Decision drivers

- **Single source of truth** — schema narzędzia, jego typ i wystawiony
  JSON Schema w `tools/list` powinny wszystkie wywodzić się z jednej
  definicji.
- **Runtime, nie compile-time** — typy TypeScript znikają w runtime;
  potrzebujemy parsera, który rzuca przy mismatchu.
- **Boundary contract** — output validation łapie schema drift między
  kodem a docs.
- **Ecosystem fit** — TypeScript SDK MCP używa Zod-style validation w
  swoich własnych przykładach.

## Rozważone opcje

1. **Zod (wybrane).**
2. **TypeBox** (JSON Schema-first, derywacja typu przez TS infer).
3. **`io-ts`** (functional, Either-typed).
4. **Hand-written runtime checks.**

## Wybrana decyzja

Wybrana **opcja 1**: Zod dla każdego `Input` narzędzia. Wzorzec:

```typescript
const Input = z.object({ ... });
type InputT = z.infer<typeof Input>;
```

MCP factory automatycznie konwertuje schema Zod do JSON Schema dla
`tools/list` przez wbudowany `z.toJSONSchema()` (Zod 4).

### Konsekwencje

- ➕ Jedna schema → zarówno compile-time types jak i runtime validation.
- ➕ Generacja JSON Schema dla `tools/list` natywnie przez Zod 4
  (`z.toJSONSchema()`) — żadna dodatkowa zależność.
- ➕ Testy kontraktowe trywialnie round-trip: parse fixture; porównaj do
  schema.
- ➕ Używane szeroko w ekosystemie MCP — łatwy onboarding.
- ➖ Jedna więcej zależność. Mityguje to fakt, że Zod jest już
  transitive dependency `@modelcontextprotocol/sdk`.
- ➖ Zod 4 przyniósł breaking changes z v3; pinujemy major.

## Plusy i minusy

### Opcja 1 — Zod (wybrane)

- ➕ Battle-tested.
- ➕ Concise schemas.
- ➕ Excellent TS inference.
- ➖ Trochę perf cost vs hand-written; negligible przy częstotliwościach
  wywołań narzędzi MCP.

### Opcja 2 — TypeBox

- ➕ JSON Schema to source; mniej translation potrzebne dla `tools/list`.
- ➖ Bardziej verbose dla nested objects.
- ➖ Mniejsza społeczność niż Zod.

### Opcja 3 — io-ts

- ➕ Functional purity.
- ➖ Steep learning curve.
- ➖ Runtime cost noticeable.

### Opcja 4 — Hand-written

- ➕ Zero dependencies.
- ➖ Każda schema zduplikowana jako type i check.
- ➖ Niespójności gwarantowane w repo z 5 serwerami.

## Plan implementacji

- [x] Adoptuj Zod w `src/shared/mcp-server.ts` (`ToolDefinition` niesie
      schema).
- [x] Każde narzędzie definiuje `Input` Zod schema.
- [x] Każdy `handle()` woła `Input.parse(args)` najpierw (przez factory).
- [x] Generuj JSON Schema dla `tools/list` przez `z.toJSONSchema()` w
      `src/shared/json-schema.ts`.

## References

- [Kontrakt narzędzia](../../.github/instructions/connectors.instructions.md) — co narzędzia muszą zaimplementować.
- [`zod`](https://github.com/colinhacks/zod) — upstream library.
