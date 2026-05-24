# Publishing @chankov/agent-skills to npm

A reference for the maintainer. Day-to-day contributors only need
`npx changeset` (see [CONTRIBUTING.md](../CONTRIBUTING.md#versioning--releases)).

The package is published under the `@chankov` scope (tied to the
[chankov](https://www.npmjs.com/~chankov) npm account). The CLI binary it
ships is `agent-skills` — both names are intentional.

## One-time setup

1. **Confirm you own the `@chankov` scope.** If you can log in as `chankov`,
   you do:

   ```bash
   npm whoami    # should print "chankov"
   npm login     # if not logged in
   # or, if the account doesn't exist yet:
   npm adduser
   ```

   Scoped packages are bound to the user / org that owns the scope — nobody
   else can publish to `@chankov/*` once it's yours.

2. **Provision the npm token.**

   ```bash
   npm login                    # one-time, locally
   npm token create --automation  # creates a CI token
   ```

   Store the resulting token in the GitHub repository secrets as `NPM_TOKEN`.
   The release workflow (`.github/workflows/release.yml`) reads it.

3. **Confirm GitHub Actions has write permissions.** Settings → Actions →
   General → Workflow permissions → "Read and write permissions" + "Allow
   GitHub Actions to create and approve pull requests."

## Cutting a release

1. **Local sanity:**

   ```bash
   npm install
   npm test              # CLI smoke
   npm run pack:dry      # verify tarball contents + size
   node bin/cli.js doctor --dry-run
   ```

2. **Add changesets** for any user-visible change merged since the last
   release (one per PR; the contributor adds them as part of their PR).

3. **Push to main.** The release workflow opens (or updates) a "Version
   Packages" PR that:
   - Rolls every `.changeset/*.md` into `CHANGELOG.md`
   - Bumps `package.json#version`
   - Runs `node bin/snapshot-version.js` to write `.versions/<x.y.z>/`

4. **Review the Version Packages PR.** Inspect the changelog entry and the
   bumped version. Merge it.

5. **The workflow runs `changeset publish` on merge.** Outputs:
   - The package on npm at the new version
   - A git tag `v<x.y.z>` pushed to the repo

## Manual publish (escape hatch)

If the workflow is broken or you need to publish from your laptop:

```bash
git checkout main && git pull
npm install
npm run pack:dry           # last sanity check
npx changeset version      # bumps + writes CHANGELOG.md
node bin/snapshot-version.js
git add -A
git commit -m "chore: release"
git tag v$(node -p "require('./package.json').version")
git push --follow-tags
npm publish --access public
```

## What to verify after publish

```bash
# 1. The new version exists on the registry
npm view @chankov/agent-skills versions --json | tail -5

# 2. A clean install runs the new CLI
cd /tmp && mkdir smoke && cd smoke
npx @chankov/agent-skills@latest -- --version

# 3. doctor scan works against a real workspace
cd ~/projects/some-other-repo
npx @chankov/agent-skills@latest -- doctor --dry-run

# 4. The snapshot was published (required for version-aware updates)
npx --yes @chankov/agent-skills@<new-version> -- update --workspace .
```

## Unpublishing / yanking

npm allows `npm unpublish` only within 72 hours of publishing and only when
no other package depends on it. If you need to retract:

```bash
npm unpublish @chankov/agent-skills@<x.y.z>
```

Prefer `npm deprecate @chankov/agent-skills@<x.y.z> "Reason"` instead — it
leaves the version installable but warns on install. Pair it with a follow-up
patch release that fixes the problem.
