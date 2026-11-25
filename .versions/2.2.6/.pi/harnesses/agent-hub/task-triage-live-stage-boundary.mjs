// Test-only Pi tool_call gate for the isolated user-run stage-closure fixture.
// No Hub registration or production policy change: the harness alone advances the stage.
export const STAGE_ROLE = Object.freeze({ plan: "planner", build: "builder", review: "code-reviewer" });

export function createStageBoundary({ stage, record, planDeliverable }) {
  let current = null;
  let used = false;
  let denials = 0;
  return (event, ctx) => {
    if (event.toolName !== "dispatch_agent") return;
    let selected;
    try { selected = stage(); } catch { /* missing/unreadable authorization fails closed */ }
    if (selected !== current) {
      // Only the harness may advance the stage; a skipped/reversed stage never
      // authorizes a child. Start closed unless the initial stage is plan.
      if ((current === null && selected !== "plan") ||
        (current !== null && (!used ||
          (current === "plan" ? selected !== "build" : current === "build" ? selected !== "review" : true)))) selected = null;
      else { current = selected; used = false; denials = 0; }
    }
    const role = event.input?.agent;
    let requiredPlan;
    if (current === "plan") {
      try { requiredPlan = planDeliverable(); } catch { /* missing authorization fails closed */ }
    }
    const exactPlan = current !== "plan" ||
      (typeof requiredPlan === "string" && requiredPlan.startsWith("/") &&
        Array.isArray(event.input?.deliverables) && event.input.deliverables.length === 1 &&
        event.input.deliverables[0] === requiredPlan);
    const allowed = typeof event.toolCallId === "string" && !!event.toolCallId &&
      typeof role === "string" && role === STAGE_ROLE[current] && !used && exactPlan;
    if (allowed) used = true; // reserve synchronously BEFORE dispatch execution
    else denials++;
    try {
      record({ stage: current, role: typeof role === "string" ? role.slice(0, 80) : null,
        toolCallId: typeof event.toolCallId === "string" ? event.toolCallId.slice(0, 100) : null,
        decision: allowed ? "allowed" : "denied" });
    } catch {
      ctx.abort();
      return { block: true, reason: "Isolated live fixture dispatch trace unavailable; dispatch refused." };
    }
    if (allowed) return;
    // The first refusal is model-visible so the parent can report and finish.
    // A second refusal aborts this parent turn (never another child), bounding
    // repeated speculative tool calls without granting a budget continuation.
    if (denials >= 2) ctx.abort();
    return { block: true, reason: `Isolated live fixture: dispatch denied at stage ${current ?? "unavailable"}; expected ${STAGE_ROLE[current] ?? "no role"}, at most one child${current === "plan" ? ", with the exact authorized absolute plan deliverable" : ""}. Stop dispatching, finish this turn and wait for the harness evidence gate and next prompt.` };
  };
}
