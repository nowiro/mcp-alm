/**
 * Wspólne helpery dla `src/extract-*.ts` — DRY warstwa nad warstwą shared.
 *
 * Świadomie minimalna powierzchnia: tylko to, co JEST faktycznie zduplikowane
 * w >= 2 plikach `extract-*.ts`. Logika upstream-specific (paginacja Jira
 * cursor vs Confluence cursor vs GitLab page-based vs Sonar p/ps) zostaje w
 * pojedynczych pipeline'ach — różnice w semantyce upstream API nie zasługują
 * na sztywne wspólne abstrakcje.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { getRepoVersion } from './version.js';

// ── Wspólne schematy Zod używane w configach pipeline'ów ────────────────────

/** Nazwa snapshota — `[a-z0-9-]` (lowercase + dashes), używana jako podkatalog. */
export const snapshotNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .min(1)
  .max(64);

/** Formaty zapisu per zasób — minimum 1, default oba. */
export const renderFormatsSchema = z
  .array(z.enum(['json', 'markdown']))
  .min(1)
  .default(['json', 'markdown']);

export type RenderFormat = z.infer<typeof renderFormatsSchema>[number];

// ── Logger (stderr, prefiksowany nazwą skryptu) ──────────────────────────────

/**
 * Tworzy logger pipeline'u piszący JSON-RPC-friendly linie do stderr.
 * Stdout zarezerwowany dla MCP transport — extract scripts go nie używają,
 * ale zachowujemy tę samą dyscyplinę żeby nie pomylić w przyszłych refaktorach.
 */
export function createScriptLogger(scriptName: string): (msg: string) => void {
  return (msg: string) => {
    process.stderr.write(`[${scriptName}] ${msg}\n`);
  };
}

// ── Config loading ───────────────────────────────────────────────────────────

/**
 * Czyta plik JSON ze ścieżki, parsuje, waliduje przez podaną Zod schemę.
 * Rzuca przy brakującym pliku lub błędnym JSON / schema mismatch — pipeline
 * łapie w `runIfMain` i wypisuje FATAL.
 */
export async function loadJsonConfig<T extends z.ZodTypeAny>(path: string, schema: T): Promise<z.infer<T>> {
  const text = await readFile(path, 'utf8');
  const json: unknown = JSON.parse(text);
  return schema.parse(json);
}

// ── Output writers ───────────────────────────────────────────────────────────

/**
 * Pisze per-zasób output: JSON `<basename>.json` (z trailing newline, 2-space
 * indent) + Markdown `<basename>.md`. Tworzy katalog jeśli nie istnieje.
 * Format kontrolowany przez `formats` — zwykle `['json', 'markdown']`.
 */
export async function writePipelineOutputs(args: {
  readonly dir: string;
  readonly basename: string;
  readonly data: unknown;
  readonly markdown: string;
  readonly formats: readonly RenderFormat[];
}): Promise<void> {
  await mkdir(args.dir, { recursive: true });
  if (args.formats.includes('json')) {
    await writeFile(join(args.dir, `${args.basename}.json`), JSON.stringify(args.data, null, 2) + '\n', 'utf8');
  }
  if (args.formats.includes('markdown')) {
    await writeFile(join(args.dir, `${args.basename}.md`), args.markdown, 'utf8');
  }
}

/**
 * Pisze `<dir>/_manifest.json` z metadanymi runa. Manifest to kontrakt
 * snapshot-by-snapshot: nazwa, typ, timestamp start/finish, lista wyciągniętych
 * id-ków, narzędzie. Identyczny shape we wszystkich pipeline'ach.
 */
export async function writeManifest(dir: string, manifest: unknown): Promise<void> {
  await writeFile(join(dir, '_manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/** Common manifest envelope — pola dzielone przez wszystkie pipeline'y. */
interface ManifestEnvelope {
  readonly snapshot: string;
  readonly runStartedAt: string;
  readonly runFinishedAt: string;
  readonly render: readonly RenderFormat[];
  readonly tooling: { readonly script: string; readonly version: string };
}

/**
 * Buduje wspólny envelope manifestu (snapshot name, start/finish timestamps,
 * render, tooling) + dokleja pipeline-specific `extras` (jql, type, projectId,
 * itemCount, …). Zamiast 4× powtarzać ten sam shape:
 *
 * ```ts
 * { snapshot: snapshot.name, runStartedAt: startedAt, runFinishedAt: new Date().toISOString(),
 *   render: snapshot.render, tooling: { script: SCRIPT_NAME, version: getRepoVersion() },
 *   ...extras }
 * ```
 *
 * `extras` ma pierwszeństwo (spread po envelope), ale dla zachowania kontraktu
 * envelope'u zaleca się nie nadpisywać wspólnych pól.
 */
export function buildManifest<E extends Record<string, unknown>>(
  scriptName: string,
  startedAt: string,
  snapshot: { readonly name: string; readonly render: readonly RenderFormat[] },
  extras: E,
): ManifestEnvelope & E {
  return {
    snapshot: snapshot.name,
    runStartedAt: startedAt,
    runFinishedAt: new Date().toISOString(),
    render: snapshot.render,
    tooling: { script: scriptName, version: getRepoVersion() },
    ...extras,
  };
}

// ── Cursor parsing (Confluence v2-style `_links.next`) ───────────────────────

/**
 * Wyciąga wartość parametru `cursor` z URL-a w `_links.next`. Confluence v2
 * cursor pagination zwraca `_links.next` jako absolute URL z `?cursor=…` —
 * potrzebujemy tylko wartości cursora.
 *
 * Zwraca `undefined` gdy linkOrUndefined jest puste albo nie ma `cursor=`.
 */
export function parseCursorFromLink(linkOrUndefined: string | undefined): string | undefined {
  if (!linkOrUndefined) return undefined;
  const match = /[?&]cursor=([^&]+)/.exec(linkOrUndefined);
  if (!match) return undefined;
  return decodeURIComponent(match[1]);
}

// ── Main() boilerplate ───────────────────────────────────────────────────────

/**
 * Standardowy entry-point dla `extract-*.ts`. Sprawdza czy plik jest
 * uruchomiony bezpośrednio (nie importowany z testu) — jeśli tak, wykonuje
 * `main()` i łapie wszystkie błędy, pisząc FATAL na stderr z exit code 1.
 *
 * Użycie:
 * ```ts
 * await runIfMain('extract-jira', import.meta.url, main);
 * ```
 */
export async function runIfMain(scriptName: string, fileUrl: string, main: () => Promise<void>): Promise<void> {
  if (process.argv[1] !== fileURLToPath(fileUrl)) return;
  try {
    await main();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${scriptName}] FATAL: ${msg}\n`);
    process.exitCode = 1;
  }
}
