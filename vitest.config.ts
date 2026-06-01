import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration. Eksplicytna konfiguracja zamiast defaultów —
 * pozwala podnieść coverage thresholds gdy baseline jest zmierzony
 * i daje deterministyczny wybór testów / reporterów w CI.
 *
 * Coverage thresholds celowo niskie ("smoke" poziom) — pełna polityka
 * jest do zaplanowania po pierwszym pomiarze. Cel długoterminowy: 80%
 * dla `src/shared/` (warstwa wspólna), 60% dla `src/server-*.ts` (cieńsza
 * warstwa, większość logiki w shared).
 */
export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts', 'tools/**/*.spec.ts'],
    exclude: ['node_modules', 'dist', 'coverage'],
    environment: 'node',
    reporters: process.env['CI'] ? ['default', 'junit'] : ['default'],
    outputFile: {
      junit: './coverage/junit.xml',
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.spec.ts',
        'src/**/*.d.ts',
        // Server entrypoints — orkiestracja, pokryta testami integracyjnymi gdy powstaną.
        'src/server-*.ts',
      ],
      thresholds: {
        // Zmierzony floor (2026-05-31, ~70% lines) — blokuje regresję poniżej obecnego pokrycia.
        // Cel długoterminowy: shared/ ≥ 80%, całość ≥ 70%.
        lines: 66,
        functions: 67,
        branches: 55,
        statements: 63,
      },
    },
  },
});
