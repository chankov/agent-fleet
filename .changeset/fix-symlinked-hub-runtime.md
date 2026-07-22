---
"@chankov/agent-fleet": patch
---

Fix symlinked Agent Hub launches after package-only updates. The hub monitor runtime now ships atomically under the shared harness library, and `ask-user-remote` canonicalizes its own package path before loading the bundled `pi-ask-user` dependency.
