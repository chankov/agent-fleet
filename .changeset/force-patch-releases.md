---
"@chankov/agent-skills": patch
---

release tooling: every version bump is now forced to a patch (x.y.Z+1). A new `bin/force-patch-changesets.js` rewrites any pending `minor`/`major` changeset to `patch` and runs ahead of `changeset version` in both the local `version` npm script and the CI release workflow, so local and CI releases agree. Run releases with `npm run version` (not `npm version patch`, which double-bumps via the npm lifecycle hook).
