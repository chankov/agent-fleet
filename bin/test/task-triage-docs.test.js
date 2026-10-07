import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseTaskTriageConfig } from "../../.pi/harnesses/agent-hub/task-triage-config.ts";
import { TASK_TRIAGE_THRESHOLDS } from "../../.pi/harnesses/agent-hub/task-triage-policy.ts";

const docs = ["docs/agent-fleet-setup.md", "docs/npm-install.md", "docs/ARCHITECTURE.md", ".pi/harnesses/agent-hub/README.md"];
test("task-triage documented config and complete off form pass the production validator", () => {
 const text = readFileSync(docs[0], "utf8");
 const section = text.split("## Task triage (active experimental; off by default)")[1]?.split("## Proactive turn review")[0];
 assert.ok(section);
 const json = section.match(/```json\n([\s\S]*?)\n```/)?.[1];
 assert.ok(json);
 const document = JSON.parse(json);
 const config = { version: 1, ...document.consumers.taskTriage, provider: document.provider, model: document.model }, parsed = parseTaskTriageConfig(config);
 assert.equal(parsed.status, "active");
 assert.equal(parseTaskTriageConfig({ ...config, mode: "off", remoteContextApproved: false }).status, "off");
 assert.deepEqual(config.limits, { maxTaskBytes: 40960, maxStateBytes: 65536, maxCallsPerSession: 100, timeoutMs: 2000 });
 for (const [reason, threshold] of Object.entries(TASK_TRIAGE_THRESHOLDS)) {
  assert.match(section, new RegExp(reason + "` at \\*\\*p ≥ " + threshold.toFixed(2)));
 }
 assert.match(section, /--task-triage-consent --yes/);
 assert.match(section, /--features system1-task-triage --save-desired/);
 assert.match(section, /--features none --save-desired --yes/);
 assert.match(section, /100 logical evaluations/); assert.match(section, /32 KiB viewer payload limit/);
});
test("task-triage docs distinguish complete action detail cap from metadata audit and human-route privacy", () => {
 for (const path of docs) {
  const text = readFileSync(path, "utf8");
  assert.match(text, /complete\s+tool inputs as JSON/i, path);
  assert.match(text, /8 KiB \(8192 bytes\)/, path);
  assert.match(text, /without\s+(?:\*\*)?\s*truncation or\s+partial\s+redaction/i, path);
  assert.match(text, /not local-only/i, path);
  assert.match(text, /local\/remote human route/i, path);
  assert.match(text, /Pi tool\/\s*session rendering/i, path);
 }
});

test("task-triage docs distinguish saved selection, readiness, consumer policy and semantic acceptance", () => {
 for (const path of docs) {
  const text = readFileSync(path, "utf8");
  assert.match(text, /system1-task-triage/, path); assert.match(text, /--save-desired/, path);
  assert.match(text, /waiv/i, path); assert.match(text, /calibrat/i, path);
  assert.doesNotMatch(text, /This foundation has no Watchdog|packaged doctor execution on Node 18 remains\s+unverified|distinguishes an?\s+\.env.*declaration/i, path);
  for (const [, link] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
   if (/^(https?:|mailto:|file:|#)/.test(link)) continue;
   const target = link.split("#")[0];
   if (target) assert.ok(existsSync(resolve(dirname(path), target)), `${path} links to missing ${link}`);
  }
 }
});
