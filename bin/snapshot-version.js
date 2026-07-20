#!/usr/bin/env node
// snapshot-version.js
//
// Copy every shipped artifact into .versions/<x.y.z>/ so a later install can
// run a three-way diff between:
//   - source @ recorded version   ←─ this snapshot, read from the installed copy
//   - installed copy in target    ←─ what the user has on disk
//   - source @ current version    ←─ the active tree in this package
//
// Run while preparing the release version so the snapshot is committed in the
// Version Packages PR. Also runnable by hand if you need to rebuild a snapshot.

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
  "vendor/agent-skills-upstream",
  "agents",
  "codex",
  "hermes",
  "systemd",
  ".claude/commands",
  ".claude/orchestrate-teams.yaml",
  ".opencode/commands",
  ".opencode/orchestrate-teams.yaml",
  ".pi/prompts",
  ".pi/extensions",
  ".pi/harnesses",
  ".pi/skills",
  ".pi/agents",
  ".pi/damage-control-rules.yaml",
  // scripts/ ships runtime helpers like team-up.ts that the pi harness
  // recipes shell out to. Test files stay out (filtered below) — they're
  // dev-only.
  "scripts",
  // justfile carries the pi harness launch recipes. It is a companion of the
  // harness group in guided-workspace-setup, so the snapshot must hold a
  // per-version copy for the upgrade three-way diff (retired-harness recipes
  // pruned, new-harness recipes added on refresh).
  "justfile",
  // Snapshot only documentation shipped at the package root. Copying the
  // whole directory would put non-installed docs into the three-way base.
  "docs/agent-fleet-setup.md",
  "docs/ARCHITECTURE.md",
  "docs/codex-remote-conductor.md",
  "docs/claude-code-coms-bridge.md",
  "docs/coms-hermes-bridge.md",
  "docs/pi-extensions.md",
  "docs/npm-install.md",
  "docs/skill-anatomy.md",
  "docs/getting-started.md",
  "docs/opencode-setup.md",
  "docs/pi-setup.md",
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
      if (SKIP_NAMES.has(base)) return false;
      // Directory entries above match package surfaces; dev-only tests stay out.
      if (
        base.endsWith(".test.mjs") ||
        base.endsWith(".test.js") ||
        base.endsWith(".test.ts") ||
        base.endsWith("-test.sh")
      ) return false;
      return true;
    },
  });
}

// Stamp the snapshot with its version so the skill can verify it loaded the right one.
const stampPath = join(snapDir, ".version");
const fs = await import("node:fs/promises");
await fs.writeFile(stampPath, `${version}\n`, "utf8");

console.log(`snapshot: wrote .versions/${version}/`);
