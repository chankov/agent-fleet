// T6b — selected core + four standards profiles: C#, JavaScript, SQL, Vue.
//
// Identifier scan plus contract review: profiles carry scope/rationale/
// provenance, bind to target evidence, and never prescribe project defaults,
// provider procedures, or blanket rules the plan excludes.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const text = (rel) => readFileSync(join(root, rel), "utf8");

const profiles = {
  "catalog/rules/languages/csharp.md": {
    id: "csharp",
    markers: [/awaitable/i, /nullable/i, /lifetime/i, /editorconfig/i, /do not impose.*IsValid/i],
    banned: [/require that every method.*async/i, /every method .* must be async/i, /ConfigureAwait\(false\).*prevent/i, /\bSC\./],
  },
  "catalog/rules/languages/javascript.md": {
    id: "javascript",
    markers: [/side-effect/i, /JSDoc/i, /finally/i, /formatter\/linter/i],
    banned: [/Webpack/i, /Vuex/i, /axios/i, /every `const`.*UPPER/i],
  },
  "catalog/rules/languages/sql.md": {
    id: "sql",
    markers: [/dialect/i, /backfill/i, /rolling-deployment/i, /rerun behavior/i],
    banned: [/must.*clustered/i, /(?<!not )mandate an index on every foreign key/i, /DACPAC/i, /SSDT/i, /pre\/post-deployment/i],
  },
  "catalog/rules/frameworks/vue.md": {
    id: "vue",
    markers: [/Vue version/i, /Composition/i, /duplicate submissions/i, /lifecycle/i],
    banned: [/Vuelidate/i, /Vuex/i, /Base[A-Z]\w*/, /(?<!no )forced migration(?! between)/i, /(?<!a )ban on kebab/i],
  },
};

test("four profiles exist with valid template frontmatter and no source leakage", () => {
  for (const [rel, spec] of Object.entries(profiles)) {
    assert.ok(existsSync(join(root, rel)), `${spec.id} exists`);
    const body = text(rel);
    assert.match(body, new RegExp(`^---\\nfleet-template: ${spec.id}\\nfleet-source-version: 1\\n---\\n`));
    assert.doesNotMatch(body, /RIN\.|Presentation\/|META_PRD\.md/, `${spec.id}: no reference-project paths`);
    assert.doesNotMatch(body, /^Source:/m, `${spec.id}: no source attribution`);
    assert.match(body, /Disposition: partial extraction/, `${spec.id}: disposition recorded`);
    assert.match(body, /Excluded source assumptions/, `${spec.id}: exclusions explicit`);
  }
});

test("profiles keep portable contracts and exclude blanket prescriptions", () => {
  for (const [rel, spec] of Object.entries(profiles)) {
    const body = text(rel);
    for (const marker of spec.markers) assert.match(body, marker, `${spec.id}: ${marker}`);
    for (const banned of spec.banned) assert.doesNotMatch(body, banned, `${spec.id}: ${banned}`);
  }
});

test("rule index routes to core and profiles without duplicating policy", () => {
  const index = text("catalog/rules/README.md");
  for (const name of ["architecture/repository-boundaries.md", "languages/csharp.md", "languages/javascript.md", "languages/sql.md", "frameworks/vue.md"]) {
    assert.match(index, new RegExp(name.replace(/[./]/g, (c) => `\\${c}`)), `index lists ${name}`);
  }
});

test("contrasting fixtures document what the profiles must survive", () => {
  const fixture = JSON.parse(text("bin/test/fixtures/standards-contrast.json"));
  const byProfile = new Map(Object.entries(profiles).map(([, spec]) => [spec.id, []]));
  for (const c of fixture.cases) {
    const key = c.profile === "frameworks/vue.md" ? "vue" : c.profile.replace("languages/", "").replace(".md", "");
    assert.ok(byProfile.has(key), `contrast targets a shipped profile: ${c.profile}`);
    byProfile.get(key).push(c);
  }
  for (const [id, cases] of byProfile) assert.ok(cases.length > 0, `${id} has a contrasting fixture`);
  const sql = text("catalog/rules/languages/sql.md");
  assert.match(sql, /target engine/i, "SQL profile binds the engine contrast");
  const vue = text("catalog/rules/frameworks/vue.md");
  assert.match(vue, /kebab-case/i, "Vue profile survives the casing contrast");
});
