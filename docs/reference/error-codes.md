# Kody błędów

> Kody błędów JSON-RPC, które serwery mogą rzucić, z przyczyną i remediacją.

Protokół MCP używa [obiektów błędów JSON-RPC 2.0](https://www.jsonrpc.org/specification#error_object).
Definiujemy stabilny zestaw kodów w `src/shared/errors.ts`, definiowany raz
i reużywany przez każdy serwer.

## Kody custom mcp-alm

| Kod      | Nazwa               | Kiedy                                                                                                                                                                                | Remediacja                                                                                                                                                                                                                                      |
| -------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-32001` | `AuthError`         | Upstream zwrócił 401 / 403; token brakuje, jest unieważniony lub ma niewystarczający scope.                                                                                          | Sprawdź `JIRA_TOKEN` / `CONFLUENCE_TOKEN` / … w env lub `~/.config/mcp-alm/config.json`. Jeśli ważny, sprawdź, że scope jest wystarczający.                                                                                                     |
| `-32002` | `NotFoundError`     | Upstream zwrócił 404 (issue not found, page not found, file not found).                                                                                                              | Sprawdź, że identyfikator (issue key, page id, ścieżka pliku) istnieje w upstream.                                                                                                                                                              |
| `-32003` | `RateLimitError`    | Upstream zwrócił 429. HTTP client retry'uje z jittered backoff respektując `Retry-After`.                                                                                            | Zmniejsz `budgetTokens` / `limit`; sprawdź czy nie biegnie wiele równoległych wywołań do tego samego upstream.                                                                                                                                  |
| `-32004` | `UpstreamError`     | Upstream zwrócił 5xx, nieprawidłowy JSON lub przekroczył 50 MB body cap.                                                                                                             | Spróbuj ponownie z backoff; sprawdź upstream status page. Jeśli persistent, sprawdź `npm run doctor`.                                                                                                                                           |
| `-32005` | `WriteDeniedError`  | Mutujące narzędzie wywołane, ale write-guard tier 1/2 odmówił (`MCP_WRITE_ENABLED` false, `MCP_WRITE_ALLOWLIST` pusty, brak `MCP_DESTRUCTIVE_CONFIRM`, mismatch confirmToken).       | Ustaw env vars zgodnie z [`reference/configuration.md`](configuration.md#write-guard-trzypoziomowy). Przeczytaj najpierw [`explanation/write-guard.md`](../explanation/write-guard.md).                                                         |
| `-32007` | `ValidationError`   | Input narzędzia naruszył constraint semantyczny (np. mutually-exclusive params, business-rule check). Schemat Zod parsuje surowe typy; ten kod łapie reguły, których Zod nie wyraża. | Popraw argumenty wywołania zgodnie z `description` narzędzia. Jeśli komunikat nie jest jasny, otwórz issue.                                                                                                                                     |
| `-32008` | `SecurityError`     | Defence-in-depth guard zadziałał (path traversal w GitLab file API, SSRF preflight, …). Caller jest zbugowany albo złośliwy.                                                         | Nie omijaj guarda — sprawdź input. Path traversal jest blokowany świadomie.                                                                                                                                                                     |
| `-32009` | `ConfirmationError` | Tier 3 odmówił: `confirmResourceName` brakuje, jest puste, albo nie matchuje bieżącej nazwy zasobu (case-sensitive, no trimming).                                                    | Agent: zrób najpierw GET na zasobie, przeczytaj nazwę (`title` / `path` / `name`), echo'uj dokładnie jako `confirmResourceName`. Patrz [`explanation/write-guard.md`](../explanation/write-guard.md#trzeci-poziom--potwierdzenie-nazwy-zasobu). |

## Standardowe kody JSON-RPC

| Kod      | Nazwa            | Kiedy                                                      | Remediacja                                                                            |
| -------- | ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `-32700` | Parse error      | Serwer dostał malformed JSON.                              | Napraw kodowanie JSON hosta; prawie nigdy nie widoczne z `@modelcontextprotocol/sdk`. |
| `-32600` | Invalid Request  | JSON jest valid, ale nie jest poprawnym żądaniem JSON-RPC. | Sprawdź `jsonrpc`, `method`, `params`.                                                |
| `-32601` | Method not found | `method` nie jest znaną metodą MCP.                        | Użyj `tools/list`, `tools/call`, itd.                                                 |
| `-32602` | Invalid params   | Metoda istnieje, ale parametry są błędne.                  | Dopasuj do sygnatury metody.                                                          |
| `-32603` | Internal error   | Nieobsłużony wyjątek w handlerze narzędzia.                | Złóż bug report; stderr log ma stack trace.                                           |

## Mapowanie błędów HTTP upstream

| Status HTTP | Mapowany na              | Notatki                                                                                 |
| ----------- | ------------------------ | --------------------------------------------------------------------------------------- |
| 401, 403    | `AuthError(-32001)`      | Token zły, expired lub niewystarczający scope. Re-issue token; sprawdź wymagane scopes. |
| 404         | `NotFoundError(-32002)`  | Identyfikator nie istnieje lub token go nie widzi.                                      |
| 429         | `RateLimitError(-32003)` | HTTP client honoruje nagłówek `Retry-After` (cap 30 s) i ponawia.                       |
| 5xx         | `UpstreamError(-32004)`  | HTTP client ponawia idempotent requests do 3 razy z jittered backoff.                   |

## Worked example

`tools/call` do `jira.get_issue` z nieistniejącym kluczem:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32002,
    "message": "NotFoundError: jira /rest/api/3/issue/PROJ-9999 not found",
    "data": {
      "tool": "jira.get_issue",
      "correlationId": "9e1c7c1f-..."
    }
  }
}
```

## Dodawanie nowego kodu błędu

1. Dodaj subclass do [`src/shared/errors.ts`](../../src/shared/errors.ts).
2. Udokumentuj go tutaj.
3. Dodaj test kontraktowy, który round-trip'uje kod.
