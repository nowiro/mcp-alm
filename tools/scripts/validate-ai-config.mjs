#!/usr/bin/env node
/**
 * Validates the GitHub Copilot configuration surface for mcp-alm:
 *   - .mcp.json conforms to the expected shape
 *   - .github/copilot-instructions.md exists
 *   - every file in .github/instructions/ has frontmatter with `applyTo` + `description`
 *   - every file in .github/prompts/ has frontmatter with `mode` + `description`
 *   - every file in .github/agents/ has frontmatter with `description`
 *   - every .github/skills/<name>/SKILL.md has frontmatter `name` (== folder) + `description`
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

async function listDirs(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function frontmatter(file) {
  const txt = await readFile(file, 'utf8');
  const fm = txt.match(/^---\n([\s\S]+?)\n---/);
  return fm ? fm[1] : null;
}

function fmValue(fm, key) {
  const m = fm.match(new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm'));
  return m ? m[1].replace(/^['"]|['"]$/g, '') : null;
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

  // ── 5. .github/agents/*.agent.md frontmatter ──
  const agents = await listMd('.github/agents');
  for (const f of agents) {
    if (!f.endsWith('.agent.md')) continue;
    await checkKeyedFrontmatter(f, ['description']);
  }

  // ── 6. .github/skills/<name>/SKILL.md — Agent Skills (agentskills.io open format) ──
  // Each skill is a folder Copilot auto-discovers as `<name>/SKILL.md`. README.md and any
  // other loose top-level file is not a skill. See .github/skills/README.md.
  for (const f of (await listMd('.github/skills')).filter((p) => !/readme\.md$/i.test(p))) {
    errors.push(`${f}: a skill must live in a subfolder as <name>/SKILL.md, not as a flat file`);
  }
  const skills = await listDirs('.github/skills');
  for (const name of skills) {
    const skillFile = resolve('.github/skills', name, 'SKILL.md');
    if (!existsSync(skillFile)) {
      errors.push(`.github/skills/${name}/: missing SKILL.md`);
      continue;
    }
    const fm = await frontmatter(skillFile);
    must(fm, `${skillFile}: missing YAML frontmatter`);
    if (!fm) continue;
    const skillName = fmValue(fm, 'name');
    const description = fmValue(fm, 'description');
    must(skillName, `${skillFile}: frontmatter missing "name"`);
    must(description, `${skillFile}: frontmatter missing "description"`);
    if (skillName) {
      must(/^[a-z0-9-]{1,64}$/.test(skillName), `${skillFile}: "name" must be lowercase a-z/0-9/hyphen, max 64 chars`);
      must(skillName === name, `.github/skills/${name}/: folder name must equal frontmatter "name" ("${skillName}")`);
    }
    must(!description || description.length <= 1024, `${skillFile}: "description" exceeds 1024 chars`);
  }

  // ── 7. exactly one user-invocable agent (the orchestrator) ──
  // Custom agents in .github/agents all show in the VS Code picker unless they set
  // `user-invocable: false`. We expose ONE (orchestrator) and hide the rest as subagents.
  const visibleAgents = [];
  for (const f of agents) {
    if (!f.endsWith('.agent.md')) continue;
    const fm = await frontmatter(f);
    if (fm && !/^user-invocable:\s*false\b/m.test(fm)) visibleAgents.push(f.split(/[/\\]/).pop());
  }
  must(
    visibleAgents.length === 1,
    `expected exactly 1 user-invocable agent (orchestrator); found ${visibleAgents.length}: ${visibleAgents.join(', ')}`,
  );

  if (errors.length === 0) {
    console.log(
      `✓ mcp-alm Copilot configuration is valid — ` +
        `${instructions.length} instructions · ${prompts.length} prompts · ${agents.length} agents · ${skills.length} skills`,
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
