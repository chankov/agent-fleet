---
"@chankov/agent-fleet": patch
---

Unify `ask_user` ownership across runtime modes. `ask-user-remote` now treats a settings-listed `pi-ask-user` entry as dormant under `--no-extensions`/`-ne` (so default `just fleet` still registers the wrapped tool), defers only when extension discovery can actually load the stock package, and resolves stock `pi-ask-user` from package-native, `.pi/npm`, harness runtime (`npm ci --prefix .pi/harnesses`), then global locations. Align root and harness dependencies on `pi-ask-user@^0.14.0`. `doctor`/`verify` emit a read-only `pi-package-ownership` advisory when package-native Agent Fleet skills/prompts overlap copied `skill:*`/`command:*` items.
