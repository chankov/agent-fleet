# Agent Fleet Philosophy

Status: project direction agreed with the maintainer on 2026-09-17.
This is the canonical statement of intent for Agent Fleet's development. It
records the methodology discussed with the maintainer; it is not a claim that
every existing runtime path already enforces these principles.

## Purpose

Agent Fleet makes software development a clear, transparent, verifiable process
over Pi Coding Agent. Its core value is a concrete engineering methodology:
planning, implementation, testing, review, and supervision follow explicit rules.
Specialist agents and parallel execution are means of carrying out that methodology.

The harness owns the process. Models contribute engineering judgment within it.
The amount of assistance adapts to the task and the model, while the standards
for correctness, evidence, permissions, and honest reporting remain consistent.

## Deterministic process, room for judgment

The target is deterministic control over required stages, ordering, prerequisites,
permitted transitions, recovery, and completion. Given the same recorded state,
policy, evidence, and authorized decisions, the harness should apply the same
transition rules. Model confidence or persuasive prose is not a substitute for
satisfying a gate.

Design, research, and implementation still require judgment and can produce
different solutions. Deterministic process does not mean deterministic model
output or guaranteed correctness. A model may propose a plan, classification,
or change of direction; the process determines how that proposal is validated
and accepted before dependent work proceeds.

## Proportionality is part of the methodology

Task scope and risk determine the appropriate process through documented rules.
A small, reversible correction can take a short path; a broad or consequential
change needs more planning, verification, and review. Short paths preserve the
applicable requirements and evidence without adding ceremony for its own sake.

The reason for choosing a path must be visible. A model's unsupported label of
"small" or "trivial" must not bypass required checks. When scope, risk, or facts
change, reclassification follows an explicit transition and records the reason.
Human decisions are requested where the governing policy requires them; routine
authorized work can continue within its established boundaries.

## One methodology, adaptive assistance

Models need clear instructions, understandable tool interfaces, structured
inputs and results, and an accurate view of current task and tool state.
They should not have to infer whether an action ran, an artifact exists, a
worker is busy, or a check passed from a narrative alone.

Capable models retain room to solve difficult problems and use the available
tools effectively. Additional assistance for models that struggle is explicitly
configurable: simpler operations, focused context, precise validation feedback,
and concrete permitted recovery steps. Assistance is selected through declared
capabilities and configuration, not assumed from provider names or model size.

Assistance must not weaken acceptance standards or silently constrain stronger
models. General correctness fixes apply to all models; additional support is
opt-in. Its purpose is to make existing abilities more usable, not to claim that
every model can perform every task. Capability limits and unsupported operations
remain visible. Model changes and fallback follow explicit policy and authorization.

## Evidence, recovery, and budgets

Requirements retain their source through planning, delegation, and compaction.
Completion is based on relevant evidence tied to the task and checked state.
Changed, verified, unverified, and failed work remain distinguishable. A successful
process exit, an existing file, or a model's declaration of success is insufficient
on its own. Concurrent or stale evidence retains its uncertainty.

Errors have distinct causes and permitted next steps. Busy workers, invalid input,
failed verification, protocol errors, resource failures, and operator cancellation
must not collapse into the same retry behavior. Recovery is bounded and responds
to changed conditions or authorized decisions; repeating equivalent attempts
must not consume the budget indefinitely. Cancellation is respected.

Tool-like text is data, not an executed action. Budget and permission changes
are explicit. The system should stop with an accurate explanation when progress
cannot be established, preserving the evidence needed for a human decision.

## Transparency and economical coordination

At any point, the operator should be able to understand the current stage, its
owner, why that path was selected, what has run, what is proven or missing, and
what permits the next step. Important decisions and transitions leave a trace;
observability must not expose secrets or private payloads unnecessarily.

Keep coordination context focused. Detailed research, outputs, and evidence can
live in artifacts with precise references and reliable readback. Summaries and
bounded outputs must not conceal truncation or make original evidence inaccessible.
Use deterministic operations for mechanical work and models for work requiring
judgment. Use multiple agents when independence, specialization, or useful review
justifies their cost; agent count is not a measure of success.

## Applying this philosophy to future work

Plans and design reviews for Agent Fleet must reference this document and state,
in proportion to the change:

- Which principles the change advances and which behavior already exists versus
  being proposed.
- Who owns process decisions, what inputs govern transitions, and what evidence
  permits completion or recovery.
- How the process scales with task scope and risk, and which model assistance is
  optional without weakening shared correctness standards.
- How outcomes will be verified, including compatibility, unnecessary overhead,
  false success, and avoidable human intervention where relevant.

Unaffected dimensions can be marked not applicable with a short reason. A small
change does not need a separate plan merely to repeat this document. Conflicts
with these principles must be made explicit and resolved with the maintainer;
individual plans must not silently redefine the project's philosophy.

Documentation and instruction entry points make this direction discoverable.
They do not, by themselves, enforce runtime behavior. Every claimed guarantee
needs an implemented mechanism and evidence. Changes to these principles belong
here, with their rationale, so future plans share one source of intent.

## Relationship to existing documentation

- [Architecture](ARCHITECTURE.md) describes the current runtime structure.
- [Deterministic workflows](workflows.md) describe the existing code-owned workflow layer.
- [Agent Hub](../.pi/harnesses/agent-hub/README.md) describes interactive orchestration.
- [Personas](agents.md) and [orchestration patterns](../references/orchestration-patterns.md)
  describe roles and composition.
- [Local-model reliability plan](plans/local-model-harness-reliability-plan.md)
  applies this direction to specific observed failures. Its pending decisions,
  opt-in boundaries, and exclusions remain in force; this philosophy does not
  authorize its implementation or add memory management to its scope.
