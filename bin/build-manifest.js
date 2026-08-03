#!/usr/bin/env node
// build-manifest.js
//
// Regenerate install-manifest.json from the repository tree + manifest-meta.json.
//
//   node bin/build-manifest.js           # write install-manifest.json
//   node bin/build-manifest.js --check   # fail if the committed file is stale
//   node bin/build-manifest.js --stdout  # print, write nothing
//
// `--check` is the drift guard: the manifest is generated, so a new skill,
// persona, command, extension, or harness landing in the tree without a
// regenerated manifest is a CI failure rather than a silently missing menu row.
//
// Run it alongside snapshot-version.js while preparing a release so the
// per-version snapshot carries the manifest its upgrade base needs.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  buildManifest,
  serializeManifest,
  validateManifest,
  MANIFEST_FILE,
} from "./lib/manifest.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const args = process.argv.slice(2);
const check = args.includes("--check");
const toStdout = args.includes("--stdout");

const manifest = buildManifest({ sourceRoot: root, packageVersion: pkg.version });
const problems = validateManifest(manifest, { sourceRoot: root });

if (problems.length > 0) {
  console.error(`build-manifest: ${problems.length} validation problem(s):`);
  for (const p of problems) console.error(`  • ${p}`);
  process.exit(1);
}

const serialized = serializeManifest(manifest);
const outPath = join(root, MANIFEST_FILE);

if (toStdout) {
  process.stdout.write(serialized);
  process.exit(0);
}

if (check) {
  const current = existsSync(outPath) ? readFileSync(outPath, "utf8") : null;
  if (current === serialized) {
    console.log(`build-manifest: ${MANIFEST_FILE} is up to date (${manifest.items.length} items).`);
    process.exit(0);
  }
  console.error(
    current === null
      ? `build-manifest: ${MANIFEST_FILE} is missing — run \`node bin/build-manifest.js\``
      : `build-manifest: ${MANIFEST_FILE} is stale — run \`node bin/build-manifest.js\``,
  );
  process.exit(1);
}

writeFileSync(outPath, serialized);
console.log(`build-manifest: wrote ${MANIFEST_FILE} — ${manifest.items.length} items.`);
