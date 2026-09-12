import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const publicDocs = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md',
  'docs/npm-install.md', 'docs/getting-started.md', 'docs/pi-setup.md',
  'docs/MIGRATION-agent-fleet.md', 'docs/agent-fleet-setup.md',
  'docs/claude-code-coms-bridge.md', 'docs/pi-extensions.md',
  'docs/skills-catalog.md', 'docs/agents.md', 'docs/UPSTREAM-SKILLS.md',
];
const retired = [/guided-workspace-setup/, /af-setup-agent-fleet/, /cleanup-installer/];

test('pi extension catalog does not link to ignored planning docs', async () => {
  const catalog = await readFile('docs/pi-extensions.md', 'utf-8');
  assert.doesNotMatch(catalog, /docs\/plans\//);
});

test('public docs and repository guidance contain no retired setup layer references', async () => {
  for (const path of publicDocs) {
    const text = await readFile(path, 'utf8');
    for (const pattern of retired) assert.doesNotMatch(text, pattern, path);
  }
});

test('every doc the package allowlist publishes exists on disk', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const literal = pkg.files.filter(entry =>
    entry.endsWith('.md') && !entry.startsWith('!') && !entry.includes('*'));
  assert.ok(literal.length > 0, 'the allowlist should name markdown files literally');
  for (const entry of literal) {
    // npm pack silently ships nothing for an allowlist entry that matches no
    // file, so a deleted doc leaves the tarball short without failing a build.
    assert.ok(existsSync(entry), `package.json files lists a missing doc: ${entry}`);
  }
});

test('public docs contain no relative link to a file that does not exist', async () => {
  const docs = [...publicDocs, ...(await readdir('docs'))
    .filter(name => name.endsWith('.md')).map(name => `docs/${name}`)];
  for (const doc of new Set(docs)) {
    const text = await readFile(doc, 'utf8');
    for (const [, link] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|file:|#)/.test(link)) continue;
      const target = link.split('#')[0];
      if (!target) continue;
      const resolved = join(dirname(doc), target);
      assert.ok(existsSync(resolved), `${doc} links to missing ${link}`);
    }
  }
});
