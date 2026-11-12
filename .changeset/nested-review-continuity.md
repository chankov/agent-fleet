---
"@chankov/agent-fleet": patch
---

A repeated review in a workspace whose root is a plain folder holding nested repositories can now be incremental. The Hub refused to keep a review baseline there, so every follow-up review re-read the whole scope. It now keeps the baseline with the HEAD of each declared nested repository: a later review gets the delta of the reviewed files, a new commit in any of those repositories forces a full review, and a declared path outside every repository still forces one.
