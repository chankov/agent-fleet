---
"@chankov/agent-fleet": patch
---

Rewrite the npm `description` and `keywords` for pi.dev package-catalog discoverability.

The catalog at https://pi.dev/packages indexes only a package's name, description,
keywords and author — README content is not indexed. The previous description
contained no form of "subagent", so the package was absent from the catalog's
most-contested query (`subagent` matches 359 packages, `subagents` 258). The new
description leads with subagent orchestration and stays inside npm's 255-character
cap.

`keywords` is rebuilt around terms the catalog can actually match, and gains
`pi-extension` and `prompts`. Those two are what the catalog uses to award the
EXTENSION and PROMPT type badges: the package ships both, but was badged `SKILL`
only and so never appeared under the catalog's `extension` type filter.
`pi-package` is retained — it is what lists the package in the gallery at all.

No runtime, install-record or artifact behaviour changes.
