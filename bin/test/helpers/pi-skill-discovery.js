import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "yaml";

const VENDOR_SKILL_PREFIX = "vendor/agent-skills-upstream/skills/";
const AUXILIARY_SKILLS = new Map([
  ["bowser", ".pi/skills/bowser/SKILL.md"],
  ["ask-user", "node_modules/pi-ask-user/skills/ask-user/SKILL.md"],
]);

function slash(path) {
  return path.split("\\").join("/");
}

function catalogSkills(manifest) {
  return manifest.items.filter((item) => item.kind === "skill");
}

export function expectedPiSkillRoots(manifest) {
  const upstreamOnly = catalogSkills(manifest)
    .map((item) => item.agents.pi.source[0])
    .filter((source) => source.startsWith(VENDOR_SKILL_PREFIX))
    .sort();

  return [
    "./skills",
    ...upstreamOnly.map((source) => `./${source}`),
    "./.pi/skills",
    "./node_modules/pi-ask-user/skills",
  ];
}

function skillFilesUnder(directory) {
  const ownSkill = join(directory, "SKILL.md");
  if (existsSync(ownSkill)) return [ownSkill];

  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => skillFilesUnder(join(directory, entry.name)));
}

function frontmatterName(skillFile, packageRoot) {
  const rel = slash(relative(packageRoot, skillFile));
  const text = readFileSync(skillFile, "utf8");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  assert.ok(match, `missing YAML frontmatter: ${rel}`);

  let frontmatter;
  try {
    frontmatter = parse(match[1]);
  } catch (error) {
    assert.fail(`malformed YAML frontmatter in ${rel}: ${error.message}`);
  }
  assert.ok(
    frontmatter && typeof frontmatter.name === "string" && frontmatter.name.trim(),
    `missing YAML skill name: ${rel}`,
  );
  return frontmatter.name.trim();
}

export function discoverPiSkills({ packageRoot, packageJson }) {
  assert.ok(Array.isArray(packageJson.pi?.skills), "package.json pi.skills must be an array");
  const discovered = [];
  const byName = new Map();

  for (const declaredRoot of packageJson.pi.skills) {
    const absoluteRoot = join(packageRoot, declaredRoot);
    assert.ok(existsSync(absoluteRoot), `declared Pi skill root is missing: ${declaredRoot}`);
    assert.ok(statSync(absoluteRoot).isDirectory(), `declared Pi skill root is not a directory: ${declaredRoot}`);

    for (const skillFile of skillFilesUnder(absoluteRoot)) {
      const entry = {
        name: frontmatterName(skillFile, packageRoot),
        path: slash(relative(packageRoot, skillFile)),
      };
      const previous = byName.get(entry.name);
      assert.equal(
        previous,
        undefined,
        `duplicate Pi skill name "${entry.name}": ${previous?.path} and ${entry.path}`,
      );
      byName.set(entry.name, entry);
      discovered.push(entry);
    }
  }

  return discovered.sort((a, b) => a.name.localeCompare(b.name));
}

export function assertPiSkillRoots({ packageJson, manifest }) {
  assert.deepEqual(
    packageJson.pi.skills,
    expectedPiSkillRoots(manifest),
    "package.json pi.skills must expose native roots and manifest-derived upstream-only roots",
  );
}

export function assertPiSkillCatalog({ packageRoot, packageJson, manifest }) {
  const discovered = discoverPiSkills({ packageRoot, packageJson });
  const actual = new Map(discovered.map((entry) => [entry.name, entry.path]));
  const expected = new Map(AUXILIARY_SKILLS);

  for (const item of catalogSkills(manifest)) {
    const source = item.agents.pi.source[0];
    assert.ok(source, `${item.id} has no Pi source winner`);
    if (item.agents.pi.source.some((candidate) => candidate.startsWith("skills/"))) {
      assert.ok(source.startsWith("skills/"), `${item.id} must prefer its native skills/ source`);
    }
    expected.set(item.id.slice("skill:".length), `${source}/SKILL.md`);
  }

  assert.deepEqual(
    [...actual.entries()].sort(),
    [...expected.entries()].sort(),
    "Pi skill discovery must match catalog winners plus bowser and bundled ask-user",
  );

  return discovered;
}

export function assertPiSkillDiscovery(options) {
  assertPiSkillRoots(options);
  return assertPiSkillCatalog(options);
}
