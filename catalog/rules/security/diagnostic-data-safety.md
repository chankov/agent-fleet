---
fleet-template: diagnostic-data-safety
fleet-source-version: 1
---
# Rule: Safe diagnostic evidence

Load when collecting or sharing logs, screenshots, diagnostic responses, reports, or fixtures.

Disposition: retain minimal non-secret collection; exclude provider commands, environments, and credential mappings.

## Rules
- Collect only information necessary for the diagnostic question. Prefer synthetic fixtures and non-sensitive metadata.
- Avoid secret-returning endpoints; output redaction alone does not prevent secrets from entering tool results or intermediate artifacts. If safe collection is unavailable, stop and request a safer evidence source.
- Keep credentials, tokens, connection strings, personal data, and sensitive URL parameters out of reports, screenshots, logs, and committed fixtures. Inspect artifacts before sharing or committing them.
- Use the target's approved secret-handling mechanism without displaying values. Do not copy raw responses into durable evidence by default.
- If sensitive information is exposed, stop propagation and follow the target's incident process; redaction is not credential revocation.

## Scope and exceptions
Applies to diagnostic evidence, not authorization to access systems. Bind classification, storage, retention, and access rules to target policy; ask when unclear. Do not invent retention periods.

## Verification
Review collection endpoints and selected fields before execution, then inspect produced artifacts for sensitive content. Use existing scanners where available; a clean scanner result does not prove the absence of secrets.
