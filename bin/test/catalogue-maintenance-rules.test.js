import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const contracts = [
 ['architecture/behavior-preserving-refactoring.md', /Stricter validation is a behavior change/, /every affected branch and side-effect call/, /registration or indirect invocation/, /compilation alone does not prove equivalence/],
 ['data/reporting-queries.md', /Inspect all known callers/, /purpose-specific query or minimal projection/, /caller-wide rationale/, /extra queries are conditional/, /Report unmeasured effects/],
 ['architecture/structural-change-registration.md', /generated registrations from authoritative sources/, /packaged artifact/, /Preserve unrelated configuration/],
 ['testing/shared-package-consumers.md', /no standalone build exists/, /uncovered consumers/, /linked source alone does not establish published-package correctness/, /not integration proof/],
 ['frontend/established-ui-primitives.md', /when it meets the use case/, /Do not assume a shared component is accessible/, /native semantics/],
 ['security/response-data-minimization.md', /explicit selection/, /rather than relying solely on a final mapper/, /nested objects, errors/, /absence of prohibited fields/],
 ['backend/notification-date-time.md', /intended locale and time zone/, /worker-machine defaults/, /machine-readable timestamps/, /daylight-saving transitions/],
];
for (const [path, ...constraints] of contracts) {
 test(`${path} preserves accepted portable constraints`, () => {
  const body = readFileSync(new URL(`../../catalog/rules/${path}`, import.meta.url), 'utf8');
  for (const constraint of constraints) assert.match(body, constraint);
  for (const heading of ['Rules', 'Scope and exceptions', 'Verification', 'References']) assert.ok(body.includes(`## ${heading}`));
  assert.doesNotMatch(body, /Presentation\/RIN|Nomenclatures\.DateTimeFormat|Task<ModelResponse>|IOptions<LinksOptions>/);
 });
}
