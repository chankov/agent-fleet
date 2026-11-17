---
"@chankov/agent-fleet": patch
---

Close interrupted hub recovery attempts as unsettled indeterminate failures on restore, releasing unrelated contracts while preserving retry fences and reporting real recovery identities.
