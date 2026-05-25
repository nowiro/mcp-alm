# 0005 — Natywny fetch, bez axios

- Status: accepted
- Data: 2026-05-08
- Decision-makers: maintainers
- Informed: kontrybutorzy

## Kontekst i problem

Konektory potrzebują klienta HTTP. Node 22+ shipuje natywny fetch.
Musimy wybrać, czego użyć w greenfield code w tym repo.

## Decision drivers

- **Powierzchnia supply-chain** — mniej deps = mniej audit findings,
  mniejsze node_modules, szybsze installs.
- **Długoterminowa stabilność** — natywny fetch Node jest teraz stable;
  axios churni więcej niż spec, który implementuje.
- **Niższa attack surface** — każda dodatkowa zależność to coś do
  audytu, łatania i zaufania w supply chain. `fetch` jest wbudowany.

## Rozważone opcje

1. **Natywny fetch (wybrane).**
2. **axios.**
3. **node-fetch (polyfill).**
4. **undici bezpośrednio (underlying impl Node).**

## Wybrana decyzja

Wybrana **opcja 1**: każde wywołanie HTTP idzie przez `globalThis.fetch`
przez `src/shared/http-client.ts`, który dodaje nagłówki auth,
redaction-aware logging, retries, timeouts, dedup, ETag cache i SSRF
guard.

undici (underlying Node fetch impl) jest lazy-loaded **tylko** dla
`ProxyAgent`, gdy ustawione jest `HTTPS_PROXY` / `HTTP_PROXY`. Inaczej
nawet ten import się nie wykonuje.

### Konsekwencje

- ➕ Zero nowych deps dla HTTP.
- ➕ Jedna mniej reguła ESLint do utrzymania (no `no-restricted-imports`
  przeciw axios).
- ➕ Spec-compliant; działa tak samo w Node i każdym toolingu, który
  mockuje fetch (np. `vi.fn()` w vitest).
- ➖ Mniej ergonomic API niż axios dla niektórych wzorców (interceptors,
  automatic JSON parsing); wrapujemy luki w `http-client.ts`.

## Plusy i minusy

### Opcja 1 — Natywny fetch (wybrane)

- ➕ Wbudowany.
- ➕ Standardowy.
- ➖ Verbose dla prostych przypadków; mitygowane przez wrapper.

### Opcja 2 — axios

- ➕ Ergonomic.
- ➕ Battle-tested.
- ➖ ~150 KB; jedno więcej do audytu.
- ➖ Miał swoje CVE.

### Opcja 3 — node-fetch

- ➕ Stable API.
- ➖ Pre-Node-18 polyfill; dodaje dep, który jest teraz redundant.

### Opcja 4 — undici direct

- ➕ Lowest-level; maximum control.
- ➖ Więcej kodu do napisania; benefits nie materializują się przy naszej
  skali.

## Plan implementacji

- [x] `src/shared/http-client.ts` wraps `globalThis.fetch`.
- [x] undici lazy-loaded tylko dla `ProxyAgent`.
- [x] Testy używają `vi.fn()` do mockowania fetch.

## References

- [Natywny fetch w Node](https://nodejs.org/docs/latest-v22.x/api/globals.html#fetch) — upstream docs.
- [`.github/instructions/principles.instructions.md`](../../.github/instructions/principles.instructions.md) — zasady KISS / YAGNI, które to followuje.
