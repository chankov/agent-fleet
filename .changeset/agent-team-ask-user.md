---
"@chankov/agent-skills": minor
---

**agent-team harness:** make the dispatcher a true orchestrator — gate
`pi-ask-user`'s `ask_user` into its tool surface, add configurable user-facing
language, and route specialist questions back through the dispatcher via an
`ASK_USER:` bubble-up protocol.

The primary (dispatcher) agent in `.pi/harnesses/agent-team/` is no longer
locked to `dispatch_agent` only. When the recommended companion package
[`pi-ask-user`](https://github.com/edlsh/pi-ask-user) is installed in the
global pi packages dir, the harness detects it at `session_start` via
`pi.getAllTools()` and adds `ask_user` to the dispatcher's `setActiveTools`
list. The system prompt then instructs the dispatcher to call `ask_user`
for clarification, decisions, contradictions, gaps, or destructive next steps.

When `pi-ask-user` is **not** installed, the harness warns the user to run
`pi install npm:pi-ask-user` and switches to a degraded prompt that requires
the dispatcher to state every assumption explicitly and wait for the user's
next turn before proceeding on anything destructive. No in-harness `ask_user`
is registered — doing so would conflict with `pi-ask-user` regardless of
load order, and pi's load-time API has no synchronous probe.

User-facing language is configurable per-project. Default: **English**.
Override under `## agent-team` → `language: <name>` in
`.ai/agent-skills-overrides.md`. Task strings sent to specialists always
stay in English regardless of the user-facing language — specialist personas
are written in English and perform as designed there.

A clarification protocol is auto-injected into every dispatched task:
specialists that need clarification emit `ASK_USER: <question>` lines and
stop. The dispatcher extracts these from the output (surfaced in result
`details.questions`) and surfaces each to the user (via `ask_user` when
available, verbatim relay otherwise), then re-dispatches with the answer.
Specialist personas need no changes to opt in. Specialists still run with
`--no-extensions` and cannot reach `ask_user` directly — by design, so the
dispatcher remains the single funnel for human interaction.

See [docs/agent-skills-setup.md](../docs/agent-skills-setup.md) for the
override schema.
