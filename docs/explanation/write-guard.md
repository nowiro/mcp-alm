# Wzorzec write-guard

> Jak mutacje są bramkowane, dlaczego default to read-only, na co audytorzy
> mają patrzeć.

## Problem

LLM-y robią pewne siebie błędy. Model kontrolujący narzędzie Jira może
zdecydować, że skasuje issue, zamknie sprint lub zmieni uprawnienia. Chcemy
powierzchni narzędzi, która:

- **Defaultuje do bezpiecznego** — nic z tego, co model mówi, nie powinno
  mutować stanu bez jawnej zgody człowieka.
- **Jest audytowalna** — jest jedno miejsce, w którym sprawdzasz, czy
  konektor może pisać.
- **Nie wycieka przez error paths** — narzędzie z wyłączonym zapisem, które
  rzuca przy mutacji, musi rzucić **przed** wywołaniem upstream, nie po.

## Wzorzec

Trzypoziomowy guard w [`src/shared/write-guard.ts`](../../src/shared/write-guard.ts):

```typescript
// Tier 1 — mutujące (POST / PATCH / PUT):
export function assertWriteAllowed(toolName: string): void {
  if (!isWriteEnabled()) throw new WriteDeniedError(toolName);
  const allow = parseList('MCP_WRITE_ALLOWLIST');
  // Pusta allowlist = deny. Operatorzy muszą opt-in każde narzędzie jawnie.
  if (allow.size === 0 || !allow.has(toolName)) throw new WriteDeniedError(toolName);
}

// Tier 2 — destruktywne (DELETE / drop): wymaga dodatkowo confirmToken.
export function assertDestructiveAllowed(toolName: string, confirmToken: string | undefined): void {
  assertWriteAllowed(toolName); // dziedziczy Tier 1
  const destructive = parseList('MCP_DESTRUCTIVE_ALLOWLIST');
  if (!destructive.has(toolName)) throw new WriteDeniedError(toolName);
  const expected = process.env['MCP_DESTRUCTIVE_CONFIRM']?.trim();
  if (!expected || expected.length < 16) throw new WriteDeniedError(toolName);
  if (!constantTimeEquals(confirmToken ?? '', expected)) throw new WriteDeniedError(toolName);
}

// Tier 3 — resource-name confirmation: agent echo'wuje nazwę zasobu.
export function assertResourceConfirmation(
  toolName: string,
  actualResourceName: string,
  providedResourceName: string | undefined,
): void {
  if (actualResourceName.length === 0) throw new ConfirmationError(/* safety bail-out */);
  if (typeof providedResourceName !== 'string' || providedResourceName.length === 0) {
    throw new ConfirmationError(/* tell agent which name to echo */);
  }
  if (!constantTimeEquals(providedResourceName, actualResourceName)) {
    throw new ConfirmationError(/* mismatch — wrong resource? */);
  }
}
```

Każde narzędzie, które mutuje stan upstream, woła `assertWriteAllowed` jako
pierwszą akcję **po** walidacji wejścia:

```typescript
async handle(input, ctx) {
  // 1. Zod sparsował już input — tutaj jest typed.
  assertWriteAllowed(ctx.tool);                    // 2. bramkuj zapis
  return await http.request({ method: 'POST', ... }); // 3. wywołaj upstream
}
```

## Read-only jest default

`MCP_WRITE_ENABLED` jest unset lub `false` domyślnie. Flag musi być
ustawiony jawnie przy uruchamianiu serwera:

```bash
MCP_WRITE_ENABLED=true \
MCP_WRITE_ALLOWLIST=jira.create_issue,jira.add_comment \
node dist/server-jira.js
```

Nie ma flagi CLI `--enable-writes`. Nie ma argumentu narzędzia, który by go
zmienił. Nie ma in-process toggle. Flag jest czytany z env raz na początku
każdego wywołania narzędzia.

**Empty allowlist = deny-all** — nawet z `MCP_WRITE_ENABLED=true` brak
wpisów w `MCP_WRITE_ALLOWLIST` blokuje wszystkie zapisy. To celowe — wymaga
explicit opt-in per narzędzie.

## Drugi poziom — destruktywne

Narzędzia, które kasują dane (`*.delete_*`, `*.merge_*`), muszą dodatkowo:

- Być na `MCP_DESTRUCTIVE_ALLOWLIST=…`.
- Otrzymać argument `confirmToken: "<secret>"` pasujący do
  `MCP_DESTRUCTIVE_CONFIRM` (≥ 16 znaków, porównanie constant-time przez
  `crypto.timingSafeEqual`).

Defaulty są **deny-deny**: brak env vars = nic destruktywnego się nie
uruchamia, nawet jeśli Tier 1 jest włączony.

## Trzeci poziom — potwierdzenie nazwy zasobu

`confirmToken` chroni przed wywołaniem destrukcji przez kogoś, kto nie ma
shared secretu — ale nie chroni przed wywołaniem **na złym zasobie**. Agent
LLM, który dostał poprawny token z env, może nadal wpisać niewłaściwe
`pageId` i skasować inną stronę niż chciał.

Tier 3 wymusza, by wywołujący echo'wał bieżącą **nazwę** zasobu (page
title, repo path, issue summary) jako parametr `confirmResourceName`.
Handler woła upstream GET tuż przed delete, czyta `name` / `title` / `path`,
i porównuje constant-time.

```typescript
async handle(input, ctx) {
  assertWriteAllowed(ctx.tool);
  assertDestructiveAllowed(ctx.tool, input.confirmToken);     // tier 2
  const fresh = await http.request({ method: 'GET', path: `/page/${input.pageId}` });
  assertResourceConfirmation(ctx.tool, fresh.title, input.confirmResourceName); // tier 3
  return await http.request({ method: 'DELETE', path: `/page/${input.pageId}` });
}
```

Reguły:

- **Case-sensitive, bez trimowania.** Agent musi wpisać dokładnie ten string,
  który widzi w upstream.
- **Empty actual name = refuse.** Jeśli upstream zwrócił zasób bez nazwy
  (rare, ale możliwe), `ConfirmationError` blokuje delete. Operator musi
  użyć innej ścieżki.
- **Cost: jedno dodatkowe GET przed każdym destruktywnym wywołaniem.**
  Świadomy trade-off — bezpieczeństwo > 50 ms latency.
- **Pattern bierze inspirację z GitHuba** (`Type the repository name to
confirm: …`) i AWS (`Delete this resource? Type the name to confirm.`).

Defaulty są **deny-deny-deny**: brak env vars + brak nazwy = nic
destruktywnego się nie uruchamia. Mismatch nazwy → `ConfirmationError`
(`-32009`), nie `WriteDeniedError` — żeby host (VS Code / IntelliJ) mógł
zasugerować "agent: pobierz aktualną nazwę i powtórz", zamiast "operator:
ustaw env var".

## Co audytorzy powinni sprawdzić

1. **Każde mutujące narzędzie woła `assertWriteAllowed` przed jakimkolwiek
   wywołaniem HTTP upstream.** Narzędzie, które POST'uje bez sprawdzania,
   to bug — otwórz high-priority issue.
2. **`assertWriteAllowed` nie jest bypassowane w testach.** Testy powinny
   ustawić env var jawnie przy weryfikowaniu mutation paths; nigdy nie
   mockuj `assertWriteAllowed`.
3. **Nazwa flagi w kodzie zgadza się z udokumentowaną konwencją.** Drift
   między docs a kodem to smell.
4. **Żadne narzędzie nie czyta flagi samo.** Czytanie env var bezpośrednio
   wewnątrz narzędzia eliminuje centralny audit point — zawsze idź przez
   helper.

## Weryfikacja

Testy kontraktowe muszą zawierać:

```typescript
it('rejects writes when MCP_WRITE_ENABLED is unset', () => {
  delete process.env['MCP_WRITE_ENABLED'];
  expect(() => assertWriteAllowed('jira.create_issue')).toThrow(WriteDeniedError);
});

it('allows writes when env + allowlist are set', () => {
  process.env['MCP_WRITE_ENABLED'] = 'true';
  process.env['MCP_WRITE_ALLOWLIST'] = 'jira.create_issue';
  expect(() => assertWriteAllowed('jira.create_issue')).not.toThrow();
});

it('rejects destructive without confirmToken', () => {
  process.env['MCP_WRITE_ENABLED'] = 'true';
  process.env['MCP_WRITE_ALLOWLIST'] = 'jira.delete_issue';
  process.env['MCP_DESTRUCTIVE_ALLOWLIST'] = 'jira.delete_issue';
  process.env['MCP_DESTRUCTIVE_CONFIRM'] = 'a-secret-min-16-chars';
  expect(() => assertDestructiveAllowed('jira.delete_issue', 'wrong')).toThrow();
});
```

## Dlaczego nie runtime config?

Rozważaliśmy:

- **Runtime toggle przez argument narzędzia.** Odrzucone — przenosi decyzję
  bezpieczeństwa z "użytkownika uruchamiającego serwer" na "model
  wybierający argumenty". Model jest częścią threat model.
- **Runtime toggle przez osobną komendę stdin.** Odrzucone — dodaje nową
  powierzchnię transportu; threat model się komplikuje.
- **Compile-time constant.** Odrzucone — wymagałoby rebuilda żeby flipnąć
  zapisy; ludzie ZNAJDĄ workaround.

Env vars przy starcie procesu trafiają w sweet spot: jawne, scoped,
audytowalne, łatwe do flipowania gdy trzeba.

## Referencje

- [`docs/adr/0003-write-guard-runtime.md`](../adr/0003-write-guard-runtime.md) — decision record.
- [`SECURITY.md`](../../SECURITY.md) — zgłaszanie bypass'u write-guarda.
- [`reference/configuration.md`](../reference/configuration.md#write-guard-dwupoziomowy) — każda env var write-guarda.
