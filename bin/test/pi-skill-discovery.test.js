import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildManifest } from "../lib/manifest.js";
import {
  assertPiSkillCatalog,
  expectedPiSkillRoots,
} from "./helpers/pi-skill-discovery.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const manifest = buildManifest({ sourceRoot: root, packageVersion: pkg.version });

test("Pi declares native roots plus manifest-derived upstream-only roots", () => {
  assert.deepEqual(pkg.pi.skills, expectedPiSkillRoots(manifest));
});

test("Pi exposes unique catalog winners plus auxiliary skills", () => {
  assertPiSkillCatalog({ packageRoot: root, packageJson: pkg, manifest });
});
