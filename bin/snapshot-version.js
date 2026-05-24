#!/usr/bin/env node
// snapshot-version.js
//
// Copy every shipped artifact into .versions/<x.y.z>/ so a later install can
// run a three-way diff between:
//   - source @ recorded version   ←─ this snapshot, read from the installed copy
//   - installed copy in target    ←─ what the user has on disk
//   - source @ current version    ←─ the active tree in this package
//
// Run by the release workflow right before `changeset publish`. Also runnable
// by hand if you need to rebuild a snapshot.

import { readFileSync, mkdirSync, cpSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const version = pkg.version;
const snapDir = join(root, ".versions", version);

// Paths that travel into the snapshot — matches package.json `files` for the
// installable artifacts. We deliberately skip the meta files (README, LICENSE,
// CHANGELOG, package.json) — the diff only cares about the artifacts.
const ARTIFACT_PATHS = [
  "skills",
  "agents",
  ".claude/commands",
  ".opencode/commands",
  ".pi/prompts",
  ".pi/extensions",
  ".pi/harnesses",
  ".pi/skills",
  ".pi/agents",
  ".pi/damage-control-rules.yaml",
  "references",
  "hooks",
];

if (existsSync(snapDir)) {
  console.log(`snapshot: .versions/${version}/ already exists — rebuilding`);
  rmSync(snapDir, { recursive: true, force: true });
}

mkdirSync(snapDir, { recursive: true });

// Skip nested node_modules and build artifacts — they bloat the tarball and
// the user reinstalls them after init.
const SKIP_NAMES = new Set(["node_modules", ".DS_Store", "dist", "build"]);

for (const rel of ARTIFACT_PATHS) {
  const src = join(root, rel);
  if (!existsSync(src)) continue;
  const dest = join(snapDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, {
    recursive: true,
    filter: (srcPath) => {
      const base = srcPath.split("/").pop();
      return !SKIP_NAMES.has(base);
    },
  });
}

// Stamp the snapshot with its version so the skill can verify it loaded the right one.
const stampPath = join(snapDir, ".version");
const fs = await import("node:fs/promises");
await fs.writeFile(stampPath, `${version}\n`, "utf8");

console.log(`snapshot: wrote .versions/${version}/`);
