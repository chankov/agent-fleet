---
"@chankov/agent-fleet": patch
---

Add the opt-in advisory `ask_system1` consumer for the parent Agent Hub in operator and orchestrator modes. It batches `choice`, `predicate`, and `ordinal` questions through the existing System 1 service. Advice does not execute commands, grant permissions, change tiers, or close acceptance, assertion, plan, or review gates.

Enable it only in the shared human-owned `.ai/system1.json` v2 document under `consumers.agenticAsk`. The installed default is off. `recommended` and `advisory` both require explicit remote-data consent; a preserved consumer config cannot re-enable a disabled System 1 feature. `recommended` instructs the Hub to consult first for suitable bounded semantic judgments, including small tasks, without expanding file scope, output capture, or process authority. Start a new Hub session after changing the mode.

Source capture is explicit and fail-closed: selected repo paths and ranges, optional recorded Hub bash evidence only when `allowToolOutputs` is approved, and no file or output bodies in the tool result. Damage-control policy still governs local reads. Refusals, missing evidence, stale advice, and an exhausted session budget fall back to ordinary reading and research. Native workers and Hub-spawned peers do not inherit the tool.

The Fleet System 1 communication viewer can show an `agenticAsk` projection of status, counts, latency, and usage without question text or answer values. `npm run test:agentic` proves the engineering integration with fake answers and no network; it does not claim semantic accuracy or measured savings.
