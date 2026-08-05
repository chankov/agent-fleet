#!/usr/bin/env node
// force-patch-changesets.js
//
// Rewrite every pending changeset's bump level to `patch` so the following
// `changeset version` always produces a revision bump (x.y.Z+1), never a
// minor/major one — regardless of how the changesets were authored.
//
// Wired in ahead of `changeset version` in both the local `version` npm script
// and the CI release workflow's changesets/action `version` command, so local
// and CI releases agree. Remove this step (and the `minor|major` lines stay
// honored) if you ever want changeset-authored semver back.
//
// Escape hatch: a changeset carrying KEEP_BUMP_MARKER in its body keeps the
// bump it was authored with. Reserved for releases where the version number
// is itself the signal — a removed runtime, a retired command, an install-record
// break — and a silent patch bump would tell users nothing.

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const changesetDir = resolve(__dirname, "..", ".changeset");

// Frontmatter bump lines look like:  "@scope/pkg": minor
// Only the value after the colon is rewritten; the package name is preserved.
const BUMP_LINE = /^(\s*(?:"[^"]+"|[^:\s]+)\s*:\s*)(minor|major)(\s*)$/gm;

// Opt out of the forced downgrade. A YAML comment in the frontmatter: the
// changesets parser ignores it, and it stays out of the body — so the
// generated CHANGELOG entry reads as written, with no marker line in it.
const KEEP_BUMP_MARKER = "# release: keep-bump";

let changed = 0;
let kept = 0;
let scanned = 0;

for (const name of readdirSync(changesetDir)) {
  if (!name.endsWith(".md") || name === "README.md") continue;
  scanned++;
  const file = join(changesetDir, name);
  const text = readFileSync(file, "utf8");
  if (text.includes(KEEP_BUMP_MARKER)) {
    kept++;
    console.log(`force-patch: ${name} → kept (opted out via keep-bump marker)`);
    continue;
  }
  const next = text.replace(BUMP_LINE, "$1patch$3");
  if (next !== text) {
    writeFileSync(file, next, "utf8");
    changed++;
    console.log(`force-patch: ${name} → patch`);
  }
}

console.log(
  changed > 0
    ? `force-patch: rewrote ${changed} of ${scanned} changeset(s) to patch${kept > 0 ? `, kept ${kept}` : ""}`
    : `force-patch: no minor/major changesets to downgrade (${scanned} scanned${kept > 0 ? `, ${kept} kept` : ""})`,
);
