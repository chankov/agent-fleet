---
"@chankov/agent-fleet": patch
---

Fix protected-path false positives for literal absolute Python module invocations while retaining conservative checks for inline source, protected operands, and unsupported shell syntax. Preserve specific permission expiry/cancellation/staleness diagnostics without granting authority or retrying operations.

Explain missing exact runtime verification commands in native review results and require unchanged, separate, sequential verification calls. Chained commands such as `test; echo $?` remain ineligible evidence; exact fresh checks can register the reviewed current state without accepting pending manual requirements.

These changes update installable Damage Control and Agent Hub harness artifacts. Reconcile the workspace installation and reload the Pi harness before a separately authorized local verification attempt; no task reset, policy exemption, or automatic replay is required.
