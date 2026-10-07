import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isCaptureEnabled, loadProactiveConfig, parseProactiveConfig } from "./proactive-config.ts";
import { createHash } from "node:crypto";
import { resolvePolicyRoots } from "../lib/policy-roots.ts";
import { loadSystem1Snapshot } from "../lib/system1/config-loader.js";

test("Rankedin-shaped external includes need a directory grant, preserve config bytes and report unavailable evidence", async t => {
 const base=mkdtempSync(join(tmpdir(),"external-proactive-config-"));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const repo=join(base,"code"), docs=join(base,"rin-docs");
 mkdirSync(join(repo,".ai"),{recursive:true}); mkdirSync(join(docs,".ai/rules"),{recursive:true});
 writeFileSync(join(docs,"README.md"),"docs");
 const rule={path:".ai/rules/docs/docs-maintenance.md",heading:"Links",occurrence:1,hash:"a".repeat(64)};
 const document={version:2,mode:"off",provider:"typesafe",model:"jev-1.13.0",apiKeyEnv:"TYPESAFE_API_KEY",consumers:{proactiveReview:{mode:"shadow",remoteContext:"disabled",include:["src/**","../rin-docs"],localBindings:[{version:1,validator:"relative-markdown-links",rule,applicability:{paths:["docs/**"],kinds:["modified"]},exceptions:{paths:[],legacy:false}}]}}};
 const path=join(repo,".ai/system1.json"), raw=JSON.stringify(document); writeFileSync(path,raw);
 const table=resolvePolicyRoots(repo,{docsPaths:["../rin-docs"],rulesDirs:["../rin-docs/.ai/rules"]});
 const cfg=loadProactiveConfig(repo,undefined,table);
 assert.deepEqual(cfg.include,document.consumers.proactiveReview.include);
 assert.deepEqual(cfg.localBindings?.[0]?.rule,rule);
 assert.equal(cfg.remoteContext,"disabled");
 assert.equal(readFileSync(path,"utf8"),raw);
 assert.throws(()=>loadProactiveConfig(repo),/Invalid/);
 assert.throws(()=>loadProactiveConfig(repo,undefined,resolvePolicyRoots(repo,{docsPaths:["../rin-docs/README.md"]})),/Invalid/);
 assert.throws(()=>parseProactiveConfig({...cfg,include:["../ungranted"]},table),/include/);
 symlinkSync(repo,join(docs,"escape"));
 assert.throws(()=>parseProactiveConfig({...cfg,include:["../rin-docs/escape"]},table),/include/);
 const { beginTurnCore,finishTurnCore }=await import("./proactive-snapshot.ts");
 const context={task:{path:"task",hash:"a",revision:"a"},rules:[],exceptions:[]};
 const baseline=beginTurnCore({root:repo,config:cfg,turnId:"turn",context});
 assert.ok(baseline?.gaps.includes("external_evidence_unavailable"));
 assert.ok(finishTurnCore(baseline)?.gaps.includes("external_evidence_unavailable"));
 assert.equal(loadSystem1Snapshot(repo).consumers.proactiveReview.status,"invalid");
});

test("missing and off consumer configs cannot capture or infer", () => {
 const repo = mkdtempSync(join(tmpdir(), "proactive-off-"));
 writeFileSync(join(repo, "SECRET.ts"), "SENTINEL_DO_NOT_READ");
 assert.equal(isCaptureEnabled(loadProactiveConfig(repo)), false);
 mkdirSync(join(repo, ".ai"));
 writeFileSync(join(repo, ".ai/proactive-review.json"), '{"version":1,"mode":"off"}');
 assert.equal(isCaptureEnabled(loadProactiveConfig(repo)), false);
});
test("remote is disabled by default, local capture remains eligible", () => {
 const config = parseProactiveConfig({ version: 1, mode: "shadow", include: ["src/**"], maxEvaluationsPerSession: 2 });
 assert.equal(config.remoteContext, "disabled");
 assert.equal(isCaptureEnabled(config), true);
 assert.ok(Object.isFrozen(config.include));
});
test("unknown keys, unsafe paths and invalid limits fail closed", () => {
 const base = { version: 1, mode: "advisory", include: ["src/**"] };
 for (const extra of [{ surprise: true }, { version: 2 }, { mode: "blocking" }, { include: ["../src/**"] }, { include: [".env"] }, { include: ["node_modules/**"] }, { include: ["src\\**"] }, { include: ["src/**", "src/**"] }, { maxEvaluationsPerSession: 101 }, { maxEvaluationsPerSession: -1 }, { maxEvaluationsPerSession: 1.2 }, { remoteContext: "all" }]) assert.throws(() => parseProactiveConfig({ ...base, ...extra }));
 assert.throws(() => parseProactiveConfig({ version: 1, mode: "off", remoteContext: "selected-excerpts" }));
});
test("basename binding needs explicit captured include paths and rejects wildcard or undeclared basename", () => {
 const hash = createHash("sha256").update("synthetic rule").digest("hex");
 const binding = { version: 1, validator: "new-file-placement", rule: { path: "CONTRIBUTING.md", heading: "Creating the skill", occurrence: 1, hash }, applicability: { paths: ["SKILL.md"], kinds: ["added"], basename: "SKILL.md" }, exceptions: { paths: [], legacy: true }, placement: { prefix: "skills" } };
 const config = parseProactiveConfig({ version: 1, mode: "shadow", include: ["skills/**", "docs/**", "SKILL.md"], localBindings: [binding] });
 assert.deepEqual(config.localBindings?.[0]?.applicability.basename, "SKILL.md");
 assert.ok(Object.isFrozen(config.localBindings?.[0]?.applicability));
 for (const basename of ["*.md", "../SKILL.md", "skills/SKILL.md", "OTHER.md", ""]) assert.throws(() => parseProactiveConfig({ version: 1, mode: "shadow", include: ["skills/**"], localBindings: [{ ...binding, applicability: { ...binding.applicability, basename } }] }));
 assert.throws(() => parseProactiveConfig({ version: 1, mode: "shadow", include: ["**"], localBindings: [binding] }));
 assert.throws(() => parseProactiveConfig({ version: 1, mode: "shadow", localBindings: [binding] }));
});
test("reviewed binding is explicit, immutable and cannot turn off or malformed config into authorization", () => {
 const hash = createHash("sha256").update("synthetic rule").digest("hex");
 const binding = { version: 1, validator: "relative-markdown-links", rule: { path: "rules/synthetic.md", heading: "Links", occurrence: 1, hash }, applicability: { paths: ["docs/**"], kinds: ["added"] }, exceptions: { paths: ["docs/legacy.md"], legacy: true } };
 const enabled = parseProactiveConfig({ version: 1, mode: "shadow", include: ["docs/**"], localBindings: [binding] });
 assert.equal(enabled.remoteContext, "disabled");
 assert.equal(enabled.localBindings?.[0]?.rule.hash, hash);
 assert.ok(Object.isFrozen(enabled.localBindings?.[0]?.applicability.paths));
 assert.throws(() => parseProactiveConfig({ version: 1, mode: "off", localBindings: [binding] }));
 for (const bad of [{ ...binding, script: "npm test" }, { ...binding, rule: { ...binding.rule, occurrence: 0 } }, { ...binding, applicability: { paths: ["docs/**"], kinds: ["deleted"] } }]) assert.throws(() => parseProactiveConfig({ version: 1, mode: "shadow", include: ["docs/**"], localBindings: [bad] }));
});
