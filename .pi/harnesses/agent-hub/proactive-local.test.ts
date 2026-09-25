import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assessLocal, parseLocalBindings } from "./proactive-local.ts";
import { createProactiveRuntime } from "./proactive-runtime.ts";
import { parseProactiveConfig } from "./proactive-config.ts";
import type { TurnSnapshot } from "./proactive-types.ts";
import type { CatalogSection } from "./proactive-rules.ts";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const ruleText = "# Placement\nOnly new source files in src/new. Exceptions: generated files.\n";
const source = { path: "rules/synthetic.md", revision: hash(ruleText), hash: hash(ruleText) };
const section: CatalogSection = { id: `rules/synthetic.md#Placement@1:${hash(ruleText)}`, source, heading: "Placement", occurrence: 1, text: ruleText, context: "", kind: "default" };
const rule = { path: source.path, heading: section.heading, occurrence: 1, hash: source.hash };
const link = { version: 1, validator: "relative-markdown-links", rule, applicability: { paths: ["docs/**"], kinds: ["added", "modified"] }, exceptions: { paths: ["docs/legacy.md"], legacy: false } };
const placement = { version: 1, validator: "new-file-placement", rule, applicability: { paths: ["src/**"], kinds: ["added"] }, exceptions: { paths: ["src/generated/auto.ts"], legacy: true }, placement: { prefix: "src/new" } };
function snapshot(units: { path: string; kind: "added" | "modified"; text: string; id?: string }[], ruleHash = source.hash): TurnSnapshot {
 return { snapshotId: "snap", turnId: "session:hub:direct:1", head: "head", status: "complete", gaps: [], context: { task: { path: "task", revision: "x", hash: "x" }, rules: [{ ...source, hash: ruleHash }], exceptions: [] }, planStatus: "task_only", observedPaths: units.length, coverage: { retainedUnits: units.length, retainedBytes: 0, omittedPaths: 0 }, units: units.map((u, i) => ({ id: u.id ?? `u${i}`, path: u.path, kind: u.kind, attribution: "observed_only", after: { hash: hash(u.text), offset: 0, endOffset: Buffer.byteLength(u.text), startLine: 1, endLine: u.text.split("\n").length, text: u.text, truncated: false } })) };
}
const bindings = parseLocalBindings([link, placement]);
test("explicit v1 reviewed schema refuses commands, regex, malformed placement and off activation", () => {
 for (const invalid of [{ ...link, command: "echo secret" }, { ...link, version: 2 }, { ...link, applicability: { paths: ["../docs/**"], kinds: ["added"] } }, { ...placement, placement: { prefix: "/tmp" } }, { ...placement, applicability: { paths: ["src/**"], kinds: ["modified"] } }, { ...link, rule: { ...rule, hash: "changed" } }]) assert.throws(() => parseLocalBindings([invalid]));
 assert.throws(() => parseProactiveConfig({ version: 1, mode: "off", localBindings: [link] }));
 assert.equal(parseProactiveConfig({ version: 1, mode: "shadow", include: ["docs/**"], localBindings: [link] }).remoteContext, "disabled");
 assert.ok(Object.isFrozen(bindings[0]!.rule));
});
test("relative Markdown links check only authored eligible prose, with real byte/line locator", () => {
 const text = "[valid](../guide.md) [web](https://site.tld) [anchor](#part)\n```md\n[example](/bad.md)\n```\n    [indented](/bad.md)\n`[inline](/bad.md)`\n[bad](/root.md)\n[escape](../../../out.md)\n";
 const result = assessLocal(snapshot([{ path: "docs/new.md", kind: "added", text }, { path: "docs/legacy.md", kind: "modified", text }]), [section], bindings);
 assert.equal(result.findings.length, 2);
 assert.deepEqual(result.findings.map(f => f.locator.line), [7, 8]);
 assert.equal(result.findings[0]!.locator.byteOffset, Buffer.byteLength(text.slice(0, text.indexOf("[bad]"))));
 assert.equal(result.findings[0]!.ruleHash, source.hash);
 assert.equal(result.gaps.filter(g => g.startsWith("unchecked_link:")).length, 0);
});
test("reference-style and angle-bracket links outside code are explicit gaps, never an all-clear", () => {
 const outside = [
  "[full][id]\n[id]: ../out.md\n",
  "[collapsed][]\n[collapsed]: ../out.md\n",
  "[shortcut]\n[shortcut]: ../out.md\n",
  "[angle](<../out.md>)\n[id]: <../out.md>\n",
 ].join("");
 const leaked = assessLocal(snapshot([{ path: "docs/new.md", kind: "added", text: outside }]), [section], bindings);
 assert.equal(leaked.findings.length, 0);
 assert.match(leaked.gaps.join(), /unchecked_link:u0/);
 const examples = "```md\n[full][id]\n[id]: ../out.md\n[collapsed][]\n[shortcut]\n[angle](<../out.md>)\n```\n`[shortcut]` `[id]: ../out.md` `[angle](<../out.md>)`\n";
 const fenced = assessLocal(snapshot([{ path: "docs/new.md", kind: "added", text: examples }]), [section], bindings);
 assert.deepEqual(fenced.findings, []);
 assert.equal(fenced.gaps.filter(g => g.startsWith("unchecked_link:")).length, 0);
});
test("new only placement, reviewed exceptions, changed rule and unverified bytes fail closed", () => {
 const units = [{ path: "src/old/legacy.ts", kind: "modified" as const, text: "legacy" }, { path: "src/generated/auto.ts", kind: "added" as const, text: "generated" }, { path: "src/new/ok.ts", kind: "added" as const, text: "new" }, { path: "src/old/new.ts", kind: "added" as const, text: "new" }];
 const snap = snapshot(units);
 const result = assessLocal(snap, [section], bindings);
 assert.equal(result.findings.length, 1);
 assert.equal(result.findings[0]!.locator.path, "src/old/new.ts");
 assert.equal(result.findings[0]!.locator.line, undefined); // placement is a path violation, not a claim about line one
 assert.equal(result.findings[0]!.locator.byteOffset, undefined);
 assert.equal(assessLocal(snapshot(units, hash("changed")), [section], bindings).findings.length, 0);
 assert.match(assessLocal(snapshot(units, hash("changed")), [section], bindings).gaps.join(), /unverified_binding/);
 const corrupt = { ...snap, units: snap.units.map(u => ({ ...u, after: { ...u.after!, hash: hash("other") } })) };
 assert.equal(assessLocal(corrupt, [section], bindings).findings.length, 0);
 const unsupported = assessLocal(snapshot([{ path: "src/old/View.vue", kind: "added", text: "<template>example</template>" }, { path: "src/old/Service.cs", kind: "added", text: "// example" }]), [section], [bindings[1]!]);
 assert.equal(unsupported.findings.length, 2); // structural path checks only
 assert.equal(unsupported.gaps.filter(g => g.startsWith("needs_review:unsupported_semantics")).length, 2);
});
test("reviewed exact basename matches only captured, include-authorized added SKILL.md paths", () => {
 const binding = parseLocalBindings([{ version: 1, validator: "new-file-placement", rule,
  applicability: { paths: ["SKILL.md"], kinds: ["added"], basename: "SKILL.md" },
  exceptions: { paths: [], legacy: true }, placement: { prefix: "skills" } }]);
 const units = [
  { path: "skills/x/SKILL.md", kind: "added" as const, text: "# Good" },
  { path: "docs/x/SKILL.md", kind: "added" as const, text: "# Wrong directory" },
  { path: "SKILL.md", kind: "added" as const, text: "# Wrong root" },
  { path: "docs/x/OTHER.md", kind: "added" as const, text: "# Unrelated" },
  { path: "skills/x/readme.md", kind: "added" as const, text: "# Unrelated" },
  { path: "docs/x/SKILL.md", kind: "modified" as const, text: "# Legacy" },
  { path: "other/x/SKILL.md", kind: "added" as const, text: "# Not captured" },
 ];
 const include = ["skills/**", "docs/**", "SKILL.md"];
 const result = assessLocal(snapshot(units), [section], binding, include);
 assert.deepEqual(result.findings.map(f => f.locator.path), ["docs/x/SKILL.md", "SKILL.md"]);
 assert.ok(result.findings.every(f => f.locator.excerptHash === hash(units.find(u => u.path === f.locator.path)!.text) && f.locator.line === undefined && f.ruleHash === source.hash));
 assert.equal(assessLocal(snapshot(units, hash("changed")), [section], binding, include).findings.length, 0);
 assert.match(assessLocal(snapshot(units, hash("changed")), [section], binding, include).gaps.join(), /unverified_binding/);
 const corrupt = snapshot([{ path: "docs/x/SKILL.md", kind: "added", text: "# Wrong" }]);
 const altered = { ...corrupt, units: corrupt.units.map(u => ({ ...u, after: { ...u.after!, text: "# Changed after capture" } })) };
 assert.deepEqual(assessLocal(altered, [section], binding, include).findings, []);
 assert.match(assessLocal(altered, [section], binding, include).gaps.join(), /unverified_locator/);
});
test("local findings survive disabled remote, exhausted semantic budget and unavailable evaluator without false reviewed", async () => {
 const config = parseProactiveConfig({ version: 1, mode: "shadow", include: ["src/**"], maxEvaluationsPerSession: 0, localBindings: [placement] });
 const runtime = createProactiveRuntime({ config, localSections: [section] });
 assert.equal(runtime.submit("hub", "direct", snapshot([{ path: "src/old/new.ts", kind: "added", text: "new" }]), 1), true);
 assert.equal(runtime.used, 0);
 assert.equal(runtime.records[0]!.status, "not_checked");
 assert.equal(runtime.records[0]!.assessment!.findings.length, 1);
 const failing = createProactiveRuntime({ config: { ...config, maxEvaluationsPerSession: 1 }, localSections: [section], evaluate: async () => { throw Error("semantic unavailable"); } });
 failing.submit("hub", "direct", snapshot([{ path: "src/old/new.ts", kind: "added", text: "new" }]), 1);
 await new Promise(resolve => setTimeout(resolve, 20));
 assert.equal(failing.records[0]!.status, "unavailable");
 assert.equal(failing.records[0]!.assessment!.findings.length, 1);
});
