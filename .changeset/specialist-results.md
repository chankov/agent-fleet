---
"@chankov/agent-fleet": patch
---

Native specialists report through a validated `submit_result` tool with evidence file hashes; `details.taskAccepted` stays the runtime verdict. A model profile can opt into `assist.return-extraction` to recover a missing submission from the written report with the cheap read-only extraction pass. Fresh reviews receive the previous report and a bounded diff of the reviewed files.

The deterministic `filesystem` tool can page through large files with `offset`/`max_bytes` under the per-turn output limit; a file is hashed once per unchanged identity and line references are tracked incrementally, so paging a multi-GB log no longer blocks the Hub. Declared nested Git repositories are observed during dispatch, and incomplete observation is reported rather than accepted.
