import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fastTestFiles = [
  "bin/test/features.test.js",
  "bin/test/overrides.test.js",
  "bin/test/catalogue-accepted.test.js",
  "bin/test/catalogue-attribution.test.js",
  "bin/test/catalogue-maintenance-rules.test.js",
  "bin/test/catalogue-portable-rules.test.js",
  "bin/test/catalogue-commands.test.js",
  "bin/test/catalogue-prompts.test.js",
  "bin/test/catalogue-security.test.js",
  "bin/test/minimal-catalogue.test.js",
  "bin/test/manifest.test.js",
  "bin/test/desired.test.js",
  "bin/test/project-provenance.test.js",
  "bin/test/standards-profiles.test.js",
  "bin/test/verify.test.js",
  "bin/test/plan.test.js",
  "bin/test/transaction.test.js",
  "bin/test/reconcile.test.js",
  "bin/test/setup-delivery.test.js",
  "bin/test/release-workflow.test.js",
  ".pi/harnesses/agent-hub/proactive-config.test.ts",
  ".pi/harnesses/agent-hub/proactive-selection.test.ts",
  ".pi/harnesses/agent-hub/proactive-evaluate.test.ts",
  ".pi/harnesses/agent-hub/proactive-runtime.test.ts",
  ".pi/harnesses/agent-hub/proactive-rules.test.ts",
  ".pi/harnesses/agent-hub/proactive-local.test.ts",
  ".pi/harnesses/agent-hub/proactive-findings.test.ts",
  ".pi/harnesses/agent-hub/return-contract.test.js",
  ".pi/harnesses/agent-hub/return-extract.test.js",
  ".pi/harnesses/agent-hub/evidence-rules.test.js",
  ".pi/harnesses/agent-hub/run-budget.test.js",
  ".pi/harnesses/agent-hub/assertion-ledger.test.js",
  ".pi/harnesses/agent-hub/provider-semaphore.test.js",
  ".pi/harnesses/agent-hub/context-window.test.ts",
  ".pi/harnesses/agent-hub/backend-policy.test.ts",
];

console.log(`Fast lane: ${fastTestFiles.length} focused test files; release CI uses this lane. npm run test:full remains available locally.`);
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=4", "--test-timeout=30000", ...fastTestFiles], {
  cwd: root,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Unable to start the fast test lane: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
