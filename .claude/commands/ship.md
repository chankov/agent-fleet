---
description: Run the pre-launch checklist via parallel fan-out to specialist personas, then synthesize a go/no-go decision
---

Invoke the agent-skills:shipping-and-launch skill.

`/ship` is a **fan-out orchestrator**. It runs three specialist personas in parallel against the current change, then merges their reports into a single go/no-go decision with a rollback plan. The personas operate independently — no shared state, no ordering — which is what makes parallel execution safe and useful here.

## Phase A — Parallel fan-out

Spawn the following sub-agents concurrently. Each should run in its own context and return a structured report:

1. **code-reviewer** — Run a five-axis review (correctness, readability, architecture, security, performance) on the staged changes or recent commits. Output the standard review template.
2. **security-auditor** — Run a vulnerability and threat-model pass. Check OWASP Top 10, secrets handling, auth/authz, dependency CVEs. Output the standard audit report.
3. **test-engineer** — Analyze test coverage for the change. Identify gaps in happy path, edge cases, error paths, and concurrency scenarios. Output the standard coverage analysis.

Do not run these sequentially. Do not let one persona call another. Each persona sees the same diff and produces its own perspective.

## Phase B — Merge in main context

Once all three reports are back, the main agent (not a sub-persona) synthesizes them:

1. **Code Quality** — Aggregate Critical/Important findings from `code-reviewer` and any failing tests, lint, or build output. Resolve duplicates between reviewers.
2. **Security** — Promote any Critical/High `security-auditor` findings to launch blockers. Cross-reference with `code-reviewer`'s security axis.
3. **Performance** — Pull from `code-reviewer`'s performance axis; cross-check Core Web Vitals if applicable.
4. **Accessibility** — Verify keyboard nav, screen reader support, contrast (not covered by the three personas — handle directly here, or invoke the accessibility checklist).
5. **Infrastructure** — Env vars, migrations, monitoring, feature flags. Verify directly.
6. **Documentation** — README, ADRs, changelog. Verify directly.

## Phase C — Decision and rollback

Produce a single output:

```markdown
## Ship Decision: GO | NO-GO

### Blockers (must fix before ship)
- [Source persona: Critical finding + file:line]

### Recommended fixes (should fix before ship)
- [Source persona: Important finding + file:line]

### Acknowledged risks (shipping anyway)
- [Risk + mitigation]

### Rollback plan
- Trigger conditions: [what signals would prompt rollback]
- Rollback procedure: [exact steps]
- Recovery time objective: [target]

### Specialist reports (full)
- [code-reviewer report]
- [security-auditor report]
- [test-engineer report]
```

## Rules

1. The three Phase A personas run in parallel — never sequentially.
2. Personas do not call each other. The main agent merges in Phase B.
3. The rollback plan is mandatory before any GO decision.
4. If any persona returns a Critical finding, the default verdict is NO-GO unless the user explicitly accepts the risk.
5. If the change is small enough that fan-out adds more overhead than value (e.g. a single typo fix), skip the fan-out and run a single review pass — `/ship` is designed for production-bound changes, not trivial edits.
