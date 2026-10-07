// Offline-safe fixture preflight for the opt-in, user-run independent review.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { reviewClosureUnmet } from "./task-triage-review-contract.mjs";

// Executed as a fresh Pi extension in the isolated reviewer-only workspace.
// Tier declaration is preparation, not authorization: the Hub still applies its
// own classification, process and budget gates, and no other tool can run here.
export const reviewGateSource = `let used = false;
export default function (pi) {
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName === "set_task_tier") {
      const input = event.input;
      if (!used && input && (input.tier === "trivial" || input.tier === "small") &&
        (input.scope === undefined || input.scope === "read-only" || input.scope === "small") &&
        (input.risk === undefined || ["unknown", "low", "high"].includes(input.risk)) &&
        (input.new_task === undefined || input.new_task === false)) return;
      ctx.abort(); return { block: true, reason: "Reviewer-only tier preparation refused: no new task or post-dispatch reclassification." };
    }
    if (event.toolName === "set_assertions") {
      // Assertion declaration is preparation, not proof or authorization. The Hub
      // validates it; this fixture gate only prevents it after the sole review.
      if (!used) return;
      ctx.abort(); return { block: true, reason: "Reviewer-only assertions refused after dispatch." };
    }
    if (event.toolName === "dispatch_agent") {
      const input = event.input;
      const allowed = !used && input?.agent === "code-reviewer" && input?.backend === "native" &&
        JSON.stringify(input?.scope) === '["README-SYNTH.md"]' &&
        (input?.artifacts === undefined || (Array.isArray(input.artifacts) && input.artifacts.length === 0));
      if (allowed) { used = true; return; }
      ctx.abort(); return { block: true, reason: "Independent review only: one exact native reviewer; no other dispatch." };
    }
    ctx.abort(); return { block: true, reason: "Only tier/assertion preparation and the independent reviewer dispatch are authorized." };
  });
}
`;

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const must = (condition, message) => { if (!condition) throw new Error(message); };
export function reviewFixture(from) {
  must(isAbsolute(from) && /^t4-live-stage-closure-[\w-]+$/.test(basename(from)), "--from must name an absolute retained T4 live-stage fixture");
  must(realpathSync(from) === from && lstatSync(from).isDirectory(), "fixture directory must be real, not a link");
  const file = (path) => {
    must(isAbsolute(path) && (path === from || relative(from, path).startsWith("..") === false && !isAbsolute(relative(from, path))), `out-of-fixture evidence: ${path}`);
    const parts = relative(from, path).split(/[\\/]/);
    let cursor = from;
    for (const part of parts) {
      cursor = join(cursor, part);
      must(!lstatSync(cursor).isSymbolicLink(), `linked fixture evidence refused: ${cursor}`);
    }
    must(lstatSync(path).isFile(), `missing fixture evidence file: ${path}`);
    return path;
  };
  const json = path => JSON.parse(readFileSync(file(path), "utf8"));
  const resultPath = file(join(from, "result.json"));
  const result = json(resultPath);
  must(result.fixture === from && result.worktree === join(from, "worktree") && result.model === "openai-codex/gpt-6-luna", "result fixture/model mismatch");
  must(Array.isArray(result.stages) && result.stages.length === 3 &&
    result.stages.map(s => s.role).join(",") === "planner,builder,code-reviewer" &&
    result.stages.map(s => s.stage).join(",") === "plan,build,review", "not the retained three-stage fixture");
  must(result.stages.every(s => s.modelEvidence?.fallback === null && s.modelEvidence?.status === "observed" &&
    s.modelEvidence.identities?.length && s.modelEvidence.identities.every(m => `${m.provider}/${m.model}` === result.model)), "original stage model evidence incomplete");
  must(typeof result.error === "string" && result.error.startsWith("review closure unmet: parsed A1 evidence missing references:") &&
    result.error.includes("parsed A1 evidence missing exact declared command") &&
    result.error.includes("parsed A1 evidence missing exit code") &&
    result.error.includes("parsed A1 evidence missing inspected revision"), "not the retained abbreviated-A1 reviewer fixture");
  must(result.after?.exactExpectedBytes === true && result.after?.unchangedFixture === true &&
    result.afterReview?.unchangedFixture === true && result.afterReview?.nonRuntimeStatus === " M README-SYNTH.md" &&
    result.stages[2].process?.accepted === true && result.stages[2].process?.currentStage === "complete" &&
    result.stages[2].process?.obligations?.review?.status === "satisfied", "original process or README scope not complete");
  const [plan, build, review] = result.stages;
  const session = join(from, "worktree/.pi/agent-sessions/sessions");
  // Derive the original session from the retained planner result path, then constrain every stage to it.
  const base = join(plan.resultPath, "../../..");
  must(relative(session, base) && !relative(session, base).includes("/") && !relative(session, base).startsWith(".."), "invalid original session");
  const expectedStage = (s, role) => {
    must(/^[0-9a-f-]{36}$/.test(s.id) && s.resultPath === join(base, "dispatches", s.id, "result.json") &&
      s.returnPath === join(base, "artifacts/returns", `${role}-${s.id}.md`) &&
      s.acceptancePath === join(base, "artifacts/evidence", `${role}-acceptance-${s.id}.md`), `invalid ${role} stage paths`);
    return [s.resultPath, s.returnPath, s.acceptancePath];
  };
  const paths = [resultPath, ...expectedStage(plan, "planner"), ...expectedStage(build, "builder"), ...expectedStage(review, "code-reviewer")];
  const before = join(from, "evidence/README-before.md"), after = join(from, "evidence/README-after.md");
  const afterDiff = join(from, "evidence/README-before-after.git-diff.patch");
  const manifest = result.baseline?.manifest, baselineBytes = result.baseline?.filesPath;
  must(manifest === join(from, "evidence/baseline-fixture-sha256.json") && baselineBytes === join(from, "evidence/baseline-fixture-bytes.json") &&
    result.baseline?.bytes === before && result.after?.path === after && result.after?.diffPath === afterDiff, "baseline/after paths inconsistent");
  paths.push(before, after, afterDiff, result.baseline.diff, result.baseline.statusPath, manifest, baselineBytes,
    result.after.statusPath, result.afterReview.statusPath, join(from, "worktree/README-SYNTH.md"), join(base, "artifacts/plans/synthetic-readme-fix.md"));
  const acceptance = json(build.acceptancePath), check = acceptance.verification?.checks?.[0];
  must(acceptance.task?.id && acceptance.task?.revision?.after && acceptance.task.revision.after === check?.inspectedRevision &&
    check?.taskId === acceptance.task.id && check?.exitCode === 0 && check?.command?.length === 1 &&
    check.command[0] === result.declaredCheck && acceptance.execution?.dispatchId === build.id &&
    acceptance.process?.obligations?.acceptance?.status === "satisfied" &&
    ["A1", "AF-MIN-CHANGE"].every(id => acceptance.verification.requirements.some(r => r.id === id && r.status === "passed" && r.taskId === acceptance.task.id && r.revision === check.inspectedRevision)), "builder task/revision/check evidence mismatch");
  must(typeof check.evidenceRef === "string" && check.evidenceRef.startsWith(join(base, "artifacts/evidence/builder-test-check-")), "check path outside original session");
  paths.push(check.evidenceRef);
  const checkRecord = json(check.evidenceRef), buildResult = json(build.resultPath);
  const priorReview = json(review.acceptancePath), priorResult = json(review.resultPath);
  must(priorReview.task?.id === acceptance.task.id && priorReview.task?.revision?.after === check.inspectedRevision &&
    priorResult.output?.split(/\r?\n/, 1)[0] === "VERDICT: APPROVE" &&
    priorReview.structuredReturn?.assertions_proven?.some(item => item.id === "A1") &&
    priorReview.process?.accepted === true, "original reviewer task/revision/verdict mismatch");
  must(checkRecord.declaration?.taskId === acceptance.task.id && checkRecord.declaration?.dispatchId === build.id &&
    checkRecord.observation?.command === result.declaredCheck && checkRecord.observation?.exitCode === 0 &&
    checkRecord.observation?.afterRevision === check.inspectedRevision &&
    buildResult.evidencePath === build.resultPath && buildResult.exitCode === 0, "builder check/result inconsistency");
  const hashes = json(manifest), originals = json(baselineBytes);
  const expectedKeys = ["README-SYNTH.md", "probe-hooks.ts", "stage-boundary.mjs", "skills/orchestration-verification/SKILL.md", ".pi/agents/teams.yaml", ".pi/agents/personas/planner.md", ".pi/agents/personas/builder.md", ".pi/agents/personas/code-reviewer.md"];
  must(Object.keys(hashes).sort().join() === expectedKeys.sort().join() && Object.keys(originals).sort().join() === expectedKeys.join(), "baseline fixture manifest coverage mismatch");
  for (const key of expectedKeys) {
    must(typeof hashes[key] === "string" && sha(Buffer.from(originals[key])) === hashes[key], `recorded baseline bytes mismatch: ${key}`);
    if (key !== "README-SYNTH.md") must(sha(readFileSync(file(join(from, "worktree", key)))) === hashes[key], `fixture changed: ${key}`);
  }
  const initial = readFileSync(file(before));
  must(sha(initial) === hashes["README-SYNTH.md"] && initial.equals(Buffer.from(originals["README-SYNTH.md"])), "baseline README mismatch");
  const expected = Buffer.from(initial.toString("utf8").replace("wdiget renders", "widget renders"));
  must(initial.toString("utf8").includes("wdiget renders") && !expected.equals(initial) &&
    readFileSync(file(after)).equals(expected) && readFileSync(file(join(from, "worktree/README-SYNTH.md"))).equals(expected), "actual README bytes/scope mismatch");
  const readback = acceptance.readback?.[0];
  must(acceptance.readback.length === 1 && readback.path === join(from, "worktree/README-SYNTH.md") &&
    readback.status === "read" && readback.changed === true && readback.sha256 === sha(expected) &&
    readback.bytes === expected.length && acceptance.scopeRoots?.length === 1 &&
    acceptance.scopeRoots[0].scope === "README-SYNTH.md" && acceptance.scopeRoots[0].exists === true &&
    readback.retainedPath === join(base, "dispatches", build.id, "deliverables/0") &&
    readFileSync(file(readback.retainedPath)).equals(expected), "builder README scope/readback mismatch");
  paths.push(readback.retainedPath);
  must(readFileSync(file(afterDiff), "utf8").includes("-The wdiget renders a greeting.\n+The widget renders a greeting."), "before/after diff missing typo");
  must(readFileSync(file(result.baseline.statusPath), "utf8") === "" &&
    readFileSync(file(result.after.statusPath), "utf8") === result.after.gitStatus &&
    readFileSync(file(result.afterReview.statusPath), "utf8") === result.afterReview.gitStatus, "recorded status mismatch");
  // Only artifacts owned by the exact original Hub session are excluded from
  // source scope. Reject unrelated untracked paths, including other sessions.
  const sessionId = basename(base);
  const ownedPrefix = `?? .pi/agent-sessions/sessions/${sessionId}/`;
  const checkedStatus = status => status.split("\n").filter(Boolean).filter(line => !line.startsWith(ownedPrefix)).join("\n");
  must(checkedStatus(result.after.gitStatus) === " M README-SYNTH.md" &&
    checkedStatus(result.afterReview.gitStatus) === " M README-SYNTH.md" &&
    result.after.nonRuntimeStatus === " M README-SYNTH.md" &&
    result.afterReview.nonRuntimeStatus === " M README-SYNTH.md", "unrelated source or session changes in recorded status");
  const unique = [...new Set(paths)];
  // Only the eight fixture-file hashes above were recorded at creation; all other hashes are a first-time snapshot NOW.
  const snapshot = Object.fromEntries(unique.map(path => [file(path), sha(readFileSync(path))]));
  const verify = () => { for (const [path, hash] of Object.entries(snapshot)) must(sha(readFileSync(file(path))) === hash, `fixture evidence changed since first-time snapshot: ${path}`); };
  return { result, plan, build, review, before, after, afterDiff, acceptancePath: build.acceptancePath,
    checkPath: check.evidenceRef, check: result.declaredCheck, exitCode: 0, inspectedRevision: check.inspectedRevision,
    requiredPaths: [plan.returnPath, before, after, afterDiff, build.acceptancePath, check.evidenceRef], snapshot, recordedBaseline: hashes, verify };
}

// The original process is independently complete; new session acceptance never rewrites it.
export function independentReviewUnmet(fixture, output, parsed) {
  return reviewClosureUnmet({ process: fixture.review.process, verdict: output.split(/\r?\n/, 1)[0], parsed,
    requiredPaths: fixture.requiredPaths, check: fixture.check, exitCode: fixture.exitCode, inspectedRevision: fixture.inspectedRevision });
}
