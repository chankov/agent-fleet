---
"@chankov/agent-fleet": patch
---

Record a privacy-safe execution trace in the Pi session journal and expose it, together with tool-catalog change counts, in `/af-audit`. It correlates tool execution, policy decisions and human waits with hashed identities and no payloads, and writes one row per finished span (turn and child spans also record their start).

Damage-Control's Bash analysis classifies static operands to cut false positives while staying conservative for ambiguous syntax. Assignment-like arguments such as `dd if=~/.ssh/id_rsa` are treated as operands, and a subcommand word of an unknown program (`npm run build`, `cargo build`) is no longer mistaken for a protected `build/` or `target/` directory.
