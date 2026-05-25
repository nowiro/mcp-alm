#!/usr/bin/env node

/**
 * bootstrap.mjs — one-command repo initialiser.
 *
 * Runs after `git clone` to:
 *   1. verify Node version against `package.json#engines.node`
 *   2. install dependencies (skips if `node_modules` already exists)
 *   3. set up git hooks (`npm run prepare` → husky)
 *   4. (when `config.example.json` exists) seed a user-profile config at
 *      `<home>/.config/mcp-alm/config.json`, set `0600` on POSIX, warn if it
 *      still contains placeholder strings.
 *
 * Cross-platform: pure Node stdlib, no external deps. Works identically on
 * Windows / macOS / Linux. Safe to re-run.
 *
 * Flags:
 *   --reinstall      force `npm install` even if node_modules exists
 *   --skip-install   do not run `npm install`
 *   --skip-config    do not seed user-profile config
 *
 * @see docs/explanation/security-architecture.md — token storage policy
 * @see docs/getting-started/quickstart.md
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ARGS = new Set(process.argv.slice(2));
const IS_WIN = platform() === 'win32';

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const findings = [];
let exitCode = 0;

function step(name) {
  process.stdout.write(`\n${c.bold(`▶ ${name}`)}\n`);
}
function log(msg) {
  process.stdout.write(`  ${msg}\n`);
}
function record(severity, msg) {
  findings.push({ severity, msg });
}
function shell(command, args = [], options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.silent ? 'pipe' : 'inherit',
    shell: IS_WIN,
    ...options,
  });
}

// ─── 1. Node version ────────────────────────────────────────────────────────
step('Verify Node.js');
const enginesNode = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node;
const requiredMajor = enginesNode?.match(/(\d+)/)?.[1];
const haveMajor = process.versions.node.split('.')[0];
if (requiredMajor && Number(haveMajor) < Number(requiredMajor)) {
  log(c.warn(`⚠ Node ${process.versions.node} but package.json engines.node requires ${enginesNode}.`));
  log(c.dim('  Use nvm / volta / fnm to switch (e.g. `nvm install 22 && nvm use 22`).'));
  record('warn', `Node version below required (have ${process.versions.node}, want ${enginesNode})`);
} else {
  log(c.ok(`✓ Node ${process.versions.node}${enginesNode ? ` (satisfies engines.node ${enginesNode})` : ''}`));
}

// ─── 2. Install ─────────────────────────────────────────────────────────────
step('Install dependencies');
if (ARGS.has('--skip-install')) {
  log(c.dim('skipped (--skip-install)'));
} else {
  const alreadyInstalled = existsSync(join(ROOT, 'node_modules'));
  if (alreadyInstalled && !ARGS.has('--reinstall')) {
    log(c.dim('node_modules exists — skipping (use --reinstall to force).'));
  } else {
    const installArgs = existsSync(join(ROOT, 'package-lock.json')) ? ['ci'] : ['install'];
    const result = shell('npm', installArgs);
    if (result.status !== 0) {
      log(c.err('✗ npm install failed.'));
      process.exit(1);
    }
    log(c.ok('✓ dependencies installed'));
  }
}

// ─── 3. Husky ───────────────────────────────────────────────────────────────
step('Set up git hooks');
const prepare = shell('npm', ['run', 'prepare'], { silent: true });
if (prepare.status === 0) {
  log(c.ok('✓ husky hooks installed'));
} else {
  log(c.warn('⚠ npm run prepare failed (husky not installed or no git repo).'));
  record('warn', 'husky hooks not installed');
}

// ─── 4. User-profile config ─────────────────────────────────────────────────
const examplePath = join(ROOT, 'config.example.json');
if (!ARGS.has('--skip-config') && existsSync(examplePath)) {
  step('User-profile config');

  const repoName = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name;
  const override = process.env['MCP_ALM_CONFIG_DIR']?.trim();
  const xdg = process.env['XDG_CONFIG_HOME']?.trim();
  const configDir = override
    ? resolve(override)
    : xdg
      ? resolve(xdg, repoName)
      : join(homedir(), '.config', repoName);
  const configPath = join(configDir, 'config.json');

  if (existsSync(configPath)) {
    log(c.ok('✓ exists') + ' ' + c.dim(configPath));
    const content = readFileSync(configPath, 'utf8');
    if (/PASTE_YOUR_/i.test(content)) {
      log(c.warn('⚠ still contains PASTE_YOUR_ placeholders — edit before use.'));
      record('warn', 'User config has placeholder tokens');
    }
  } else {
    mkdirSync(configDir, { recursive: true });
    copyFileSync(examplePath, configPath);
    if (!IS_WIN) {
      try {
        chmodSync(configPath, 0o600);
      } catch {
        /* best-effort */
      }
    }
    log(c.ok('✓ created') + ' ' + c.dim(configPath));
    log(c.warn('⚠ Edit the file — replace every PASTE_YOUR_… placeholder with a real token.'));
    if (IS_WIN) {
      log(c.dim('  notepad "' + configPath + '"'));
    } else {
      log(c.dim('  $EDITOR "' + configPath + '"  (file mode is 0600)'));
    }
    record('warn', 'New user config seeded — fill in tokens');
  }
}

// ─── 5. Summary ─────────────────────────────────────────────────────────────
step('Summary');
if (findings.length === 0) {
  log(c.ok('✓ All checks passed.'));
} else {
  for (const f of findings) {
    const fmt = f.severity === 'err' ? c.err : c.warn;
    log(fmt(`• ${f.msg}`));
  }
}

process.stdout.write(
  '\n' +
    c.bold('Next steps') +
    '\n' +
    c.dim('  • Edit user config (if seeded above) — paste real tokens.') +
    '\n' +
    c.dim('  • Read README.md and docs/getting-started/quickstart.md.') +
    '\n' +
    c.dim('  • Wire MCP servers into your IDE — docs/getting-started/{vscode,intellij}-setup.md.') +
    '\n' +
    c.dim('  • Run: npm run typecheck && npm test && npm run build') +
    '\n\n',
);

process.exit(exitCode);
