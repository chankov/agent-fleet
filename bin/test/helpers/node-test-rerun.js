// Run `node --test` with a bounded rerun of failed tests.
//
// Release CI runs real Pi, Git and socket fixtures on shared macOS runners,
// where a cold subprocess start occasionally misses a fixture deadline. A
// single rerun of only the failed tests (Node's --test-rerun-failures) keeps
// such a stall from failing the release, while a real regression still fails
// both attempts. A test that passes only on the rerun is never silent: it is
// printed, and on GitHub Actions it becomes a warning annotation plus a
// step-summary entry, so flakiness stays visible and fixable.
//
// Retries default to 1 under CI and 0 locally; AF_TEST_RETRIES overrides.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function configuredRetries(env = process.env) {
  const raw = env.AF_TEST_RETRIES;
  if (raw !== undefined && raw !== "") {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error(`AF_TEST_RETRIES must be an integer 0-3; got ${raw}`);
    return value;
  }
  return env.CI && env.CI !== "false" ? 1 : 0;
}

// Tests whose last recorded attempt passed after the first one.
export function retriedPasses(state) {
  if (!Array.isArray(state) || !state.length) return [];
  const last = state.at(-1);
  if (!last || typeof last !== "object") return [];
  return Object.entries(last)
    .filter(([, entry]) => Number.isInteger(entry?.passed_on_attempt) && entry.passed_on_attempt > 0)
    .map(([location, entry]) => ({ location, name: String(entry.name ?? location), attempt: entry.passed_on_attempt }));
}

function escapeAnnotation(text) {
  return String(text).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A").replace(/::/g, ": :");
}

function reportRetried(label, retried, env, log) {
  if (!retried.length) return;
  log.warn(`\n${label}: ${retried.length} test(s) failed first and passed only on rerun (flaky):`);
  for (const test of retried) log.warn(`  - ${test.name} (${test.location}, attempt ${test.attempt + 1})`);
  if (env.GITHUB_ACTIONS === "true") {
    for (const test of retried) log.log(`::warning title=Flaky test (${escapeAnnotation(label)})::${escapeAnnotation(`${test.name} — ${test.location} passed only on rerun attempt ${test.attempt + 1}`)}`);
    if (env.GITHUB_STEP_SUMMARY) {
      try {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `### Flaky tests — ${label}\n\n${retried.map(test => `- \`${test.location}\` ${test.name} (passed on attempt ${test.attempt + 1})`).join("\n")}\n\n`);
      } catch {}
    }
  }
}

// Returns {status, error}; status 0 only when every test passed on some attempt.
export function runNodeTestWithRerun({ args, cwd, env = process.env, label = "node --test", retries = configuredRetries(env), spawn = spawnSync, execPath = process.execPath, stdio = "inherit", log = console }) {
  // A nested runner must report on its own, not as a child of an outer --test.
  const childEnv = { ...env };
  delete childEnv.NODE_TEST_CONTEXT;
  const stateDir = mkdtempSync(join(tmpdir(), "af-test-rerun-"));
  const stateFile = join(stateDir, "state.json");
  // --test-rerun-failures needs Node >= 24.7; older runtimes run once, unchanged.
  const supported = execPath !== process.execPath || process.allowedNodeEnvironmentFlags.has("--test-rerun-failures");
  if (!supported) retries = 0;
  try {
    let result;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) log.warn(`\n${label}: rerunning failed tests (attempt ${attempt + 1} of ${retries + 1})`);
      result = spawn(execPath, ["--test", ...(supported ? [`--test-rerun-failures=${stateFile}`] : []), ...args], { cwd, env: childEnv, stdio });
      if (result.error) return { status: 1, error: result.error };
      if (result.status === 0) break;
    }
    let state = [];
    try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch {}
    if (result.status === 0) reportRetried(label, retriedPasses(state), env, log);
    return { status: result.status ?? 1, error: undefined };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}
