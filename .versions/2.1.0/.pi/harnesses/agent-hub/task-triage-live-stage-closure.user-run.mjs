// USER-RUN LIVE ONLY: node .pi/harnesses/agent-hub/task-triage-live-stage-closure.user-run.mjs --live
// Real provider spend. Never imported by offline tests or npm test.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewClosureUnmet, reviewReturnTemplate } from "./task-triage-review-contract.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--live") {
  console.error("LIVE MODEL SPEND: opt in explicitly with --live; this is not an offline test.");
  process.exitCode = 2;
} else {
  await run();
}

async function run() {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "t4-live-stage-closure-")); // retained, never delete evidence
  const worktree = join(dir, "worktree");
  const evidence = join(dir, "evidence");
  const runtimeTmp = join(dir, "runtime-tmp"), compileCache = join(dir, "node-compile-cache");
  for (const path of [evidence, runtimeTmp, compileCache, join(worktree, ".pi/agents/personas"), join(worktree, "skills/orchestration-verification")]) mkdirSync(path, { recursive: true });
  // Only the public skill instructions required by the synthetic personas; no repo source or secrets.
  cpSync(join(root, "skills/orchestration-verification/SKILL.md"), join(worktree, "skills/orchestration-verification/SKILL.md"));
  const model = "openai-codex/gpt-6-luna";
  const initial = "# Synthetic Widget (isolated test fixture)\n\nThe wdiget renders a greeting.\n\n## Steps\n\n1. Correct the typo.\n2. Keep every other byte unchanged.\n";
  const expected = initial.replace("wdiget renders", "widget renders");
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  const readme = join(worktree, "README-SYNTH.md");
  const before = join(evidence, "README-before.md"), after = join(evidence, "README-after.md");
  const beforeDiff = join(evidence, "README-before.git-diff.patch");
  const afterDiff = join(evidence, "README-before-after.git-diff.patch");
  writeFileSync(readme, initial);
  writeFileSync(before, initial);
  writeFileSync(join(worktree, ".pi/agents/teams.yaml"), "stage:\n  - planner\n  - builder\n  - code-reviewer\n");
  for (const [name, tools] of [["planner", "read,write,grep,find,ls"], ["builder", "read,edit,bash"], ["code-reviewer", "read,grep,find,ls"]]) {
    writeFileSync(join(worktree, `.pi/agents/personas/${name}.md`), `---\nname: ${name}\ndescription: Isolated synthetic ${name} for user-run T4 stage closure\ntools: ${tools}\nmodel: ${model}\ndelegate_depth: 0\n---\nWork only inside the isolated synthetic workspace. No delegation. Never read non-fixture repository data or credentials.\n${name === "planner" ? "For this synthetic task, write the plan to the absolute path declared in dispatch deliverables. Generic auto-handoff is separate and never substitutes for the explicit plan; cite the declared path in your return.\n" : name === "code-reviewer" ? "Start your final return with exactly one standalone line: VERDICT: APPROVE or VERDICT: REJECT. Never omit the colon or embed a verdict in prose.\n" : ""}`);
  }
  // Copy only this test gate into the synthetic fixture; it is not a Hub policy hook.
  cpSync(join(root, ".pi/harnesses/agent-hub/task-triage-live-stage-boundary.mjs"), join(worktree, "stage-boundary.mjs"));
  writeFileSync(join(worktree, "probe-hooks.ts"), `import { appendFileSync, readFileSync } from "node:fs";\nimport { createStageBoundary } from "./stage-boundary.mjs";\nexport default function (pi: any) {\n  for (const hook of ["session_start", "before_agent_start", "turn_end", "session_shutdown"]) pi.on(hook, () => appendFileSync(process.env.T4_LIVE_EVENTS!, JSON.stringify({hook, at: Date.now()}) + "\\n"));\n  let attempts = 0;\n  const gate = createStageBoundary({\n    stage: () => readFileSync(process.env.T4_LIVE_STAGE!, "utf8").trim(),\n    planDeliverable: () => readFileSync(process.env.T4_LIVE_PLAN!, "utf8").trim(),\n    record: (entry: any) => { if (++attempts <= 32) appendFileSync(process.env.T4_LIVE_DISPATCHES!, JSON.stringify(entry) + "\\n"); else if (attempts === 33) appendFileSync(process.env.T4_LIVE_DISPATCHES!, JSON.stringify({ truncated: true }) + "\\n"); },\n  });\n  pi.on("tool_call", (event: any, ctx: any) => gate(event, ctx));\n}\n`);
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "core.excludesFile=/dev/null", ...args], { cwd: worktree, encoding: "utf8" });
    if (result.error || ![0, 1].includes(result.status)) throw new Error(`synthetic git evidence failed: ${args.join(" ")} (${result.status})`);
    return result;
  };
  git("init", "-q");
  const fixtureFiles = ["README-SYNTH.md", "probe-hooks.ts", "stage-boundary.mjs", "skills/orchestration-verification/SKILL.md", ".pi/agents/teams.yaml",
    ...["planner", "builder", "code-reviewer"].map(name => `.pi/agents/personas/${name}.md`)];
  const baselineBytes = new Map(fixtureFiles.map(file => [file, readFileSync(join(worktree, file))]));
  git("add", "--", ...fixtureFiles);
  const commit = git("-c", "user.name=T4 Synthetic", "-c", "user.email=t4-synthetic@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "synthetic fixture baseline");
  const baselineStatus = git("status", "--short", "--untracked-files=all");
  const baselineDiff = git("diff", "--no-index", "--", "/dev/null", "README-SYNTH.md");
  if (commit.status !== 0 || baselineStatus.status !== 0 || baselineStatus.stdout !== "" || baselineDiff.status !== 1) throw new Error("baseline git capture failed");
  writeFileSync(beforeDiff, baselineDiff.stdout);
  const baselineStatusPath = join(evidence, "baseline-git-status.txt");
  const afterStatusPath = join(evidence, "after-git-status.txt");
  const reviewStatusPath = join(evidence, "after-review-git-status.txt");
  const baselineManifest = join(evidence, "baseline-fixture-sha256.json");
  const baselineFilesPath = join(evidence, "baseline-fixture-bytes.json");
  writeFileSync(baselineStatusPath, baselineStatus.stdout);
  writeFileSync(baselineFilesPath, JSON.stringify(Object.fromEntries([...baselineBytes].map(([file, bytes]) =>
    [file, bytes.toString("utf8")])), null, 2));
  writeFileSync(baselineManifest, JSON.stringify(Object.fromEntries([...baselineBytes].map(([file, bytes]) =>
    [file, createHash("sha256").update(bytes).digest("hex")])), null, 2));
  const check = `node -e 'const fs=require("node:fs"); const crypto=require("node:crypto"); const t=fs.readFileSync("README-SYNTH.md","utf8"); if (!t.includes("widget renders") || t.includes("wdiget") || t.split("\\n").length > 30 || crypto.createHash("sha256").update(t).digest("hex") !== "${expectedHash}") process.exit(1)'`;
  const assertion = { id: "A1", tag: "test", text: "Synthetic README-SYNTH.md equals the baseline with only 'wdiget renders' corrected to 'widget renders'; it stays under 30 lines.", source: "isolated T4 live fixture", reference: before, critical_conditions: ["exact expected bytes", "no unrelated changes", "runtime check exit 0 at inspected revision"], test_command: check };
  const contract = `A1 [test]: ${assertion.text} (source: ${assertion.source}). Explicit verification command: ${JSON.stringify(check)} (execute only through approved bash). Runtime acceptance and reviewer evidence are separate; neither a return path nor a bare claim proves semantic adequacy.`;
  const resultPath = join(dir, "result.json"), rpcLog = join(dir, "rpc.log"), events = join(dir, "events.ndjson");
  const stagePath = join(evidence, "authorized-stage.txt"), planPath = join(evidence, "authorized-plan.txt"), dispatchLog = join(evidence, "dispatch-attempts.ndjson");
  function authorize(stage) {
    const next = `${stagePath}.next`;
    writeFileSync(next, stage);
    renameSync(next, stagePath); // explicit harness-owned transition after each evidence gate
  }
  authorize("plan");
  const outcome = { fixture: dir, worktree, model, declaredCheck: check,
    baseline: { status: baselineStatus.stdout, statusPath: baselineStatusPath, manifest: baselineManifest,
      filesPath: baselineFilesPath, diff: beforeDiff, bytes: before }, stages: [], error: null };
  const save = () => {
    outcome.dispatchAttempts = existsSync(dispatchLog) ? readFileSync(dispatchLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
    writeFileSync(resultPath, JSON.stringify(outcome, null, 2));
  };
  save();
  const env = { ...process.env, TMPDIR: runtimeTmp, NODE_COMPILE_CACHE: compileCache, T4_LIVE_EVENTS: events,
    T4_LIVE_STAGE: stagePath, T4_LIVE_PLAN: planPath, T4_LIVE_DISPATCHES: dispatchLog };
  // Inherit normal configured Pi auth/catalog; no credential values are read into task text or logs.
  delete env.PI_OFFLINE;
  delete env.TYPESAFE_API_KEY;
  delete env.AGENT_HUB_TASK_TRIAGE_FAKE;
  delete env.AGENT_HUB_TASK_TRIAGE_FAKE_RECORD;
  if (env.NODE_OPTIONS?.includes("system1-no-network")) delete env.NODE_OPTIONS;
  const child = spawn(join(root, "node_modules/.bin/pi"), [
    "--mode", "rpc", "--no-session", "--no-extensions",
    "-e", join(root, ".pi/harnesses/damage-control-continue/index.ts"),
    "-e", join(root, ".pi/harnesses/ask-user-remote/index.ts"),
    "-e", join(root, ".pi/harnesses/agent-hub/index.ts"),
    "-e", join(worktree, "probe-hooks.ts"),
    "--solo", "--work-mode", "orchestrator", "--agent-team", "stage", "--model", model,
  ], { cwd: worktree, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let ended = false, exit, turns = 0, serial = 0, err = "", buffer = "";
  const pending = new Map(), waiters = new Set(), parentModels = [];
  const log = entry => appendFileSync(rpcLog, JSON.stringify(entry) + "\n");
  function kill(signal) { if (child.pid && !ended) { try { process.kill(-child.pid, signal); } catch (e) { if (e.code !== "ESRCH") throw e; } } }
  function stop(reason) {
    ended = true;
    for (const wake of waiters) wake();
    for (const cb of pending.values()) cb({ success: false, error: reason });
    pending.clear();
  }
  child.once("error", e => stop(`Pi spawn failed: ${e.message}`));
  child.once("close", (code, signal) => { exit = { code, signal }; stop(`Pi exited: ${code ?? signal}`); });
  child.stderr.on("data", c => { err += String(c); });
  child.stdout.on("data", c => {
    buffer += String(c);
    for (let nl; (nl = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "agent_end") { turns++; for (const wake of waiters) wake(); }
      if (ev.type === "message_end" && ev.message?.role === "assistant") {
        parentModels.push({ provider: ev.message.provider, model: ev.message.model, output: ev.message.usage?.output });
      }
      if (ev.type === "response" && pending.has(ev.id)) { const cb = pending.get(ev.id); pending.delete(ev.id); cb(ev); }
      if (ev.type === "extension_ui_request") {
        log({ type: "ui", method: ev.method, title: String(ev.title ?? "").slice(0, 300) });
        if (ev.method === "select") {
          // Never silently authorize an unexpected human decision or budget extension.
          const deny = ev.options?.find(o => /no|deny|cancel/i.test(o));
          if (!deny) { kill("SIGTERM"); continue; }
          child.stdin.write(JSON.stringify({ type: "extension_ui_response", id: ev.id, value: deny }) + "\n");
        }
      }
    }
  });
  async function request(message, command = false) {
    const previous = turns;
    const reply = await new Promise((resolve, reject) => {
      if (ended) return reject(new Error("Pi exited before request"));
      const id = `t4-live-${++serial}`;
      const timer = setTimeout(() => { pending.delete(id); kill("SIGTERM"); reject(new Error("Pi RPC timeout")); }, 600_000);
      pending.set(id, ev => { clearTimeout(timer); resolve(ev); });
      child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n");
    });
    if (!reply.success || command || turns > previous) return reply;
    await new Promise((resolve, reject) => {
      const wake = () => {
        if (turns <= previous && !ended) return;
        clearTimeout(timer); waiters.delete(wake);
        if (ended && turns <= previous) reject(new Error("Pi exited before agent_end")); else resolve();
      };
      const timer = setTimeout(() => { waiters.delete(wake); kill("SIGTERM"); reject(new Error("Pi agent_end timeout")); }, 600_000);
      waiters.add(wake); wake();
    });
    return reply;
  }
  function nonRuntimeStatus(status, sessionId) {
    const prefix = `?? .pi/agent-sessions/sessions/${sessionId}/`;
    return status.split("\n").filter(line => line && !line.startsWith(prefix)).join("\n");
  }
  function observedChildModel(sessionPath) {
    if (!existsSync(sessionPath)) return { status: "unavailable", reason: "retained child session missing" };
    let rows;
    try { rows = readFileSync(sessionPath, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch { return { status: "unavailable", reason: "retained child session unreadable" }; }
    const identities = rows.filter(row => row.type === "message" && row.message?.role === "assistant")
      .map(row => ({ provider: row.message.provider, model: row.message.model }));
    if (!identities.length || identities.some(m => typeof m.provider !== "string" || typeof m.model !== "string" || !m.provider || !m.model))
      return { status: "unavailable", reason: "no complete assistant model identity in retained session" };
    return { status: "observed", identities };
  }
  function snapshot(stage, role) {
    const sessionsRoot = join(worktree, ".pi/agent-sessions/sessions");
    const sessions = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
    if (sessions.length !== 1) throw new Error(`Expected one isolated session, got ${sessions.length}`);
    const base = join(sessionsRoot, sessions[0]);
    const dispatchRoot = join(base, "dispatches"), evidenceRoot = join(base, "artifacts/evidence");
    // Count started dispatches, including any still pending; never hide an extra
    // child just because its result has not been persisted yet.
    const dispatches = readdirSync(dispatchRoot).filter(id => existsSync(join(dispatchRoot, id, "request.json")));
    const matching = dispatches.filter(id => existsSync(join(dispatchRoot, id, "result.json")) &&
      existsSync(join(base, "artifacts/returns", `${role}-${id}.md`)))
      .map(id => ({ id, result: JSON.parse(readFileSync(join(dispatchRoot, id, "result.json"), "utf8")) }));
    if (matching.length !== 1 || dispatches.length !== outcome.stages.length + 1) {
      const observed = dispatches.map(id => {
        const request = join(dispatchRoot, id, "request.json");
        let agent = "unknown";
        try { agent = JSON.parse(readFileSync(request, "utf8")).agent ?? "unknown"; } catch { /* keep ID */ }
        return { agent, id };
      });
      throw new Error(`Expected exactly one ${role} child at ${stage}; saw ${dispatches.length} total: ${JSON.stringify(observed)}`);
    }
    const { id, result } = matching[0];
    if (result.exitCode !== 0 || !result.diagnostics || !Object.hasOwn(result.diagnostics, "modelFallback") ||
      result.diagnostics.modelFallback !== null || !(result.billed > 0))
      throw new Error(`${role} did not complete with a retained explicit no-fallback result`);
    // diagnostics.modelUsed is the requested spawn model, not an observed message identity.
    const childModel = observedChildModel(join(dispatchRoot, id, "session.json"));
    if (childModel.status === "observed" && childModel.identities.some(m => `${m.provider}/${m.model}` !== model))
      throw new Error(`${role} emitted a model other than ${model}`);
    const files = readdirSync(evidenceRoot).filter(f => f.startsWith(`${role}-acceptance-${id}`));
    if (files.length !== 1) throw new Error(`Missing unique runtime ${role} acceptance artifact`);
    const acceptancePath = join(evidenceRoot, files[0]);
    const acceptance = JSON.parse(readFileSync(acceptancePath, "utf8"));
    const canonicalResultPath = join(dispatchRoot, id, "result.json");
    if (result.evidencePath !== canonicalResultPath || !existsSync(result.evidencePath)) throw new Error(`Missing canonical retained ${role} dispatch result`);
    const item = { stage, role, id, resultPath: result.evidencePath, returnPath: join(base, "artifacts/returns", `${role}-${id}.md`), acceptancePath, process: acceptance.process, billed: result.billed, modelEvidence: { ...childModel,
      requested: result.diagnostics?.modelUsed ?? null, fallback: result.diagnostics?.modelFallback ?? null } };
    outcome.stages.push(item); save();
    return { ...item, result, acceptance };
  }
  const p1 = `SYNTHETIC isolated live task; no repository data or credentials. Call set_task_tier tier "small", risk "low", scope "wide" with reason "synthetic stage-closure fixture". Call the REAL set_assertions tool with ${JSON.stringify({ assertions: [assertion] })}. Do not dispatch any child yet; finish this turn so the harness can declare the absolute plan path in the runtime session. Never manually mark stages satisfied.`;
  const p2 = `Continue SAME task; the pre-builder test assertion must already be registered. Dispatch exactly one native builder pinned ${model}, backend "native", scope ["README-SYNTH.md"], deliverables ["README-SYNTH.md"]. Task: In the isolated synthetic fixture, read ${before} and README-SYNTH.md. Edit ONLY 'wdiget renders' to 'widget renders', preserving every other byte. After editing, run EXACTLY this declared command via normal approved bash, no wrapper: ${check}. Do not delegate, read repository files, or modify other files. ${contract} Report actual builder result and process obligations; never force pass.`;
  try {
    const one = await request(p1);
    if (!one.success) throw new Error("classification/assertion turn failed");
    const sessionsRoot = join(worktree, ".pi/agent-sessions/sessions");
    const planSessions = existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
    if (planSessions.length !== 1 ||
      (existsSync(join(sessionsRoot, planSessions[0], "dispatches")) &&
        readdirSync(join(sessionsRoot, planSessions[0], "dispatches")).some(id => existsSync(join(sessionsRoot, planSessions[0], "dispatches", id, "request.json")))))
      throw new Error("Expected one initialized session and no child before plan path declaration");
    const planArtifact = join(sessionsRoot, planSessions[0], "artifacts/plans/synthetic-readme-fix.md");
    writeFileSync(planPath, planArtifact); // boundary and task share this exact absolute path
    const pPlan = `Continue SAME synthetic task. Dispatch exactly one native planner pinned ${model}, backend "native", with deliverables ["${planArtifact}"]. Planner task: Read the synthetic README and public verification skill in this isolated worktree, write a short concrete typo-only plan using your write tool to the explicit absolute deliverable ${planArtifact}. This explicit plan artifact is distinct from the generic auto-handoff; do not substitute that auto-handoff for it. Return a matching plan for correcting ONLY 'wdiget renders' in README-SYNTH.md with this declared check: ${check}. The planner must not edit README or execute the check: report A1 and AF-MIN-CHANGE unproven at plan time; the builder will verify them. No other children or delegated helpers. Report the tool results; never manually mark stages satisfied.`;
    const planned = await request(pPlan);
    if (!planned.success) throw new Error("planner turn failed");
    const plan = snapshot("plan", "planner");
    if (plan.acceptance.process?.obligations?.plan?.status !== "satisfied" ||
      plan.acceptance.readback?.length !== 1 || plan.acceptance.readback[0].status !== "read" ||
      plan.acceptance.readback[0].changed !== true ||
      plan.acceptance.readback[0].path !== planArtifact ||
      plan.acceptance.compatibility?.hubAcceptanceStatus === "deliverable_failed" ||
      !existsSync(planArtifact) || !readFileSync(planArtifact, "utf8").trim())
      throw new Error(plan.acceptance.readback?.[0]?.status !== "read" || !existsSync(planArtifact)
        ? "real planner declared plan artifact was not read back"
        : plan.acceptance.process?.obligations?.plan?.status !== "satisfied"
          ? "real planner artifact read back, but plan-stage gate remained open"
          : "real planner artifact did not meet plan readback/change/content requirements");
    // Planner can write: attribute no off-target change to the builder.
    const planStatus = git("status", "--short", "--untracked-files=all");
    const planNonRuntimeStatus = nonRuntimeStatus(planStatus.stdout, readdirSync(join(worktree, ".pi/agent-sessions/sessions"))[0]);
    const planUnchangedFixture = [...baselineBytes].every(([file, bytes]) => readFileSync(join(worktree, file)).equals(bytes));
    outcome.afterPlan = { gitStatus: planStatus.stdout, nonRuntimeStatus: planNonRuntimeStatus,
      readmeUnchanged: readFileSync(readme, "utf8") === initial, unchangedFixture: planUnchangedFixture };
    save();
    if (planStatus.status !== 0 || planNonRuntimeStatus !== "" || !outcome.afterPlan.readmeUnchanged || !planUnchangedFixture)
      throw new Error("planner changed README or non-runtime synthetic fixture before builder");
    authorize("build");
    const two = await request(p2);
    if (!two.success) throw new Error("builder turn failed");
    const build = snapshot("build", "builder");
    const actual = readFileSync(readme, "utf8");
    writeFileSync(after, actual);
    const diff = git("diff", "--no-index", "--", before, after);
    writeFileSync(afterDiff, diff.stdout);
    const status = git("status", "--short", "--untracked-files=all");
    writeFileSync(afterStatusPath, status.stdout);
    // The one runtime-owned session is the only worktree infrastructure exception.
    // Keep the full status: a new or changed file anywhere else must fail this gate.
    const sessions = readdirSync(join(worktree, ".pi/agent-sessions/sessions"));
    const sessionPrefix = sessions.length === 1 ? `?? .pi/agent-sessions/sessions/${sessions[0]}/` : null;
    const changedOutsideSession = sessionPrefix ? nonRuntimeStatus(status.stdout, sessions[0]) : status.stdout;
    const unchangedFixture = [...baselineBytes].every(([file, bytes]) =>
      file === "README-SYNTH.md" || readFileSync(join(worktree, file)).equals(bytes));
    outcome.after = { path: after, diffPath: afterDiff, gitStatus: status.stdout, statusPath: afterStatusPath,
      nonRuntimeStatus: changedOutsideSession, unchangedFixture, exactExpectedBytes: actual === expected };
    save();
    if (actual !== expected || diff.status !== 1 || status.status !== 0 || sessions.length !== 1 ||
      changedOutsideSession !== " M README-SYNTH.md" || !unchangedFixture) throw new Error("independent before/after bytes or git state failed");
    const req = build.acceptance.verification?.requirements ?? [];
    const checkEvidence = build.acceptance.verification?.checks?.[0];
    if (build.acceptance.process?.obligations?.acceptance?.status !== "satisfied" ||
      !["A1", "AF-MIN-CHANGE"].every(id => req.some(r => r.id === id && r.status === "passed")) ||
      checkEvidence?.command?.[0] !== check || checkEvidence?.exitCode !== 0 ||
      typeof checkEvidence?.inspectedRevision !== "string" || !checkEvidence.inspectedRevision ||
      checkEvidence.inspectedRevision !== build.acceptance.task?.revision?.after || !existsSync(checkEvidence?.evidenceRef ?? "")) {
      throw new Error("builder runtime acceptance/check/revision/readback incomplete; reviewer not dispatched");
    }
    // Every reviewer reference must be retained before the reviewer is dispatched.
    const reviewInputs = [plan.returnPath, readme, before, after, beforeDiff, afterDiff,
      baselineStatusPath, baselineManifest, baselineFilesPath, afterStatusPath,
      build.acceptancePath, checkEvidence.evidenceRef, build.resultPath];
    for (const path of reviewInputs) {
      if (typeof path !== "string" || !existsSync(path)) throw new Error(`Reviewer input unavailable before dispatch: ${path}`);
    }
    const reviewPaths = [plan.returnPath, before, after, afterDiff, build.acceptancePath, checkEvidence.evidenceRef];
    const returnTemplate = reviewReturnTemplate({ planReturnPath: plan.returnPath, before, after, afterDiff,
      acceptancePath: build.acceptancePath, checkPath: checkEvidence.evidenceRef, check,
      exitCode: checkEvidence.exitCode, inspectedRevision: checkEvidence.inspectedRevision });
    const p3 = `Continue SAME synthetic task. Dispatch exactly one native code-reviewer pinned ${model}, backend "native", scope ["README-SYNTH.md"], review_reason "Human explicitly requested independent synthetic wide-stage review despite docs-only lane". Task: Independently inspect the actual planner output ${plan.returnPath} for a relevant typo-only plan and acceptance criteria; README-SYNTH.md in ${worktree}, BEFORE ${before}, AFTER ${after}, baseline diff ${beforeDiff}, before/after diff ${afterDiff}, clean committed baseline git status ${baselineStatusPath}, baseline fixture hashes ${baselineManifest}, immutable baseline fixture bytes ${baselineFilesPath}, full after git status ${afterStatusPath}, builder runtime acceptance ${build.acceptancePath}, builder check ${checkEvidence.evidenceRef}, and builder native result at the absolute canonical dispatch evidence path ${build.resultPath} (dispatches/${build.id}/result.json, NOT under artifacts/evidence). These paths are available NOW; read them as written, without shortening or rebasing relative paths. The only excluded after-status entries are untracked files under the single runtime-owned .pi/agent-sessions/sessions/${sessions[0]}/; every other tracked or untracked path is checked. Check the exact byte-level one-token change, unchanged other fixture bytes, absence of unrelated changes outside that session, and the actual declared check, exit code, inspected revision and deliverable readback. ${contract} Start your final return with exactly one standalone line, VERDICT: APPROVE only if plan, content and verification are adequate, otherwise VERDICT: REJECT. Never omit the colon or embed a verdict in prose. Include the parseable structured return keys changed_files, assertions_proven, assertions_unproven, assertions_failed, tests_run, open_risks, requires_user_decision. REVIEW INSTRUCTIONS / TEMPLATE ONLY — this is NOT returned evidence and the harness never inserts it into your response. The production parser recognizes an A1 evidence field ONLY after the literal delimiter ' — evidence: ' inside an assertions_proven entry. A phrase such as 'source: builder runtime evidence' in the note or tests_run is NOT A1 evidence. If and only if you independently read and confirm every cited file and runtime field, you may write an actual return using the following shape, replacing the observation placeholder with your own findings and choosing the verdict; keep the A1 evidence on ONE physical bullet line, with the JSON-quoted command and paths copied exactly to preserve embedded quotes, escapes, commas or newlines. Do not copy an unverified A1 proven entry. If unsupported, choose VERDICT: REJECT and put A1 under assertions_unproven or assertions_failed with the reason, not assertions_proven. Approval is never required.\n${returnTemplate}\nYou are read-only: do not promise or cite a new review artifact you cannot create; the Hub retains your actual return under its returnPath. No bash, edits, delegation or forced stage updates. Report reviewer result, not a manufactured pass.`;
    authorize("review");
    const three = await request(p3);
    if (!three.success) throw new Error("reviewer turn failed");
    const review = snapshot("review", "code-reviewer");
    const reviewStatus = git("status", "--short", "--untracked-files=all");
    writeFileSync(reviewStatusPath, reviewStatus.stdout);
    const reviewNonRuntimeStatus = nonRuntimeStatus(reviewStatus.stdout, sessions[0]);
    const reviewUnchangedFixture = [...baselineBytes].every(([file, bytes]) =>
      file === "README-SYNTH.md" ? readFileSync(readme).equals(Buffer.from(expected)) : readFileSync(join(worktree, file)).equals(bytes));
    outcome.afterReview = { gitStatus: reviewStatus.stdout, statusPath: reviewStatusPath,
      nonRuntimeStatus: reviewNonRuntimeStatus, unchangedFixture: reviewUnchangedFixture };
    if (reviewStatus.status !== 0 || reviewNonRuntimeStatus !== " M README-SYNTH.md" || !reviewUnchangedFixture)
      throw new Error("independent post-review bytes or git state failed");
    outcome.parentModels = parentModels;
    if (parentModels.length < 3 || parentModels.some(m => m.provider !== "openai-codex" || m.model !== "gpt-6-luna" || !(m.output > 0))) throw new Error("parent provider/message usage not exactly luna on every observed response");
    const reviewVerdict = review.result.output.split(/\r?\n/, 1)[0];
    const unmet = reviewClosureUnmet({ process: review.acceptance.process, verdict: reviewVerdict,
      parsed: review.acceptance.structuredReturn, requiredPaths: reviewPaths,
      check, exitCode: checkEvidence.exitCode, inspectedRevision: checkEvidence.inspectedRevision });
    if (unmet.length) throw new Error(`review closure unmet: ${unmet.join("; ")}`);
    outcome.closed = true;
  } catch (e) {
    outcome.error = String(e?.message ?? e);
    process.exitCode = 1;
  } finally {
    outcome.turns = turns;
    outcome.parentModels = parentModels;
    outcome.stderrTail = err.slice(-2000);
    save();
    child.stdin.end();
    await new Promise(resolve => {
      if (ended) return resolve();
      const done = () => { clearTimeout(grace); clearTimeout(bound); resolve(); };
      child.once("close", done);
      const grace = setTimeout(() => kill("SIGTERM"), 2000);
      const bound = setTimeout(() => { kill("SIGKILL"); resolve(); }, 8000);
    });
    outcome.shutdown = exit; save();
    if (exit?.code !== 0 || exit?.signal) process.exitCode = 1;
    console.log(JSON.stringify({ fixture: dir, result: resultPath, closed: !!outcome.closed, error: outcome.error, stages: outcome.stages.map(s => ({ role: s.role, process: s.process?.currentStage, modelEvidence: s.modelEvidence })) }));
  }
}
