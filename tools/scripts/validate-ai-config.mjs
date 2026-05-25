#!/usr/bin/env node
/**
 * Validates the GitHub Copilot configuration surface for mcp-alm:
 *   - .mcp.json conforms to the expected shape
 *   - .github/copilot-instructions.md exists
 *   - every file in .github/instructions/ has frontmatter with `applyTo` + `description`
 *   - every file in .github/prompts/ has frontmatter with `mode` + `description`
 *   - every file in .github/chatmodes/ has frontmatter with `description`
 *
 * Exits 0 on success, 1 on any failure. Used by `npm run ai:validate` and CI.
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

const errors = [];

const must = (cond, msg) => {
  if (!cond) errors.push(msg);
};

async function listMd(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => resolve(dir, e.name));
}

async function frontmatter(file) {
  const txt = await readFile(file, 'utf8');
  const fm = txt.match(/^---\n([\s\S]+?)\n---/);
  return fm ? fm[1] : null;
}

async function checkKeyedFrontmatter(file, requiredKeys) {
  const fm = await frontmatter(file);
  must(fm, `${file}: missing YAML frontmatter`);
  if (!fm) return;
  for (const key of requiredKeys) {
    must(new RegExp(`^${key}:\\s*\\S+`, 'm').test(fm), `${file}: frontmatter missing "${key}"`);
  }
}

async function main() {
  // ── 1. MCP registry sanity ──
  const mcpPath = existsSync('.mcp.json') ? '.mcp.json' : null;
  if (mcpPath) {
    const mcp = JSON.parse(await readFile(mcpPath, 'utf8'));
    const servers = mcp.mcpServers ?? mcp.servers;
    must(servers && typeof servers === 'object', `${mcpPath}: missing "mcpServers"/"servers" map`);
    for (const [name, srv] of Object.entries(servers ?? {})) {
      must(srv.command, `${mcpPath}: server "${name}" missing "command"`);
      must(Array.isArray(srv.args), `${mcpPath}: server "${name}" missing "args" array`);
    }
  }

  // ── 2. Copilot entrypoint exists ──
  must(existsSync('.github/copilot-instructions.md'), '.github/copilot-instructions.md is missing');

  // ── 3. .github/instructions/*.instructions.md frontmatter ──
  const instructions = await listMd('.github/instructions');
  for (const f of instructions) {
    if (!f.endsWith('.instructions.md')) continue;
    await checkKeyedFrontmatter(f, ['applyTo', 'description']);
  }

  // ── 4. .github/prompts/*.prompt.md frontmatter ──
  const prompts = await listMd('.github/prompts');
  for (const f of prompts) {
    if (!f.endsWith('.prompt.md')) continue;
    await checkKeyedFrontmatter(f, ['mode', 'description']);
  }

  // ── 5. .github/chatmodes/*.chatmode.md frontmatter ──
  const chatmodes = await listMd('.github/chatmodes');
  for (const f of chatmodes) {
    if (!f.endsWith('.chatmode.md')) continue;
    await checkKeyedFrontmatter(f, ['description']);
  }

  if (errors.length === 0) {
    console.log(
      `✓ mcp-alm Copilot configuration is valid — ` +
        `${instructions.length} instructions · ${prompts.length} prompts · ${chatmodes.length} chat-modes`,
    );
    process.exit(0);
  }
  console.error('✗ Copilot configuration has errors:\n');
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
