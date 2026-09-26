import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const contracts = [
 ['data/enum-semantics.md', /Preserve persisted or externally serialized values/, /Do not require sequential numbering/, /unknown values/],
 ['data/reporting-queries.md', /must not accidentally multiply rows/, /Avoid per-row queries/, /streaming or batching/, /rather than inventing thresholds/],
 ['frontend/async-ui-states.md', /synchronous request-creation failures and asynchronous rejection/, /stale requests/, /runtime UI checks/],
 ['frontend/navigation-contracts.md', /Preserve established path and query parameter contracts/, /not every error/, /shared components independent/],
 ['frontend/form-validation.md', /Revalidate before submission/, /does not replace authoritative server-side validation/, /do not copy example limits/, /nested and dependent fields/],
];
for (const [path, ...constraints] of contracts) {
 test(`${path} retains approved portable guidance`, () => {
  const body = readFileSync(new URL(`../../catalog/rules/${path}`, import.meta.url), 'utf8');
  for (const constraint of constraints) assert.match(body, constraint);
  assert.match(body, /## Scope and exceptions/);
  assert.match(body, /## Verification/);
  assert.doesNotMatch(body, /Presentation\/RIN|this\.\$http|rinbootbox|BasePaginationRequestSC/);
 });
}
