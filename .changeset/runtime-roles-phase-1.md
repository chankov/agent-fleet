---
"@chankov/agent-fleet": patch
---

Agent Hub dispatches three runtime roles — `researcher`, `reviewer` and `editor` — and attaches practices from an eleven-entry catalog (research, architecture, planning, implementation, independent review, testing, security, performance, browser debugging, documentation, release) through a new `practices` parameter on `dispatch_agent` and `spawn_research`. A practice adds method, expected evidence and native-first skill paths to the assignment; it never adds authority.

- Retired persona names (`builder`, `code-reviewer`, `planner`, …) are refused before any start, with the role and practice mapping to use instead. Only the three role definitions are dispatched; a workspace file with a role's name may replace its prompt or model, but the code-owned ceiling still applies.
- A reviewer's active checks (`run-checks` and the current-state modes) keep the shell but always run inside the write-denying sandbox with an empty write allowlist; without the sandbox the dispatch is refused and directed to an editor.
- A read-only role reaches a coms peer only when the peer was launched with enforced read-only tools and declares `read_only` at registration (`just fleet peer <name> --read-only`); otherwise it falls back to native, or is refused under `fallback: none`. A read-only pi peer gets `read,grep,find,ls` only; a read-only Claude Code peer gets `Read,Grep,Glob` with MCP servers disabled. Neither can message other peers, and both still answer inbound requests.
- Review reuse and the no-progress retry fence now include the assignment's practices, so a security review never reuses a plain review and an editor with different practices is a new attempt.
- The shipped `model-profiles.yaml` lists the roles; `doctor` no longer rewrites `reviewer` as a legacy alias.
- Publishing (`git push`, `npm`/`pnpm`/`yarn`/`bun publish`, `changeset publish`, `gh release create|upload|edit`) now needs a one-call approval from the damage-control rules; the release practice prepares a release but never publishes on its own.
- The tier gate now weighs practices: architecture, and security on a reviewer, are refused at trivial and small tiers.
