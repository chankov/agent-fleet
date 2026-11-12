---
"@chankov/agent-fleet": patch
---

A Claude Code coms peer no longer answers a request with its previous reply. The Stop hook read the reply from Claude Code's transcript, which can still lack the turn's final message when the hook runs; it then handed the bridge the previous turn's text (or an interim "checking…" line) as the answer, so a review request could come back with the prior review's verdict. The hook now takes the reply from the `last_assistant_message` field Claude Code passes to Stop hooks. For older Claude Code versions without that field it waits briefly for the current turn's finished message in the transcript and otherwise writes nothing, instead of writing an earlier reply. Re-run `agent-fleet setup` to update the installed hook; no `.claude/settings.json` change is needed.
