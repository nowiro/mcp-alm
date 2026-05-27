#!/usr/bin/env node

/**
 * doctor.mjs — repo diagnostics + per-connector health check.
 *
 * What it checks:
 *   1. Node version vs `package.json#engines.node`
 *   2. User-profile config exists, is valid JSON, conforms to the schema
 *   3. Per-connector: baseUrl format (e.g. Confluence must include `/wiki`)
 *   4. Per-connector: token is not a `PASTE_YOUR_…` placeholder
 *   5. CA bundle (`NODE_EXTRA_CA_CERTS`) — file exists + parses
 *   6. Per-connector: HEAD healthcheck against baseUrl with a 5s timeout
 *
 * Output: list of green ✓ / yellow ⚠ / red ✗ items. Exit 0 when no reds
 * (warnings are OK). Exit 1 if any red.
 *
 * Flags:
 *   --skip-network    skip per-connector healthcheck (offline mode)
 *   --json            emit JSON instead of text (for CI / monitoring)
 *
 * @see docs/getting-started/enterprise-intranet.md — "Private root CA"
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';

const ROOT = process.cwd();
const ARGS = new Set(process.argv.slice(2));
const IS_WIN = platform() === 'win32';
const REPO_SLUG = 'mcp-alm';

// ── ANSI helpers (kompatybilne z modern terminals; cmd.exe pokazuje raw escapes) ──
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/** @typedef {{ section: string; status: 'ok'|'warn'|'err'; msg: string; hint?: string }} Finding */
/** @type {Finding[]} */
const findings = [];

function add(section, status, msg, hint) {
  findings.push({ section, status, msg, ...(hint ? { hint } : {}) });
}

function emit(section, status, msg, hint) {
  add(section, status, msg, hint);
  if (ARGS.has('--json')) return;
  const icon = status === 'ok' ? c.ok('✓') : status === 'warn' ? c.warn('⚠') : c.err('✗');
  process.stdout.write(`  ${icon} ${msg}\n`);
  if (hint) process.stdout.write(`    ${c.dim(hint)}\n`);
}

function step(name) {
  if (ARGS.has('--json')) return;
  process.stdout.write(`\n${c.bold(`▶ ${name}`)}\n`);
}

// ── 1. Terminal encoding (Windows-only warning) ──────────────────────────────
// Scripts emit UTF-8 glyphs (✓ ✗ ⚠ ▶ ─). cmd.exe + PowerShell 5.1 default to
// codepage 437/1252 and will render mojibake. Modern terminals (Windows Terminal,
// PS 7+, VS Code integrated, ConEmu) advertise themselves via env vars.
if (IS_WIN) {
  step('Terminal encoding');
  const modernTerminal =
    process.env['WT_SESSION'] || process.env['TERM_PROGRAM'] === 'vscode' || process.env['ConEmuPID'];
  if (modernTerminal) {
    emit('terminal', 'ok', 'Modern Windows terminal detected (UTF-8 capable)');
  } else {
    emit(
      'terminal',
      'warn',
      'Legacy console detected (cmd.exe or PowerShell 5.1)',
      'Use Windows Terminal + PowerShell 7+ for proper UTF-8 rendering. Workaround: `chcp 65001` before running scripts.',
    );
  }
}

// ── 2. Node version ──────────────────────────────────────────────────────────
step('Node version');
const enginesNode = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).engines?.node;
const have = process.versions.node;
const requiredMajor = enginesNode?.match(/(\d+)/)?.[1];
const haveMajor = have.split('.')[0];
if (!enginesNode) {
  emit('node', 'warn', `Node ${have} (no engines.node declared in package.json)`);
} else if (Number(haveMajor) >= Number(requiredMajor)) {
  emit('node', 'ok', `Node ${have} (satisfies engines.node ${enginesNode})`);
} else {
  emit('node', 'warn', `Node ${have} but engines.node requires ${enginesNode}`, 'Use nvm / volta / fnm to switch');
}

// ── 3. User-profile config ───────────────────────────────────────────────────
step('User-profile config');

function resolveConfigPath() {
  // Must mirror src/shared/user-config.ts → getUserConfigPath().
  const override = process.env['MCP_ALM_CONFIG_DIR']?.trim();
  if (override) return resolve(override, 'config.json');
  const xdg = process.env['XDG_CONFIG_HOME']?.trim();
  if (xdg) return resolve(xdg, REPO_SLUG, 'config.json');
  return join(homedir(), '.config', REPO_SLUG, 'config.json');
}

const configPath = resolveConfigPath();
/** @type {Record<string, any>} */
let config = {};
let configLoaded = false;

if (!existsSync(configPath)) {
  emit('config', 'warn', `not found: ${configPath}`, 'Run: npm run bootstrap (copies config.example.json)');
} else {
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    // Strip $-prefixed comment keys (per user-config.ts convention)
    config = Object.fromEntries(Object.entries(parsed).filter(([k]) => !k.startsWith('$')));
    configLoaded = true;
    emit('config', 'ok', `loaded ${configPath}`);

    // Permission check (POSIX)
    if (!IS_WIN) {
      const mode = statSync(configPath).mode & 0o777;
      if (mode & 0o077) {
        emit('config', 'warn', `mode ${mode.toString(8)} — recommended 0600`, `chmod 600 "${configPath}"`);
      } else {
        emit('config', 'ok', 'permissions 0600');
      }
    }
  } catch (error) {
    emit('config', 'err', `failed to parse: ${error.message}`);
  }
}

// ── 4. Per-connector: baseUrl validation + placeholder check ────────────────
if (configLoaded) {
  step('Per-connector: baseUrl & token validation');

  /**
   * baseUrl validation spec per connector. Each spec lists required substrings
   * + an example matching the documented shape. Rules come from real misconfigs.
   */
  const SPECS = {
    jira: {
      mustEndWith: '.atlassian.net',
      mustNotInclude: ['/wiki'],
      example: 'https://your-org.atlassian.net  (Cloud)  ·  https://jira.your-org.com  (Data Center)',
    },
    confluence: {
      mustInclude: ['/wiki'],
      example: 'https://your-org.atlassian.net/wiki  (Cloud)  ·  https://confluence.your-org.com  (Data Center)',
    },
    figma: {
      mustInclude: ['api.figma.com'],
      example: 'https://api.figma.com',
    },
    gitlab: {
      mustInclude: ['/api/v4'],
      example: 'https://gitlab.com/api/v4  (SaaS)  ·  https://gitlab.your-org.com/api/v4  (self-hosted)',
    },
    sonar: {
      // Sonar has no fixed path pattern — only require HTTPS.
      mustStartWith: 'https://',
      example: 'https://sonar.your-org.com  ·  https://sonarcloud.io',
    },
  };

  for (const [connector, spec] of Object.entries(SPECS)) {
    const cfg = config[connector];
    if (!cfg) {
      emit(connector, 'warn', `${connector}: section missing from config (OK if you do not use it)`);
      continue;
    }
    const baseUrl = cfg.baseUrl;
    if (!baseUrl) {
      emit(connector, 'warn', `${connector}: baseUrl missing`);
    } else {
      let urlOk = true;
      if (spec.mustStartWith && !baseUrl.startsWith(spec.mustStartWith)) {
        emit(
          connector,
          'err',
          `${connector}.baseUrl does not start with "${spec.mustStartWith}"`,
          `example: ${spec.example}`,
        );
        urlOk = false;
      }
      if (spec.mustEndWith && !baseUrl.endsWith(spec.mustEndWith) && !baseUrl.includes(spec.mustEndWith)) {
        emit(connector, 'warn', `${connector}.baseUrl does not contain "${spec.mustEndWith}"`, `example: ${spec.example}`);
      }
      if (spec.mustInclude) {
        for (const fragment of spec.mustInclude) {
          if (!baseUrl.includes(fragment)) {
            emit(connector, 'err', `${connector}.baseUrl is missing "${fragment}"`, `example: ${spec.example}`);
            urlOk = false;
          }
        }
      }
      if (spec.mustNotInclude) {
        for (const fragment of spec.mustNotInclude) {
          if (baseUrl.includes(fragment)) {
            emit(
              connector,
              'err',
              `${connector}.baseUrl contains "${fragment}" — that belongs in Confluence, not ${connector}`,
              `example: ${spec.example}`,
            );
            urlOk = false;
          }
        }
      }
      if (urlOk) emit(connector, 'ok', `${connector}.baseUrl: ${baseUrl}`);
    }

    // Token placeholder check
    if (cfg.token && /^PASTE_YOUR_/i.test(cfg.token)) {
      emit(connector, 'err', `${connector}.token is a PASTE_YOUR_… placeholder`, `fill in the token in ${configPath}`);
    } else if (cfg.token) {
      emit(connector, 'ok', `${connector}.token set (${cfg.token.length} chars)`);
    }
  }
}

// ── 5. CA bundle ─────────────────────────────────────────────────────────────
step('CA bundle (NODE_EXTRA_CA_CERTS)');
const caPath = process.env['NODE_EXTRA_CA_CERTS'];
if (!caPath) {
  emit('ca-bundle', 'ok', 'not set (OK for public CAs)');
} else {
  if (!existsSync(caPath)) {
    emit('ca-bundle', 'err', `NODE_EXTRA_CA_CERTS=${caPath} — file does not exist`, 'Check the path');
  } else {
    try {
      const content = readFileSync(caPath, 'utf8');
      const certCount = (content.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length;
      if (certCount === 0) {
        emit('ca-bundle', 'err', `${caPath} contains no PEM certificate`);
      } else {
        emit('ca-bundle', 'ok', `${caPath} (${certCount} ${certCount === 1 ? 'cert' : 'certs'})`);
      }
    } catch (error) {
      emit('ca-bundle', 'err', `${caPath} — cannot read: ${error.message}`);
    }
  }
}

// ── 6. Per-connector healthcheck (HEAD on baseUrl, 5s timeout) ──────────────
if (configLoaded && !ARGS.has('--skip-network')) {
  step('Per-connector healthcheck (HEAD, 5s timeout)');

  for (const [connector, cfg] of Object.entries(config)) {
    if (!cfg?.baseUrl) continue;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(cfg.baseUrl, { method: 'HEAD', signal: controller.signal }).catch((e) => ({
        ok: false,
        status: 0,
        error: e,
      }));
      clearTimeout(timer);
      if (response.ok || (response.status >= 200 && response.status < 500)) {
        emit(connector, 'ok', `${connector}: ${cfg.baseUrl} reachable (HTTP ${response.status})`);
      } else if (response.status === 0) {
        const msg = response.error?.name === 'AbortError' ? 'timeout 5s' : (response.error?.message ?? 'unknown');
        emit(connector, 'warn', `${connector}: ${cfg.baseUrl} unreachable (${msg})`);
      } else {
        emit(connector, 'warn', `${connector}: ${cfg.baseUrl} HTTP ${response.status}`);
      }
    } catch (error) {
      emit(connector, 'warn', `${connector}: ${cfg.baseUrl} — ${error.message}`);
    }
  }
}

// ── 7. Summary + exit ────────────────────────────────────────────────────────
if (ARGS.has('--json')) {
  process.stdout.write(JSON.stringify({ findings, summary: summarize() }, null, 2) + '\n');
} else {
  step('Summary');
  const s = summarize();
  process.stdout.write(`  ${c.ok(`✓ ${s.ok}`)}  ${c.warn(`⚠ ${s.warn}`)}  ${c.err(`✗ ${s.err}`)}\n`);
  if (s.err > 0) {
    process.stdout.write(`\n${c.err('Doctor: UNHEALTHY — fix the errors and re-run.')}\n\n`);
  } else if (s.warn > 0) {
    process.stdout.write(`\n${c.warn('Doctor: healthy with warnings (proceed if acceptable).')}\n\n`);
  } else {
    process.stdout.write(`\n${c.ok('Doctor: HEALTHY ✓')}\n\n`);
  }
}

function summarize() {
  return findings.reduce((acc, f) => ({ ...acc, [f.status]: (acc[f.status] ?? 0) + 1 }), { ok: 0, warn: 0, err: 0 });
}

process.exit(summarize().err > 0 ? 1 : 0);
