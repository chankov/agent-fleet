# Release workflow failure fix plan

## Investigation evidence

- `gh run list --workflow release.yml --status failure --limit 10` showed repeated failures. The two most recent completed failures are:
  - Run `29829831098` — <https://github.com/chankov/agent-fleet/actions/runs/29829831098> (commit `c819fca7d0e7e05d2e577d77d1f53dc2e83ecc3c`)
  - Run `29829447711` — <https://github.com/chankov/agent-fleet/actions/runs/29829447711> (commit `f2c43211c1b73e2d07099a80df1e169e419b058f`)
- `gh run view 29829831098 --json jobs` identifies the failed job as **Release** (job `88631624452`) and its failed step as **Test**. `Verify package contents` and `Create release PR or publish` were skipped, so they are downstream symptoms rather than the cause.
- `gh run view 29829831098 --log-failed` records the exact primary error from `.pi/harnesses/damage-control-continue/index.ts`:

  ```text
  Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml' imported from /home/runner/work/agent-fleet/agent-fleet/.pi/harnesses/damage-control-continue/index.ts
  ```

  It consequently fails `.pi/harnesses/damage-control-continue/exemptions.test.js` and `.pi/harnesses/damage-control/herdr-rules.test.js`. The prior run has the same missing-package error, confirming this is repeatable and not a one-off test failure.
- Current configuration confirms the root cause: `.pi/harnesses/damage-control-continue/index.ts` directly imports `yaml`, while the root `package.json` does not declare it. `package-lock.json` contains only a nested transitive `yaml` dependency under `@earendil-works/pi-coding-agent`; Node resolution from the harness cannot rely on that nested package.
- `.github/workflows/release.yml` already installs root dependencies before `npm test`; changing the workflow would mask the dependency declaration defect and would not make the shipped harness self-contained.

## Root cause

The release workflow correctly executes the test suite, but the repository omits the direct runtime dependency required by the shipped damage-control harness. The missing root `yaml` declaration causes the Test step to fail; skipped packaging and release steps are downstream effects.

## Dependency-ordered tasks

1. **Declare the direct runtime dependency.** Add `yaml` to the root production dependencies and regenerate only the corresponding root lockfile metadata.
   - Acceptance: a clean `npm install` installs a root-resolvable `yaml` package, and no unrelated dependency versions change.
2. **Validate the release gate safely.** Run the targeted failing harness tests, the workflow's `npm test`, `npm run pack:dry`, and `npx changeset status` (the action's non-publishing configuration check).
   - Acceptance: all commands succeed without invoking `changeset publish`, creating tags, or making network publication calls.
3. **Correct release metadata surfaced by safe validation.** `npx changeset status` initially identified two pending changesets that named `agent-fleet`, not the root package `@chankov/agent-fleet`; correct only those frontmatter names.
   - Acceptance: `npx changeset status` accepts every pending changeset.
4. **Review scope.** Confirm the final diff contains only the direct dependency metadata, the two directly invoked changeset metadata corrections, and this plan artifact.
   - Acceptance: no unrelated workflow, source, release, tag, secret, or generated changes are present.

## Residual GitHub validation

A future non-destructive push-triggered Release run is required to prove the hosted runner passes its Test step. This work will not re-run the failed job or publish a release.
