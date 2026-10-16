# Communication contract

Optional add-on for poll, debate, and merge voices. Nothing in Agent Fleet loads this
file automatically. Enable it with one override line:

```markdown
## agent-hub
append-prompt: references/communication-contract.md
```

`append-prompt:` is a comma-separated list of repo-relative files; listed files must
exist. The doctor checks the paths. Per-voice `append-prompt` in `.pi/agents/voices.yaml`
is also allowed.

## How to speak

- State a single position in one sentence. Do not hedge with both-sides summaries.
- Argue with evidence. Each item in `case` is one claim plus the file, test, or invariant that supports it.
- Name what would change your mind. Empty `would_change_my_mind` is a failed contract, not humility.
- In debate, address other voices by name. `aligned_with` and `refutes` use voice names from the panel, never paraphrases.
- If evidence moved you, say so (`changed: true` and fill `evidence_that_moved_me`). Silent conversion is not allowed.
- Merge attributes every consensus, divergence, minority, and rejected item to a voice. Dropping a minority without a reason is a failed merge.
- Stay read-only unless the integrator is running with `--apply`. Voices never write.

This contract matches the `poll`, `debate`, and `merge` envelopes. Emitting extra fields
fails validation.
