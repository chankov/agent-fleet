// Explicit offline human UI fixture. Never part of installed runtime (bin/test is excluded).
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

export const TRIAGE_UI_SCENES = ["applied", "waived", "timeout", "oversized", "stale", "action"];
const root = fileURLToPath(new URL("../../../", import.meta.url));
const HELP = "Offline HUMAN task-triage UI check (not automatic acceptance).\nnode bin/test/helpers/task-triage-ui.mjs applied|waived|timeout|oversized|stale|action [--keep]\nFresh temporary workspace and synthetic-only provider; no live API or credentials.\n/triage-ui-fill <scene> puts reviewed input in the editor; Enter sends it.\n/af-agents-list opens Fleet; 1 opens communication viewer, e enables capture, d clears.\n/triage-ui-waiver puts the real waiver command in the editor; you must authorize it yourself.\naction: fixed synthetic bash/write/edit calls; only your Yes/No can authorize an effect.\n/triage-ui-action-status reports only the fixed temporary files; no automatic acceptance.\n--keep retains synthetic session artifacts after /quit for human review.\n";

export function prepareTriageUiCase(scene, { ambient = process.env } = {}) {
 if (!TRIAGE_UI_SCENES.includes(scene)) throw new Error("Unknown UI scene");
 const workspace = mkdtempSync(join(tmpdir(), "task-triage-ui-"));
 try {
  for (const dir of [".ai", "home", "agent"]) mkdirSync(join(workspace, dir), { mode: 0o700 });
  writeFileSync(join(workspace, ".ai/agent-fleet.json"), JSON.stringify({ features: { system1: true } }), { mode: 0o600 });
  writeFileSync(join(workspace, ".ai/system1.json"), JSON.stringify({ version: 2, mode: "auto", provider: "typesafe", model: "jev-1.13.0", apiKeyEnv: "TYPESAFE_API_KEY", consumers: { taskTriage: { mode: "experimental", remoteContextApproved: true, questionVersion: "task-triage/questions/v1", policyVersion: "task-triage/policy/v1", limits: { maxTaskBytes: 40960, maxStateBytes: 65536, maxCallsPerSession: 100, timeoutMs: 2000 } } } }), { mode: 0o600 });
  writeFileSync(join(workspace, ".ai/task-triage.json"), JSON.stringify({ version: 1, mode: "experimental", remoteContextApproved: true,
   provider: "typesafe", model: "jev-1.13.0", questionVersion: "task-triage/questions/v1", policyVersion: "task-triage/policy/v1",
   limits: { maxTaskBytes: 40960, maxStateBytes: 65536, maxCallsPerSession: 100, timeoutMs: 2000 } }), { mode: 0o600 });
  writeFileSync(join(workspace, ".ai/agent-fleet-overrides.md"), "## agent-hub\nwatchdog-system1: off\nlanguage: Bulgarian\n", { mode: 0o600 });
  if (scene === "action") writeFileSync(join(workspace, "action-edit.txt"), "alpha-before\nbeta-before\n", { mode: 0o600 });
  const env = { PATH: ambient.PATH ?? process.env.PATH, TERM: ambient.TERM || "xterm-256color", LANG: "C.UTF-8",
   HOME: join(workspace, "home"), PI_CODING_AGENT_DIR: join(workspace, "agent"), PI_OFFLINE: "1", AGENT_SKILLS_NO_UPDATE_CHECK: "1",
   TYPESAFE_API_KEY: "synthetic-test-only-key", AF_TASK_TRIAGE_UI: "1", AF_TASK_TRIAGE_UI_SCENE: scene,
   AF_TASK_TRIAGE_UI_READY: join(workspace, "ready.json"), AF_TASK_TRIAGE_UI_WORKSPACE: workspace,
   AGENT_HUB_TASK_TRIAGE_FAKE: scene === "timeout" ? "timeout" : scene === "action" ? "irreversible" : "security",
   AGENT_HUB_TASK_TRIAGE_FAKE_RECORD: join(workspace, "fake-calls.ndjson"),
   NODE_OPTIONS: `--import=${join(root, "bin/test/helpers/system1-no-network.js")}` };
  const args = ["--offline", "--no-approve", "--no-extensions", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-session",
   "-e", join(root, ".pi/harnesses/damage-control-continue/index.ts"),
   "-e", join(root, ".pi/harnesses/ask-user-remote/index.ts"),
   "-e", join(root, ".pi/harnesses/agent-hub/index.ts"),
   "-e", join(root, "bin/test/helpers/task-triage-ui-probe.ts"),
   "--solo", "--work-mode", "operator", "--model", "triage-ui/m"];
  return { workspace, executable: join(root, "node_modules/.bin/pi"), args, env };
 } catch (error) { rmSync(workspace, { recursive: true, force: true }); throw error; }
}

export async function runTriageUiCase(scene, keep = false) {
 const prepared = prepareTriageUiCase(scene);
 console.error(`Synthetic UI workspace: ${prepared.workspace}\n${HELP}`);
 try {
  return await new Promise((resolveExit, reject) => {
   const child = spawn(prepared.executable, prepared.args, { cwd: prepared.workspace, env: prepared.env, stdio: "inherit" });
   const interrupt = () => child.kill("SIGINT"), terminate = () => child.kill("SIGTERM");
   process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
   const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
   child.once("error", error => { cleanup(); reject(error); });
   child.once("close", code => { cleanup(); resolveExit(code ?? 1); });
  });
 } finally {
  if (keep) console.error(`Retained SYNTHETIC artifacts (not human acceptance): ${prepared.workspace}`);
  else rmSync(prepared.workspace, { recursive: true, force: true });
 }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
 const args = process.argv.slice(2);
 if (!args.length || args.includes("--help")) console.log(HELP);
 else if (args.length > 2 || args.slice(1).some(arg => arg !== "--keep")) { console.error(HELP); process.exitCode = 1; }
 else try { process.exitCode = await runTriageUiCase(args[0], args.includes("--keep")); }
 catch { console.error("Offline UI fixture refused or failed; no human acceptance recorded."); process.exitCode = 1; }
}
