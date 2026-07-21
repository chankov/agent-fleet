# Manual npm publish — patch-only releases

Manual runbook for publishing `@chankov/agent-fleet` to npm with a **revision
(patch) bump only** (e.g. `1.0.1 → 1.0.2`). Run from the repo root on a clean
`main`.

## 0. One-time prerequisite — avoid the double-bump

`npm version` fires the `version` npm **lifecycle hook**. If that hook runs
`changeset version`, then `npm version patch` bumps **twice** (npm's patch +
whatever the pending changesets declare) — this is how a patch turned into
`1.0.0 → 1.1.0`. Check it:

```sh
node -e "console.log(require('./package.json').scripts.version || '(none)')"
```

If it prints `changeset version` (or anything ending in `changeset version`),
rename it so it is no longer a lifecycle hook (do this once, then commit):

```jsonc
// package.json → scripts: rename the lifecycle hook away
"version:changeset": "changeset version"   // was "version": "changeset version"
```

After the rename, `npm version patch` is always a clean single patch bump.
Run the changeset flow (when you use it) with `npm run version:changeset`.

## 1. Auth

```sh
# already logged in?
npm whoami        
  # if not
npm login 
```

## 2. Sync & install

```sh
git switch main
git pull
npm install
```

## 3. Check the current version

```sh
# check the current version — it should be the version you want to bump
node -p "require('./package.json').version"
```

## 4. Safety guard — no pending changesets

```sh
# if there are pending changesets, npm version can double-bump — clear them first
ls .changeset/*.md 2>/dev/null | grep -v README || echo "no pending changesets — ok"
```

## 5. Patch bump (no git commit/tag)

```sh
# patch bump: 1.0.1 -> 1.0.2
npm version patch --no-git-tag-version
```

## 6. Stamp harness manifests and rebuild the version snapshot

```sh
# derives each persistent harness's adjacent version stamp from the root package version
node bin/sync-harness-versions.js

# mirrors the new version's artifacts into .versions/<new-version>/
node bin/snapshot-version.js
```

## 7. Verify package contents & run tests

```sh
npm run pack:dry
npm test
```

## 8. Commit & tag

`--no-git-tag-version` means npm did **not** commit or tag — do it manually:

```sh
VER=$(node -p "require('./package.json').version")
git add -A
git commit -m "chore: release v$VER"
git tag "v$VER"
```

## 9. Publish

```sh
npm publish --access public --tag latest
   # --tag latest is the default
```

## 10. Verify the registry & push

```sh
npm view @chankov/agent-fleet version      # should equal $VER
git push && git push --tags
```

------------
  npx @chankov/agent-fleet@latest update --agent pi