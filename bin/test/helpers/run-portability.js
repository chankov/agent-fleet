// Run in a fresh process: os.tmpdir() and child compiler cwd must observe the
// alternate environment from startup. Keep this root outside the source tree
// and away from Linux's /tmp so hardcoded /tmp assertions fail on Linux too.
import { mkdtempSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const temp = mkdtempSync(join(homedir(), ".agent-fleet-portability-"));
try {
  const alias = `${temp}-alias`;
  symlinkSync(temp, alias, "dir");
  try {
  const result = spawnSync(process.execPath, [
    "--test", "--test-timeout=120000",
    ".pi/harnesses/lib/changed-file-diagnostics.test.ts",
    ".pi/harnesses/agent-hub/tools/dispatch-execution.test.ts",
    ".pi/harnesses/agent-hub/proactive-rules.test.ts",
    ".pi/harnesses/agent-hub/proactive-local.test.ts",
    ".pi/harnesses/agent-hub/proactive-runtime.test.ts",
    ".pi/harnesses/agent-hub/proactive-snapshot.test.ts",
    ".pi/harnesses/agent-hub/proactive-feedback.test.ts",
    ".pi/harnesses/agent-hub/system1-report.test.ts",
    ".pi/harnesses/agent-hub/no-progress.test.ts",
  ], { cwd: root, env: { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp }, stdio: "inherit" });
  if (result.error) throw result.error;
  const aliasResult = spawnSync(process.execPath, [
    "--test", "--test-timeout=120000",
    ".pi/harnesses/agent-hub/proactive-rules.test.ts",
    ".pi/harnesses/agent-hub/proactive-local.test.ts",
    ".pi/harnesses/agent-hub/proactive-runtime.test.ts",
  ], { cwd: root, env: { ...process.env, TMPDIR: alias, TMP: alias, TEMP: alias }, stdio: "inherit" });
  if (aliasResult.error) throw aliasResult.error;
  process.exitCode = result.status || aliasResult.status || 0;
  } finally {
    unlinkSync(alias);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
