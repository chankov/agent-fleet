// USER RUN ONLY: node .pi/harnesses/agent-hub/task-triage-reviewer-only.user-run.mjs --live --from /tmp/t4-live-stage-closure-...
// Real provider spend. Never imported by offline tests/npm; no original fixture writes.
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewFixture, independentReviewUnmet, reviewGateSource } from "./task-triage-reviewer-only-contract.mjs";
import { reviewReturnTemplate } from "./task-triage-review-contract.mjs";
import { BENIGN_UI_METHODS, createReviewDiagnostics } from "./task-triage-reviewer-only-diagnostics.mjs";

if (process.argv.length !== 5 || process.argv[2] !== "--live" || process.argv[3] !== "--from") {
  console.error("LIVE MODEL SPEND: supply --live --from <absolute retained fixture>; no offline/automatic mode.");
  process.exitCode = 2;
} else {
  await run(process.argv[4]);
}

async function run(from) {
  let fixture;
  try { fixture = reviewFixture(from); fixture.verify(); }
  catch (e) { console.error(`Pre-spend fixture refusal: ${e.message}`); process.exitCode = 2; return; }
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "t4-independent-review-"));
  const workspace = join(dir, "worktree"), evidence = join(dir, "evidence");
  mkdirSync(join(workspace, ".pi/agents/personas"), { recursive: true });
  mkdirSync(join(workspace, "skills/orchestration-verification"), { recursive: true });
  mkdirSync(evidence);
  // The original result and all original evidence remain read-only inputs; only this fresh directory receives writes.
  cpSync(join(root, "skills/orchestration-verification/SKILL.md"), join(workspace, "skills/orchestration-verification/SKILL.md"));
  cpSync(fixture.after, join(workspace, "README-SYNTH.md")); // isolated scope root, not original evidence
  writeFileSync(join(workspace, ".pi/agents/teams.yaml"), "review-only:\n  - code-reviewer\n");
  writeFileSync(join(workspace, ".pi/agents/personas/code-reviewer.md"), `---\nname: code-reviewer\ndescription: Independent synthetic fixture reviewer\ntools: read,grep,find,ls\nmodel: openai-codex/gpt-6-luna\ndelegate_depth: 0\n---\nReview only the retained synthetic evidence named in the dispatch. Do not run commands, edit, write, delegate or read credentials. First line must be exactly VERDICT: APPROVE or VERDICT: REJECT.\n`);
  // A tool_call gate reserves the ONLY permitted child before execution, with no planner/builder/delegates.
  writeFileSync(join(workspace, "review-gate.ts"), reviewGateSource);
  const outputPath = join(dir, "review-result.json");
  const outcome = { originalFixture: from, outputPath, originalProcessComplete: fixture.review.process.accepted === true &&
    fixture.review.process.currentStage === "complete" && fixture.review.process.obligations.review.status === "satisfied",
    independentReviewerContractAccepted: false,
    hashProvenance: "recordedBaseline covers only original fixture files; snapshot is first-time capture for all other retained records", recordedBaseline: fixture.recordedBaseline,
    firstTimeSnapshot: fixture.snapshot, error: null };
  const save = () => { writeFileSync(`${outputPath}.tmp`, JSON.stringify(outcome, null, 2), { mode: 0o600 }); renameSync(`${outputPath}.tmp`, outputPath); };
  const diagnostic = createReviewDiagnostics(outcome, save);
  save();
  const env = { ...process.env, TMPDIR: join(dir, "runtime-tmp"), NODE_COMPILE_CACHE: join(dir, "node-compile-cache") };
  mkdirSync(env.TMPDIR); mkdirSync(env.NODE_COMPILE_CACHE);
  delete env.PI_OFFLINE; delete env.TYPESAFE_API_KEY; delete env.AGENT_HUB_TASK_TRIAGE_FAKE; delete env.AGENT_HUB_TASK_TRIAGE_FAKE_RECORD;
  if (env.NODE_OPTIONS?.includes("system1-no-network")) delete env.NODE_OPTIONS;
  let child;
  try {
    // Verify again immediately before real spend; no Pi process exists on validation failure.
    fixture.verify();
    child = spawn(join(root, "node_modules/.bin/pi"), ["--mode", "rpc", "--no-session", "--no-extensions",
      "-e", join(root, ".pi/harnesses/damage-control-continue/index.ts"),
      "-e", join(root, ".pi/harnesses/ask-user-remote/index.ts"),
      "-e", join(root, ".pi/harnesses/agent-hub/index.ts"), "-e", join(workspace, "review-gate.ts"),
      "--solo", "--work-mode", "orchestrator", "--agent-team", "review-only", "--model", "openai-codex/gpt-6-luna"],
    { cwd: workspace, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", turns = 0, ended = false, reply, failPendingPrompt;
    const models = [], callbacks = new Map(), waiters = new Set();
    const kill = (signal, reason) => diagnostic.kill(reason, signal, () => {
      if (child.pid && !ended) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; } }
    });
    child.once("error", e => { diagnostic.spawnError(e); ended = true; failPendingPrompt?.(); for (const wake of waiters) wake(); });
    child.once("close", (code, signal) => { ended = true; outcome.shutdown = { code, signal }; diagnostic.exit(code, signal); failPendingPrompt?.(); for (const wake of waiters) wake(); });
    child.stdin.on("error", e => { diagnostic.failure(`Pi stdin error: ${e.message}`); failPendingPrompt?.(); });
    child.stderr.on("data", chunk => diagnostic.stderr(chunk));
    child.stderr.once("end", () => diagnostic.flushStderr());
    child.stdout.on("data", chunk => {
      buffer += String(chunk);
      for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (["agent_start", "agent_end", "message_end", "tool_execution_start", "tool_execution_end", "response", "error", "extension_ui_request"].includes(ev.type)) diagnostic.rpc(ev);
        if (ev.type === "agent_end") { turns++; for (const wake of waiters) wake(); }
        if (ev.type === "message_end" && ev.message?.role === "assistant") models.push({ provider: ev.message.provider, model: ev.message.model, output: ev.message.usage?.output });
        if (ev.type === "response" && callbacks.has(ev.id)) { callbacks.get(ev.id)(ev); callbacks.delete(ev.id); }
        if (ev.type === "extension_ui_request" && !BENIGN_UI_METHODS.has(ev.method))
          kill("SIGTERM", `unexpected human decision (${["select", "confirm", "input", "editor"].includes(ev.method) ? ev.method : "unknown"}); no budget extension authorized`);
        if (ev.type === "error") diagnostic.failure(`Pi RPC error: ${ev.error ?? "unknown"}`);
      }
    });
    const prompt = async message => {
      const prior = turns, id = `independent-${prior}`;
      reply = await new Promise((resolve, reject) => {
        const finish = (error, ev) => { clearTimeout(timer); callbacks.delete(id); failPendingPrompt = undefined; error ? reject(error) : resolve(ev); };
        const timer = setTimeout(() => { kill("SIGTERM", "Pi RPC timeout"); finish(new Error("Pi RPC timeout")); }, 600_000);
        failPendingPrompt = () => finish(new Error(outcome.diagnostics.firstFailure?.reason ?? "Pi exited before RPC prompt response"));
        callbacks.set(id, ev => finish(null, ev));
        child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
      });
      if (!reply.success) { diagnostic.failure(`Pi prompt failed: ${reply.error ?? "unknown"}`); throw new Error("Pi prompt failed"); }
      if (turns <= prior) await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(wake); kill("SIGTERM", "Pi agent_end timeout"); reject(new Error("Pi agent_end timeout")); }, 600_000);
        const wake = () => { if (turns <= prior && !ended) return; clearTimeout(timer); waiters.delete(wake); ended && turns <= prior ? reject(new Error(outcome.diagnostics.firstFailure?.reason ?? "Pi exited before agent_end")) : resolve(); };
        waiters.add(wake); wake();
      });
      if (outcome.diagnostics.firstFailure) throw new Error(outcome.diagnostics.firstFailure.reason);
    };
    const template = reviewReturnTemplate({ planReturnPath: fixture.plan.returnPath, before: fixture.before, after: fixture.after,
      afterDiff: fixture.afterDiff, acceptancePath: fixture.acceptancePath, checkPath: fixture.checkPath,
      check: fixture.check, exitCode: fixture.exitCode, inspectedRevision: fixture.inspectedRevision });
    await prompt(`Independent synthetic reviewer-contract continuation, not a replay of original process. Dispatch EXACTLY ONE native code-reviewer, pinned openai-codex/gpt-6-luna, backend native, scope ["README-SYNTH.md"], artifacts [] (EMPTY: the cited files are read-only paths in the task, NOT dispatch input artifacts), review_reason "human authorized independent reviewer-only continuation". No planner, builder, helpers or further children. Reviewer must read these ORIGINAL actual absolute evidence inputs: planner return ${fixture.plan.returnPath}, actual plan ${join(fixture.plan.returnPath, "../../plans/synthetic-readme-fix.md")}, README ${join(from, "worktree/README-SYNTH.md")}, before ${fixture.before}, after ${fixture.after}, original baseline diff ${fixture.result.baseline.diff}, before/after diff ${fixture.afterDiff}, baseline status ${fixture.result.baseline.statusPath}, original recorded fixture hashes ${fixture.result.baseline.manifest}, baseline bytes ${fixture.result.baseline.filesPath}, after status ${fixture.result.after.statusPath}, after-review status ${fixture.result.afterReview.statusPath}. Scope accounting: the preflight independently checks both complete recorded status files and refuses any entry outside the changed README or untracked artifacts under the EXACT original Hub session .pi/agent-sessions/sessions/${fixture.plan.resultPath.split('/dispatches/')[0].split('/').at(-1)}/; those session artifacts are generated evidence, not declared README source edits. Verify this distinction yourself from the status paths, baseline manifest and artifact paths; REJECT if any unrelated source edit or foreign-session entry exists. Builder acceptance ${fixture.acceptancePath}, builder check ${fixture.checkPath}, builder result ${fixture.build.resultPath}, original reviewer return ${fixture.review.returnPath}, original reviewer acceptance ${fixture.review.acceptancePath}. Examine plan, exact change and README scope, diff, builder A1/AF-MIN-CHANGE check and revision/readback. Earlier reviewer returns conflict: one abbreviated A1; another rejected by comparing the BEFORE SHA-256 to the digest required for the AFTER bytes. Read the synthetic-only adjudication note at ${join(root, ".pi/agent-sessions/sessions/52b6c78b-3f03-4417-9493-bb877381f8bb/artifacts/c2-reviewer-hash-adjudication.md")} as a contested finding, not proof: independently read the cited BEFORE and AFTER bytes and declared command, verify whether the exact one-token replacement yields the declared AFTER digest, and REJECT if it does not or other evidence is insufficient. Do not reuse either prior verdict as authority. Do NOT execute or propose repeating the verification command: readonly review of recorded execution. Start final reviewer return with canonical first-line VERDICT: APPROVE or VERDICT: REJECT; reject freely if unsupported. Structured keys changed_files, assertions_proven, assertions_unproven, assertions_failed, tests_run, open_risks, requires_user_decision. The reviewer return must place exactly one A1 bullet DIRECTLY UNDER assertions_proven: as '- A1: <your independently verified finding> — evidence: <six JSON-quoted source paths; declared command JSON-quoted; exit code; inspected revision JSON-quoted; your observation>'. Do not put A1 in bracket shorthand 'assertions_proven: [A1 — ...]' or put '- A1 — evidence:' after the structured keys: those are not parsed A1 evidence and will be rejected. The command must be cited, NOT run. Choose VERDICT: REJECT and assertions_unproven if the sources do not support approval. Following is an INSTRUCTIONAL TEMPLATE, NOT evidence; do not copy unverified findings, and never auto-fill missing evidence.\n${template}\nNo new reviewer file is expected from you: Hub retains actual return. Report what you observed, do not assert this changes original process state.`);
    fixture.verify();
    const sessions = join(workspace, ".pi/agent-sessions/sessions");
    const ids = existsSync(sessions) ? readdirSync(sessions) : [];
    if (ids.length !== 1) throw new Error(`expected one fresh session; found ${ids.length}`);
    const base = join(sessions, ids[0]), dispatches = join(base, "dispatches");
    const started = existsSync(dispatches) ? readdirSync(dispatches).filter(id => existsSync(join(dispatches, id, "request.json"))) : [];
    if (started.length !== 1) throw new Error(`only one reviewer may start; observed ${started.length} dispatches`);
    const id = started[0], request = JSON.parse(readFileSync(join(dispatches, id, "request.json"), "utf8"));
    if (request.agent !== "code-reviewer" || request.backendRequested !== "native" ||
      JSON.stringify(request.scope) !== '["README-SYNTH.md"]') throw new Error("non-reviewer/native/scope child started");
    const result = JSON.parse(readFileSync(join(dispatches, id, "result.json"), "utf8"));
    const acceptancePath = join(base, "artifacts/evidence", `code-reviewer-acceptance-${id}.md`);
    const returnPath = join(base, "artifacts/returns", `code-reviewer-${id}.md`);
    const acceptance = JSON.parse(readFileSync(acceptancePath, "utf8"));
    const identities = readFileSync(join(dispatches, id, "session.json"), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
      .filter(row => row.type === "message" && row.message?.role === "assistant").map(row => `${row.message.provider}/${row.message.model}`);
    if (result.exitCode !== 0 || !(result.billed > 0) || result.diagnostics?.modelFallback !== null ||
      !identities.length || identities.some(identity => identity !== "openai-codex/gpt-6-luna") ||
      !models.length || models.some(m => `${m.provider}/${m.model}` !== "openai-codex/gpt-6-luna") ||
      result.evidencePath !== join(dispatches, id, "result.json") ||
      !existsSync(returnPath) || result.toolEvents?.some(e => !["read", "grep", "find", "ls"].includes(e.toolName)))
      throw new Error("reviewer execution/model/readonly evidence not proven");
    const unmet = independentReviewUnmet(fixture, result.output, acceptance.structuredReturn);
    outcome.reviewer = { id, resultPath: result.evidencePath, acceptancePath, returnPath, billed: result.billed, identities, parentModels: models,
      verdict: result.output.split(/\r?\n/, 1)[0], contractUnmet: unmet };
    outcome.independentReviewerContractAccepted = unmet.length === 0;
    if (unmet.length) throw new Error(`independent reviewer closure unmet: ${unmet.join("; ")}; new output: ${outputPath}`);
  } catch (e) { diagnostic.failure(String(e.message ?? e)); outcome.error = outcome.diagnostics.firstFailure.reason; process.exitCode = 1; }
  finally {
    if (child) {
      child.stdin.end();
      await new Promise(resolve => {
        if (outcome.shutdown) return resolve();
        const done = () => { clearTimeout(grace); clearTimeout(bound); resolve(); };
        child.once("close", done);
        const grace = setTimeout(() => { killShutdown("SIGTERM", "shutdown grace elapsed"); }, 2000);
        const bound = setTimeout(() => { killShutdown("SIGKILL", "shutdown bound elapsed"); resolve(); }, 8000);
        function killShutdown(signal, reason) { diagnostic.kill(reason, signal, () => {
          try { process.kill(-child.pid, signal); } catch { /* already closed */ }
        }); }
      });
    }
    if (child && (outcome.shutdown?.code !== 0 || outcome.shutdown?.signal)) {
      diagnostic.failure(`fresh Pi session did not exit cleanly: ${JSON.stringify(outcome.shutdown)}`);
      outcome.error = outcome.diagnostics.firstFailure.reason;
      outcome.independentReviewerContractAccepted = false; process.exitCode = 1;
    }
    try { fixture.verify(); } catch (e) { diagnostic.failure(`original evidence changed: ${e.message}`); outcome.error = outcome.diagnostics.firstFailure.reason; outcome.independentReviewerContractAccepted = false; process.exitCode = 1; }
    diagnostic.flushStderr();
    save();
    console.log(JSON.stringify({ originalProcessComplete: outcome.originalProcessComplete, independentReviewerContractAccepted: outcome.independentReviewerContractAccepted,
      output: outputPath, error: outcome.error, reviewer: outcome.reviewer }));
  }
}
