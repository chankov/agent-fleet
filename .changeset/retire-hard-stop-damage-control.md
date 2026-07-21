---
"@chankov/agent-fleet": major
---

Retire the hard-stop `.pi/harnesses/damage-control/` artifact and `just ext-damage-control` recipe. `damage-control-continue` is now the only supported safety harness and guards the Agent Hub dispatcher, native specialists, research helpers, and nested delegates. Protected deletions require explicit one-call approval, inherently dangerous command patterns remain non-exemptible, and missing child safety fails closed. Guided setup removes only owned, unchanged legacy hard-stop installs and preserves user-modified or unowned copies.
