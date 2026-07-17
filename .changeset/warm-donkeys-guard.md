---
"@chankov/agent-fleet": patch
---

Harden the ask-user-remote harness against a double-load of the stock `pi-ask-user` extension. When `npm:pi-ask-user` was also listed in pi settings `packages`, a load-order race could hard-crash the session (`Tool "ask_user" conflicts`) if the harness registered its wrapper first. The harness now runs a startup preflight over project (`.pi/settings.json`) and global (`~/.pi/agent/settings.json`) settings: if a `pi-ask-user` package entry is found, it warns and skips registering the wrapper so the stock package registers alone — the session survives regardless of load order (remote answer racing is disabled until the entry is removed). The repo's own `.pi/settings.json` no longer lists `npm:pi-ask-user`.
