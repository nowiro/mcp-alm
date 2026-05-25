import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';
import securityPlugin from 'eslint-plugin-security';
import promisePlugin from 'eslint-plugin-promise';
import importX from 'eslint-plugin-import-x';
import vitestPlugin from '@vitest/eslint-plugin';

/**
 * Konfiguracja ESLint — ograniczona, ale celowa.
 *
 * Bazowe presety:
 *   - `js.configs.recommended`                   — sanity rules dla każdego JS.
 *   - `tseslint.configs.strictTypeChecked`       — strict + type-aware TS.
 *   - `tseslint.configs.stylisticTypeChecked`    — drobne preferencje stylu.
 *   - `eslint-config-prettier`                   — wyłącza reguły kolidujące z Prettier.
 *
 * Pluginy jakości (dodane wybiórczo, nie wszystkie domyślne):
 *   - `eslint-plugin-security`   — wykrywa eval / child_process / regex DoS / fs path
 *                                  injection. Istotne dla projektu sięgającego po
 *                                  upstream API z user-tokenami.
 *   - `eslint-plugin-promise`    — czysty async/await (no-return-wrap, prefer-await,
 *                                  no-nesting). Cała powierzchnia MCP jest async.
 *   - `eslint-plugin-import-x`   — higiena importów (no-cycle, no-self-import,
 *                                  no-duplicates, consistent-type-imports parity).
 *   - `@vitest/eslint-plugin`    — reguły dla testów (no-focused-tests,
 *                                  consistent-test-it, expect-expect).
 *
 * Świadomie pominięte: `sonarjs`, `unicorn`, `jsdoc` — w pierwszej wersji projektu
 * generowały więcej szumu niż sygnału przy `--max-warnings=0`.
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'tools/**',
      'docs/**',
      '*.js',
      '*.mjs',
      '*.cjs',
      // Config-pliki w roocie (vitest.config.ts itd.) — nie są w `tsconfig.json#include`
      // (rootDir to `./src`); osobnego tsconfig.tooling.json celowo nie zakładamy.
      '*.config.ts',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // ── eslint-plugin-security (selektywnie) ─────────────────────────────────
  {
    plugins: { security: securityPlugin },
    rules: {
      'security/detect-child-process': 'error',
      'security/detect-non-literal-fs-filename': 'warn',
      'security/detect-non-literal-require': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-unsafe-regex': 'warn',
      'security/detect-buffer-noassert': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'security/detect-no-csrf-before-method-override': 'error',
      // Wyłączone — szumi przy zamierzonych dynamicznych operacjach (np. budowanie
      // ścieżki query z walidowanych whitelist'owych pól).
      'security/detect-object-injection': 'off',
      'security/detect-possible-timing-attacks': 'off', // ręcznie używamy crypto.timingSafeEqual
      'security/detect-non-literal-regexp': 'off',
    },
  },

  // ── eslint-plugin-promise (recommended ruleset) ──────────────────────────
  {
    plugins: { promise: promisePlugin },
    rules: {
      'promise/no-return-wrap': 'error',
      'promise/param-names': 'error',
      'promise/catch-or-return': 'warn',
      'promise/no-nesting': 'warn',
      'promise/no-new-statics': 'error',
      'promise/no-return-in-finally': 'warn',
      'promise/valid-params': 'warn',
      'promise/prefer-await-to-then': 'warn',
    },
  },

  // ── eslint-plugin-import-x ───────────────────────────────────────────────
  {
    plugins: { 'import-x': importX },
    rules: {
      'import-x/no-cycle': ['error', { maxDepth: 5 }],
      'import-x/no-self-import': 'error',
      'import-x/no-duplicates': 'error',
      'import-x/no-empty-named-blocks': 'error',
      'import-x/no-mutable-exports': 'error',
      'import-x/first': 'error',
      'import-x/newline-after-import': 'warn',
      'import-x/no-useless-path-segments': 'warn',
    },
    settings: {
      'import-x/resolver': {
        typescript: { project: './tsconfig.json' },
        node: true,
      },
    },
  },

  // ── Reguły specyficzne dla projektu ──────────────────────────────────────
  {
    rules: {
      // Serwer MCP NIE MOŻE pisać do stdout — stdout to ramka JSON-RPC.
      // Używaj src/shared/log.ts (zapisuje do stderr).
      'no-console': 'error',

      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/explicit-function-return-type': ['warn', { allowExpressions: true }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true, allowBoolean: true }],

      // Stub handlery serwera czasem zwracają Promise bez await.
      '@typescript-eslint/require-await': 'off',
      // MCP SDK eksportuje klasę `Server` (niżej-poziomową) obok `McpServer`.
      // Świadomie używamy `Server`; reguła deprecation by ją flagowała.
      '@typescript-eslint/no-deprecated': 'off',
    },
  },

  // ── non-literal-fs-filename: legalne false-positives ───────────────────────
  // Wszystkie poniższe pliki czytają / piszą do ścieżek pochodzących z:
  //   - własnego path resolvera (`user-config.ts` → `getUserConfigPath`)
  //   - committed configu zwalidowanego przez Zod (`extract-runtime.ts` helpers,
  //     `extract-*.ts` entrypoints)
  // Ścieżki NIE pochodzą z untrusted runtime input — non-literal-fs-filename
  // to false positive. Reguła pozostaje `warn` dla reszty `src/`.
  {
    files: ['src/shared/user-config.ts', 'src/shared/extract-runtime.ts', 'src/extract-*.ts'],
    rules: {
      'security/detect-non-literal-fs-filename': 'off',
    },
  },

  // ── Pliki testowe ────────────────────────────────────────────────────────
  {
    files: ['**/*.spec.ts', '**/*.test.ts'],
    plugins: { vitest: vitestPlugin },
    rules: {
      ...vitestPlugin.configs.recommended.rules,
      'vitest/expect-expect': 'warn',
      'vitest/no-focused-tests': 'error', // it.only / describe.only nie mogą wejść do main
      'vitest/no-disabled-tests': 'warn', // it.skip — ostrzeżenie, nie fail
      'vitest/consistent-test-it': ['warn', { fn: 'it' }],
      // W testach pozwalamy na pomocnicze konstrukcje, które normalnie blokujemy.
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'security/detect-non-literal-fs-filename': 'off',
      'promise/prefer-await-to-then': 'off',
    },
  },

  // ── Prettier reconciliation (must be last) ───────────────────────────────
  prettierConfig,
);
