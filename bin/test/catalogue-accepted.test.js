import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const read = (path) => readFileSync(new URL(`../../catalog/${path}`, import.meta.url), 'utf8');

const contracts = [
  ['rules/ai/policy-authoring.md', [/loading trigger/, /Resolve conflicting instructions/, /Observed conventions are proposals until accepted/, /structural checks from observed model behavior/]],
  ['rules/docs/docs-maintenance.md', [/synchronize affected implementation, tests, plans, and specifications/, /clearly superseded records/, /report the gap/]],
  ['rules/architecture/public-contracts.md', [/APIs, libraries, events, file formats, or CLI/, /signature-only comparison does not prove compatibility/, /unknown consumers explicitly/, /never invent a universal support period/]],
  ['rules/security/diagnostic-data-safety.md', [/Avoid secret-returning endpoints/, /output redaction alone does not prevent/, /stop propagation/, /clean scanner result does not prove/]],
  ['rules/data/mixed-ownership-data.md', [/stable identity/, /Preserve human descriptions/, /partial collection does not prove deletion/, /Do not overwrite concurrent local edits/]],
  ['commands/audit-documentation.md', [/command is read-only/, /Cite both sides/, /Do not edit, delete, or consolidate/, /unchecked areas explicitly/]],
];
for (const [path, constraints] of contracts) {
  test(`${path} retains accepted adaptation constraints`, () => {
    const body = read(path);
    for (const constraint of constraints) assert.match(body, constraint);
    assert.doesNotMatch(body, /rankedin\.database|Presentation\/RIN|RIN_DB_PASSWORD|--subscription/);
  });
}

test('rules live only in approved domain directories', async () => {
  const { existsSync } = await import('node:fs');
  for (const [group, name] of [
    ['architecture', 'repository-boundaries'], ['architecture', 'public-contracts'],
    ['security', 'diagnostic-data-safety'], ['data', 'mixed-ownership-data'],
    ['ai', 'policy-authoring'],
  ]) {
    assert.equal(existsSync(new URL(`../../catalog/rules/${name}.md`, import.meta.url)), false);
    assert.equal(existsSync(new URL(`../../catalog/rules/${group}/${name}.md`, import.meta.url)), true);
  }
});
