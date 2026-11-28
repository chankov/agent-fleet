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

test('doctor refuses retired owner selection even with valid local and child ledgers', t => {
 const ws = workspace(t);
 mkdirSync(join(ws, '.ai')); mkdirSync(join(ws, 'child/.ai'), { recursive: true });
 writeFileSync(join(ws, '.ai/agent-fleet.json'), '{"installationOwner":"child"}');
 writeConfig(ws, { ...validConfig, consumers: { taskTriage: taskSection } });
 writeFileSync(join(ws, 'child/.ai/agent-fleet-state.json'), '{"schemaVersion":2,"taskTriageSelected":true}');
 writeFileSync(join(ws, '.ai/agent-fleet-state.json'), '{"schemaVersion":2,"taskTriageSelected":true}');
 const scan = scanTaskTriageReadiness({ workspace: ws, env: { TYPESAFE_API_KEY: 'offline-only' } })[0];
 assert.equal(scan.readiness, 'invalid_selection');
 assert.equal(scan.installation, undefined);
 assert.equal(JSON.stringify(scan).includes('offline-only'), false);
});

test("runDoctor keeps task-triage advisory read-only and never prints credential values", async t => {
  const ws = workspace(t);
  mkdirSync(join(ws, ".ai"));
  writeFileSync(join(ws, ".ai/agent-fleet-state.json"), JSON.stringify({ schemaVersion: 2, taskTriageSelected: true, items: {} }));
  const triagePath = join(ws, ".ai/system1.json");
  writeConfig(ws, {...validConfig, consumers:{taskTriage:taskSection}});
  const personaDir = join(ws, ".pi/agents/personas");
  mkdirSync(personaDir, { recursive: true });
  for (const role of ["editor", "reviewer"]) writeFileSync(join(personaDir, `${role}.md`), `---\nname: ${role}\nmodel: synthetic/offline\n---\n`);
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

test("doctor shows Ask System 1's canonical mode and why the tool is or is not available, offline and without secrets (task 17)", t => {
  const secret = "synthetic-agentic-doctor-key";
  const cases = [
    ["advisory", true, "auto", { TYPESAFE_API_KEY: secret }, "available", /configured on \(legacy "advisory", read as "on"\); ask_system1 is available to the parent Hub only/],
    ["recommended", false, "auto", { TYPESAFE_API_KEY: secret }, "unavailable", /configured on \(legacy "recommended", read as "on"\); ask_system1 is unavailable because remoteContextApproved is not true/],
    ["on", true, "off", { TYPESAFE_API_KEY: secret }, "unavailable", /because root System 1 mode is off/],
    ["on", true, "auto", {}, "unavailable", /because System 1 is not locally ready \(missing_key\)/],
    ["off", true, "auto", { TYPESAFE_API_KEY: secret }, "off", /^Ask System 1: configured off$/],
  ];
  for (const [mode, consent, rootMode, env, effective, issue] of cases) {
    const ws = workspace(t); mkdirSync(join(ws, ".ai"));
    writeFileSync(join(ws, ".ai/agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
    const document = { ...validConfig, mode: rootMode, consumers: { agenticAsk: { mode, remoteContextApproved: consent, include: ["docs"] }, taskTriage: { mode: "advisory", remoteContextApproved: false } } };
    const text = JSON.stringify(document);
    writeFileSync(join(ws, ".ai/system1.json"), text);
    const finding = scanSystem1Readiness({ workspace: ws, env }).find(f => f.type === "system1-agentic-ask");
    assert.ok(finding, mode);
    assert.equal(finding.effective, effective, `${mode}/${rootMode}`);
    assert.equal(finding.configuredMode, mode === "off" ? "off" : "on");
    assert.match(finding.issue, issue);
    if (["advisory", "recommended"].includes(mode)) assert.match(finding.fix, new RegExp(`write "on" instead of "${mode}"`));
    assert.doesNotMatch(JSON.stringify(finding), new RegExp(secret), "no secret values");
    assert.equal(readFileSync(join(ws, ".ai/system1.json"), "utf8"), text, "doctor never edits the configuration");
  }
  const ws = workspace(t); mkdirSync(join(ws, ".ai"));
  writeFileSync(join(ws, ".ai/system1.json"), JSON.stringify(validConfig));
  assert.equal(scanSystem1Readiness({ workspace: ws, env: {} }).some(f => f.type === "system1-agentic-ask"), false, "no consumer section, no finding");
  writeFileSync(join(ws, ".ai/system1.json"), JSON.stringify({ ...validConfig, consumers: { agenticAsk: { mode: "on", remoteContextApproved: true } } }));
  assert.match(scanSystem1Readiness({ workspace: ws, env: { TYPESAFE_API_KEY: secret } }).find(f => f.type === "system1-agentic-ask").issue, /because the system1 feature is not enabled for this workspace/);
});

test("doctor names the direct transport for enabled System 1, stays clean when disabled, and never reads Pi's agent directory (task 16)", t => {
  const secret = "synthetic-pi-agent-dir-secret";
  for (const agentDir of ["default", "override"]) {
    const ws = workspace(t); mkdirSync(join(ws, ".ai"));
    const home = join(ws, "home"), dir = agentDir === "default" ? join(home, ".pi", "agent") : join(ws, "custom-agent");
    mkdirSync(dir, { recursive: true });
    const models = JSON.stringify({ providers: { typesafe: { apiKey: `!echo ${secret}`, models: [{ id: "jev-1.13.0" }] } } });
    const auth = JSON.stringify({ typesafe: { type: "api_key", key: secret } });
    writeFileSync(join(dir, "models.json"), models);
    writeFileSync(join(dir, "auth.json"), auth);
    writeFileSync(join(ws, ".ai/agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
    writeFileSync(join(ws, ".ai/system1.json"), JSON.stringify({ ...validConfig, consumers: { agenticAsk: { mode: "on", remoteContextApproved: true } } }));
    const env = { HOME: home, ...(agentDir === "override" ? { PI_CODING_AGENT_DIR: dir } : {}) };
    const enabled = scanSystem1Readiness({ workspace: ws, env: { ...env, TYPESAFE_API_KEY: "synthetic-env-key" } });
    const main = enabled.find(f => f.type === "system1");
    assert.equal(main.readiness, "ready", "the direct adapter is locally ready without native classification");
    assert.equal(main.transport, "direct");
    assert.match(main.issue, /transport: direct \(Fleet's TypeSafe adapter\); Pi's native classifier is not used because Pi's catalog has no classifier typesafe\/jev-1\.13\.0/);
    const missing = scanSystem1Readiness({ workspace: ws, env }).find(f => f.type === "system1");
    assert.equal(missing.readiness, "missing_key", "Pi's auth.json and models.json never count as Fleet credentials");
    const output = JSON.stringify([enabled, missing]);
    assert.doesNotMatch(output, new RegExp(secret));
    assert.doesNotMatch(output, /synthetic-env-key/);
    assert.equal(readFileSync(join(dir, "models.json"), "utf8"), models, "user configuration untouched");
    assert.equal(readFileSync(join(dir, "auth.json"), "utf8"), auth);
    writeFileSync(join(ws, ".ai/system1.json"), JSON.stringify({ ...validConfig, mode: "off" }));
    const disabled = scanSystem1Readiness({ workspace: ws, env: { ...env, TYPESAFE_API_KEY: "synthetic-env-key" } }).find(f => f.type === "system1");
    assert.equal(disabled.readiness, "disabled");
    assert.equal(Object.hasOwn(disabled, "transport"), false, "a disabled configuration is reported cleanly");
    assert.doesNotMatch(disabled.issue, /transport/);
  }
});

test("doctor never echoes an unknown key from .ai/system1.json, in text or JSON output", t => {
  const marker = "sk-synthetic-pasted-as-a-key-1f2e";
  const ws = workspace(t); mkdirSync(join(ws, ".ai"));
  writeFileSync(join(ws, ".ai/agent-fleet.json"), JSON.stringify({ features: { system1: true } }));
  // Root keys are validated first and stop there; consumer keys need a valid root.
  writeFileSync(join(ws, ".ai/system1.json"), JSON.stringify({ ...validConfig, [marker]: 1, [`a.${marker}`]: 2 }));
  const root = scanSystem1Readiness({ workspace: ws, env: {} }).filter(f => f.type === "system1-config");
  assert.deepEqual(root.map(f => f.path), ["$.<unknown field 1>", "$.<unknown field 2>"], "a key containing a dot is not split into a leaked parent");
  assert.match(root[0].issue, /unknown_field/);
  assert.doesNotMatch(JSON.stringify(root), new RegExp(marker), "root JSON findings");
  writeFileSync(join(ws, ".ai/system1.json"), JSON.stringify({ ...validConfig, consumers: { [marker]: {}, agenticAsk: { mode: "on", [marker]: true, limits: { [marker]: 1 } } } }));
  const findings = scanSystem1Readiness({ workspace: ws, env: {} });
  const configErrors = findings.filter(f => f.type === "system1-config");
  assert.ok(configErrors.some(f => f.path === "$.consumers.<unknown section 1>" && /unknown_section/.test(f.issue)), JSON.stringify(configErrors));
  assert.ok(configErrors.some(f => f.path === "$.consumers.agenticAsk.<unknown field 1>"), JSON.stringify(configErrors));
  assert.doesNotMatch(JSON.stringify(findings), new RegExp(marker), "consumer JSON findings");
  for (const args of [[], ["--json"]]) {
    const result = spawnSync(process.execPath, [cli, "doctor", "--workspace", ws, ...args], { encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" } });
    assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(marker), `doctor ${args.join(" ") || "text"} output`);
    assert.match(`${result.stdout}`, /unknown field 1|unknown_field/);
  }
});
