import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { runDoctor, scanSystem1Readiness, scanTaskTriageReadiness } from "../lib/doctor.js";
import { planSystem1Migration, applySystem1Migration } from '../lib/system1-migration.js';

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "bin", "cli.js");
const validConfig = {
  version: 2,
  consumers: {},
  mode: "auto",
  provider: "typesafe",
  model: "jev-1.13.0",
  apiKeyEnv: "TYPESAFE_API_KEY",
};

// Canonicalize macOS temporary paths; migration intentionally rejects linked roots.
function workspace(t) {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), "af-doctor-system1-")));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  return ws;
}

test('doctor reports legacy watchdog aliases, consumer-only manual recovery, and private retained backups', t => {
  const ws = workspace(t); mkdirSync(join(ws, '.ai'));
  writeFileSync(join(ws, '.ai/proactive-review.json'), '{"version":1,"mode":"shadow","include":["src/**"]}');
  writeFileSync(join(ws, '.ai/agent-fleet-overrides.md'), '## Agent-Team\nWatchdog-System1: shadow\n');
  let findings = scanSystem1Readiness({ workspace: ws, env: {} });
  assert.ok(findings.some(f => f.type === 'system1-legacy' && f.path.includes('watchdog-system1')));
  assert.ok(findings.some(f => f.path === '.ai/proactive-review.json' && f.fix.includes('consumer-only-legacy-workspaces')));
  writeFileSync(join(ws, '.ai/system1.json'), JSON.stringify({ version: 1, mode: 'off', provider: 'typesafe', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY' }));
  const result = applySystem1Migration(planSystem1Migration(ws));
  findings = scanSystem1Readiness({ workspace: ws, env: {} });
  assert.ok(findings.some(f => f.type === 'system1-backup' && f.path === result.backup));
  assert.equal(findings.some(f => f.type === 'system1-legacy'), false);
});

function selectSystem1(ws) {
  mkdirSync(join(ws, ".ai"), { recursive: true });
  writeFileSync(join(ws, ".ai", "agent-fleet.json"), JSON.stringify({
    schemaVersion: 1,
    preset: "default",
    features: { system1: true },
  }));
}

function writeConfig(ws, value = validConfig) {
  mkdirSync(join(ws, ".ai"), { recursive: true });
  writeFileSync(join(ws, ".ai", "system1.json"), JSON.stringify(value, null, 2) + "\n");
}

test("System 1 doctor readiness distinguishes absent, off, invalid, missing-key, and ready", (t) => {
  const absent = workspace(t);
  assert.deepEqual(scanSystem1Readiness({ workspace: absent, env: {} }), []);

  const cases = [
    ["missing_config", undefined, {}, false],
    ["disabled", { ...validConfig, mode: "off" }, {}, false],
    ["invalid_config", { mode: "off", nonsense: true }, {}, false],
    ["migration_required", { version: 1, mode: 'auto', provider: 'typesafe', model: 'jev-1.13.0', apiKeyEnv: 'TYPESAFE_API_KEY' }, {}, false],
    ["invalid_config", { ...validConfig, model: "wrong" }, {}, false],
    ["missing_key", validConfig, {}, true],
    ["ready", validConfig, { TYPESAFE_API_KEY: "present-only-in-env" }, false],
  ];
  for (const [readiness, config, env, declareEnv] of cases) {
    const ws = workspace(t);
    selectSystem1(ws);
    if (config !== undefined) writeConfig(ws, config);
    if (declareEnv) writeFileSync(join(ws, ".env"), "TYPESAFE_API_KEY=not-loaded\n");
    const findings = scanSystem1Readiness({ workspace: ws, env });
    assert.equal(findings.filter(f => f.type === "system1").length, 1, readiness);
    assert.equal(findings[0].type, "system1");
    assert.equal(findings[0].readiness, readiness);
    assert.equal(findings[0].envDeclared, null, "doctor does not inspect .env, so declaration status is unknown");
    assert.doesNotMatch(findings[0].issue, /declared in \.env/);
    assert.equal(findings[0].environmentPresent, readiness === "ready");
    assert.equal(findings[0].apiValidity, "unverified");
    assert.equal(JSON.stringify(findings).includes("present-only-in-env"), false);
    assert.equal(JSON.stringify(findings).includes("not-loaded"), false);
    if (readiness === "disabled") {
      assert.match(findings[0].issue, /remote inference is off/);
    }
  }
});

test('doctor contextual validation separates ready provider from stale or ambiguous nested binding evidence', t => {
 const ws = workspace(t); selectSystem1(ws);
 const docs = join(ws, 'rin-docs'); mkdirSync(join(docs, '.ai/rules/docs'), { recursive: true });
 const bytes = '# Links\nUse relative Markdown links.\n';
 const logical = '.ai/rules/docs/maintenance.md';
 writeFileSync(join(docs, logical), bytes);
 writeFileSync(join(docs, '.ai/rules/README.md'), '# Index\n[links](docs/maintenance.md)\n');
 writeFileSync(join(ws, '.ai/agent-fleet-overrides.md'), '## agent-hub\nrules: rin-docs/.ai/rules\ndocs: rin-docs\n');
 const binding = { version: 1, validator: 'relative-markdown-links', rule: { path: logical, heading: 'Links', occurrence: 1, hash: createHash('sha256').update(bytes).digest('hex') }, applicability: { paths: ['rin-docs/**'], kinds: ['added', 'modified'] }, exceptions: { paths: [], legacy: false } };
 writeConfig(ws, { ...validConfig, consumers: { proactiveReview: { mode: 'shadow', include: ['ringithub/src/**', 'rin-docs/**'], localBindings: [binding] } } });
 const scan = () => scanSystem1Readiness({ workspace: ws, env: { TYPESAFE_API_KEY: 'fixture-only' } });
 let findings = scan();
 assert.equal(findings[0].readiness, 'ready');
 assert.equal(findings[0].consumerEvidence, 'unverified');
 assert.equal(findings.some(f => f.type === 'system1-binding'), false);
 writeFileSync(join(docs, logical), bytes + 'Changed.\n');
 findings = scan();
 assert.equal(findings[0].readiness, 'ready');
 assert.ok(findings.some(f => f.type === 'system1-binding' && f.issue.includes('unverified_binding')));
 const report = spawnSync(process.execPath, [cli, 'doctor', '--workspace', ws, '--json'], { encoding: 'utf8', env: { ...process.env, PI_OFFLINE: '1', TYPESAFE_API_KEY: 'fixture-only' } });
 assert.equal(report.status, 0, report.stderr + report.stdout);
 const cliFindings = JSON.parse(report.stdout).findings;
 assert.equal(cliFindings.find(f => f.type === 'system1').consumerEvidence, 'unverified');
 assert.ok(cliFindings.some(f => f.type === 'system1-binding' && f.issue.includes('unverified_binding')));
 assert.ok(!report.stdout.includes('fixture-only'));
 mkdirSync(join(ws, '.ai/rules/docs'), { recursive: true });
 writeFileSync(join(ws, logical), bytes);
 assert.ok(scan().some(f => f.type === 'system1-binding' && f.issue.includes('ambiguous_binding')));
 // Contextual sibling consent works from the application repo, not from a child's cwd.
 const app = join(ws, 'ringithub'); selectSystem1(app);
 writeFileSync(join(app, '.ai/agent-fleet-overrides.md'), '## Agent-Team\ndocs: ../rin-docs\n');
 writeConfig(app, { ...validConfig, consumers: { proactiveReview: { mode: 'shadow', include: ['../rin-docs'] } } });
 assert.equal(scanSystem1Readiness({ workspace: app, env: {} })[0].consumers.proactiveReview, 'ready');
 writeFileSync(join(app, '.ai/agent-fleet-overrides.md'), '## agent-hub\ndocs: ../rin-docs/README.md\n');
 assert.equal(scanSystem1Readiness({ workspace: app, env: {} })[0].consumers.proactiveReview, 'invalid');
 rmSync(join(ws, '.ai/system1.json')); symlinkSync('../rin-docs/provider.json', join(ws, '.ai/system1.json'));
 writeFileSync(join(docs, 'provider.json'), JSON.stringify(validConfig));
 assert.equal(scan()[0].readiness, 'invalid_config');
 rmSync(join(ws, '.ai/agent-fleet.json')); symlinkSync('../rin-docs/selection.json', join(ws, '.ai/agent-fleet.json'));
 writeFileSync(join(docs, 'selection.json'), JSON.stringify({ schemaVersion: 1, preset: 'default', features: { system1: true } }));
 writeConfig(ws); // Still a symlink: loader must refuse it regardless of target bytes.
 assert.equal(scan()[0].readiness, 'disabled');
});

test("System 1 doctor recognizes selection through the experimental task-triage feature dependency", t => {
  const ws = workspace(t);
  mkdirSync(join(ws, ".ai"));
  writeFileSync(join(ws, ".ai/agent-fleet.json"), JSON.stringify({ schemaVersion: 1, preset: "default",
    features: { system1: false, "system1-task-triage": true } }));
  writeConfig(ws);
  const findings = scanSystem1Readiness({ workspace: ws, env: { TYPESAFE_API_KEY: "fixture-only" } });
  assert.equal(findings.find(f => f.type === "system1")?.readiness, "ready");
  assert.equal(JSON.stringify(findings).includes("fixture-only"), false);
});

const taskSection = {mode:"experimental",remoteContextApproved:true,questionVersion:"task-triage/questions/v1",policyVersion:"task-triage/policy/v1",limits:{maxTaskBytes:40960,maxStateBytes:65536,maxCallsPerSession:100,timeoutMs:2000}};
test("task-triage doctor distinguishes section consent, provider and selection", t => {
 const ws=workspace(t);mkdirSync(join(ws,".ai"));
 const statePath=join(ws,".ai/agent-fleet-state.json");
 writeFileSync(statePath,JSON.stringify({schemaVersion:2,taskTriageSelected:true}));
 const scan=(env={})=>scanTaskTriageReadiness({workspace:ws,env})[0];
 assert.equal(scan().readiness,"missing_config");
 for(const [section,expected] of [[{...taskSection,policyVersion:"unknown"},"invalid_config"],[{...taskSection,remoteContextApproved:false},"unapproved"],[{...taskSection,mode:"off",remoteContextApproved:false},"disabled"],[taskSection,"missing_key"]]) {
  writeConfig(ws,{...validConfig,consumers:{taskTriage:section}});assert.equal(scan().readiness,expected);
 }
 writeConfig(ws,{...validConfig,mode:"off",consumers:{taskTriage:taskSection}});assert.equal(scan().readiness,"provider_off");
 writeConfig(ws,{...validConfig,consumers:{taskTriage:taskSection}});
 assert.equal(scan({TYPESAFE_API_KEY:"fixture-only"}).readiness,"missing_local_producer");
 writeFileSync(statePath,JSON.stringify({schemaVersion:2,taskTriageSelected:false}));
 assert.equal(scan().readiness,"disabled_by_setup");
});

test("runDoctor keeps task-triage advisory read-only and never prints credential values", async t => {
  const ws = workspace(t);
  mkdirSync(join(ws, ".ai"));
  writeFileSync(join(ws, ".ai/agent-fleet-state.json"), JSON.stringify({ schemaVersion: 2, taskTriageSelected: true, items: {} }));
  const triagePath = join(ws, ".ai/system1.json");
  writeConfig(ws, {...validConfig, consumers:{taskTriage:taskSection}});
  const personaDir = join(ws, ".pi/agents/personas");
  mkdirSync(personaDir, { recursive: true });
  for (const role of ["planner", "code-reviewer"]) writeFileSync(join(personaDir, `${role}.md`), `---\nname: ${role}\nmodel: synthetic/offline\n---\n`);
  const before = [triagePath, join(ws, ".ai/system1.json")].map(p => readFileSync(p, "utf8"));
  const env = { TYPESAFE_API_KEY: "private-test-value" };
  const findings = await runDoctor({ workspace: ws, sourceRoot: root, env, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(findings.find(f => f.type === "task-triage")?.readiness, "locally_ready");
  const applied = await runDoctor({ workspace: ws, sourceRoot: root, env, apply: true, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(applied.findings.find(f => f.type === "task-triage")?.readiness, "locally_ready");
  assert.equal(JSON.stringify(applied).includes(env.TYPESAFE_API_KEY), false);
  const childEnv = { ...process.env, ...env, PI_OFFLINE: "1" };
  for (const args of [["--json"], []]) {
    const result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws, ...args], { encoding: "utf8", env: childEnv });
    assert.ok(result.status === 0 || result.status === 2, result.stderr);
    assert.equal((result.stdout + result.stderr).includes(env.TYPESAFE_API_KEY), false);
    if (args.length) assert.equal(JSON.parse(result.stdout).findings.find(f => f.type === "task-triage")?.readiness, "locally_ready");
    else assert.match(result.stdout, /Task triage: locally_ready/);
  }
  assert.deepEqual([triagePath, join(ws, ".ai/system1.json")].map(p => readFileSync(p, "utf8")), before);
});

test("runDoctor keeps System 1 advisory and read-only even when apply is requested", async (t) => {
  const ws = workspace(t);
  selectSystem1(ws);
  writeConfig(ws);
  writeFileSync(join(ws, ".env"), "TYPESAFE_API_KEY=private-file-value\n");
  const before = new Map([
    ["desired", readFileSync(join(ws, ".ai", "agent-fleet.json"), "utf8")],
    ["config", readFileSync(join(ws, ".ai", "system1.json"), "utf8")],
    ["env", readFileSync(join(ws, ".env"), "utf8")],
  ]);

  const findings = await runDoctor({ workspace: ws, sourceRoot: root, env: {}, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(findings.filter((finding) => finding.type === "system1").length, 1);
  const applied = await runDoctor({ workspace: ws, sourceRoot: root, env: {}, apply: true, checkVisibility: () => ({ status: 0, stdout: "" }), checkDependencies: () => ({ status: 0, stdout: "" }) });
  assert.equal(applied.findings.filter((finding) => finding.type === "system1").length, 1);
  assert.equal(readFileSync(join(ws, ".ai", "agent-fleet.json"), "utf8"), before.get("desired"));
  assert.equal(readFileSync(join(ws, ".ai", "system1.json"), "utf8"), before.get("config"));
  assert.equal(readFileSync(join(ws, ".env"), "utf8"), before.get("env"));
});

test("CLI JSON/text and --fix keep System 1 advisory with zero outstanding work", (t) => {
  const ws = workspace(t);
  selectSystem1(ws);
  writeConfig(ws);
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const before = readFileSync(join(ws, ".ai", "system1.json"), "utf8");

  let result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws, "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  let report = JSON.parse(result.stdout);
  assert.equal(report.summary.outstanding, 0);
  assert.equal(report.summary.advisories, 1);
  assert.equal(report.findings.find((finding) => finding.type === "system1").readiness, "missing_key");

  result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /System 1/i);
  assert.match(result.stdout, /API validity is unverified/i);

  result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws, "--fix", "--json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  report = JSON.parse(result.stdout);
  assert.equal(report.summary.outstanding, 0);
  assert.equal(readFileSync(join(ws, ".ai", "system1.json"), "utf8"), before);
  assert.equal(existsSync(join(ws, ".env")), false, "doctor never creates or loads .env");
});
