---
"@chankov/agent-fleet": patch
---

Add an experimental Linux Codex remote-control conductor: scoped and serialized `coms` delegation, a fail-closed conductor contract and wrapper rendered into an external user-state runtime workspace, typed Hermes/Codex team layouts, user-systemd lifecycle helpers, setup/package integration, and an operator runbook. This is intentionally a patch changeset to match the repository's forced-patch release policy.

**Pilot upgrade:** rerun `conductor-codex-reconfigure` before the next start so the owned configuration/unit and managed contract move to the external user-state runtime directory.

**Migration:** CLI spools now live at `~/.pi/coms/cli/projects/<project>/<name>/`. If an older name-only queue exists at `~/.pi/coms/cli/<name>/`, the CLI refuses queue operations until the operator stops that identity, inspects its pending/responses/inbound data, identifies the owning project, and moves the complete directory under the project-scoped path. Do not delete or merge ambiguous queues. The identity name `projects` is now reserved.
