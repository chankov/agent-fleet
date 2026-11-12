---
"@chankov/agent-fleet": patch
---

The operator's own edits can now be verified in a workspace whose root is a plain folder holding nested repositories (for example `rin-docs/` and `ringithub/`). `dispatch_agent` with `review_mode: operator-current-state` refused every such workspace with `operator_state_scope_unavailable`, so a high-risk task with operator edits there had no way to close its review obligation. It now observes each declared file in its own nested repository, as change attribution already does; the reviewer is still native, each file must be a changed exact file, and a file outside any observed repository still refuses the whole request. When `update_assertion` is refused because review is open, the message now says how to close it: this native current-state review for edits the operator made, or a `dispatch_agent` review of the registered changes, and that a reply to a raw `coms_send` is not a review record.
