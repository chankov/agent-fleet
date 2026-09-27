# Verify a setup: clean-session behavior and binding checks

Run after every apply, before reporting setup complete. Findings here are structural; they never certify semantic compliance of the prose — the reviewer still checks claims against evidence.

## Clean-session check

Start a fresh session (or a fresh prompt context) and confirm the configured policy loads for planning before any edit, without repeating any instruction from this setup conversation. A settings change takes effect in a new session, never the current one.

## Binding sweep

- Links: every reference in the new and touched `.ai/` files resolves to a real target file; no catalogue (`catalog/…`) path leaks into `.ai/`.
- Triggers: each new rule names the task intent that loads it; no empty rules block when the index is absent.
- Placeholders: no stale template markers, no invented paths, checks, or commands.
- Overrides: `agent-fleet configure --dry-run` repeats as a no-op (`write: false`); unknown sections, comments, and unrelated settings are intact.
- Adapters: each selected command has exactly one target-local slash adapter resolving its canonical `.ai/commands` source; agent prompts resolve by reference with no global registration and no automatic personas.
- Provenance: every applied file has a sidecar entry with origin, evidence, accepted decision, and `appliedHash`; current bytes match `appliedHash` (re-classify to confirm `unchanged`).

## Small later edits

Direct edits and compound-learning iterations are local modifications: the next setup classifies them as `local-edit`, preserves them, and reconciles explicitly. They never silently become template updates. See `apply-contract.md` for the classification actions.
