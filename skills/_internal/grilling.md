# Grilling (Internal Helper)

Use this helper from a parent skill whenever a plan, spec, design, or
implementation must take a decision. Explicit invocation ("grill this",
"stress-test this") still triggers it; so does any unspecified fork. Do not
wait for the user to ask.

Interview until each **open** decision is explicitly accepted, rejected, or
deferred. Walk the design tree one dependency at a time: choose the next
question from prior answers, and skip questions made irrelevant by earlier
decisions.

## Do not re-ask what is already settled

Do **not** grill a point that is already explicit in any of:

- the current chat, user prompt, or spoken/written instruction
- a PRD, spec, plan, ticket, or other written requirement
- a project rule, skill, or standing instruction

Treat those as accepted. Re-asking wastes attention and implies the agent did
not read the source of truth.

## Must grill — unspecified forks

Grill every remaining point that is load-bearing and still open:

- **Multiple valid ways** — architecture, library, naming, scope cut, data
  model, error behavior, where two or more approaches would all work and the
  trade-off is preference-dependent
- **Doubt or contradiction** — sources disagree (chat vs code, spec vs tests,
  two rules, two existing implementations)
- **Code variants** — the codebase already has several patterns and one must
  be chosen for this change; propose one recommended option among them

If a question can be answered by reading the codebase, docs, tests, or runtime
evidence, investigate first and ask only about the remaining decision.

If grilling produces **zero** questions (everything load-bearing was already
settled), say so briefly and proceed. Do not invent questions to look thorough.

## How to ask

Ask one focused question at a time. Offer 2-4 concrete options plus your
recommended answer and a brief reason, then wait for the user's decision
before continuing. This should feel like guided architectural interrogation,
not a questionnaire dump.

## When it applies

Planning, spec writing, **and implementation** — whenever a decision must be
taken. A plan that silently picks a library, and an implementer that silently
picks among existing code patterns, are the same failure.

Keep grilling until shared understanding is strong enough to write or revise
the downstream artifact. Record each accepted, rejected, or deferred choice in
that artifact (Architecture Decisions, Boundaries, or the slice summary).
When review exposes gaps later, convert each gap into one targeted follow-up
question.
