#!/usr/bin/env node
/**
 * dev-client.mjs — minimalny klient stdio MCP do testów ręcznych bez IDE.
 *
 * Spawnuje wybrany serwer mcp-alm jako podproces, robi `initialize`,
 * potem `tools/list`, opcjonalnie woła jedno narzędzie z argumentami.
 *
 * Użycie:
 *   node tools/scripts/dev-client.mjs <connector>
 *   node tools/scripts/dev-client.mjs <connector> <tool> '<json-args>'
 *
 * Przykłady:
 *   node tools/scripts/dev-client.mjs jira
 *   node tools/scripts/dev-client.mjs jira jira.health '{}'
 *   node tools/scripts/dev-client.mjs gitlab gitlab.list_mrs '{"projectId":"123","state":"opened"}'
 *
 * Wymagane uprzednio:
 *   - `npm run build` (skrypt woła `dist/server-<connector>.js`)
 *   - Tokeny w `~/.config/mcp-alm/config.json` lub env vars
 *
 * Dla write-tools: ustaw `MCP_WRITE_ENABLED=true` + `MCP_WRITE_ALLOWLIST=<tool>`
 * przed wywołaniem skryptu — guard ma deny-by-default, brak wyjątku dla dev.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONNECTORS = ['jira', 'confluence', 'figma', 'sonar', 'gitlab'];
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

const [connector, toolName, rawArgs] = process.argv.slice(2);

if (!connector || !CONNECTORS.includes(connector)) {
  process.stderr.write(`Usage: node tools/scripts/dev-client.mjs <${CONNECTORS.join('|')}> [tool] ['<json-args>']\n`);
  process.exit(2);
}

const serverPath = resolve(REPO_ROOT, 'dist', `server-${connector}.js`);
if (!existsSync(serverPath)) {
  process.stderr.write(`Server binary not found: ${serverPath}\nRun \`npm run build\` first.\n`);
  process.exit(2);
}

let parsedArgs = {};
if (rawArgs) {
  try {
    parsedArgs = JSON.parse(rawArgs);
  } catch (err) {
    process.stderr.write(`Invalid JSON for tool args: ${err.message}\n`);
    process.exit(2);
  }
}

const server = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

let buffer = '';
const pending = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  server.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolveP, rejectP) => {
    pending.set(id, { resolve: resolveP, reject: rejectP });
  });
}

server.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let nl;
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stderr.write(`[non-JSON stdout from server]: ${line}\n`);
      continue;
    }
    const handler = pending.get(msg.id);
    if (handler) {
      pending.delete(msg.id);
      if (msg.error) handler.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else handler.resolve(msg.result);
    }
  }
});

server.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    process.stderr.write(`Server exited with code ${code}\n`);
    process.exit(code);
  }
});

try {
  const init = await send('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'mcp-alm-dev-client', version: '0.0.0' },
  });
  process.stdout.write(`# initialize\n${JSON.stringify(init, null, 2)}\n\n`);

  const tools = await send('tools/list', {});
  process.stdout.write(`# tools/list (${tools.tools?.length ?? 0} tools)\n`);
  for (const t of tools.tools ?? []) {
    process.stdout.write(`  - ${t.name}\n`);
  }
  process.stdout.write('\n');

  if (toolName) {
    const result = await send('tools/call', { name: toolName, arguments: parsedArgs });
    process.stdout.write(`# tools/call ${toolName}\n${JSON.stringify(result, null, 2)}\n`);
  }
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
} finally {
  server.kill('SIGTERM');
}
