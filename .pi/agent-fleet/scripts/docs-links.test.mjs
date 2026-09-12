import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
