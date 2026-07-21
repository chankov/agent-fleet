# Specification: Damage-Control Continue Extension

## 1. Overview
**Damage-Control Continue** is a safety and observability extension for the Pi Coding Agent. It enforces security patterns and "Rules of Engagement" by auditing tool calls in real-time. It intercepts potentially dangerous operations and enforces path-based access controls.

## 2. Core Architecture
- **Rule Engine**: Loads `.pi/damage-control-rules.yaml` on `session_start`. If missing, it defaults to an empty rule set.
- **Interception Hook**: Uses `pi.on("tool_call", handler)` to evaluate every tool call before execution.
- **Path Resolver**: Utility to expand tildes (`~`) and resolve relative paths against the current working directory (`cwd`) for accurate matching.

## 3. Tool Interception Logic
The extension uses `isToolCallEventType(toolName, event)` for type-safe narrowing of events.

### A. Bash Tool (`bash`)
- **Input Field**: `event.input.command`.
- **Destructive Patterns**: Match `bashToolPatterns` regex against the raw command string.
- **Path Matching**: Best-effort heuristic. Match `zeroAccessPaths`, `readOnlyPaths`, and `noDeletePaths` as substrings/regex patterns within the command string.
- **Modification Detection**: Block any bash command referencing `readOnlyPaths` patterns to prevent redirects (`>`), in-place edits (`sed -i`), or moves/deletes.

### B. File Tools (`read`, `write`, `edit`, `grep`, `find`, `ls`)
- **Input Field**: `event.input.path`.
- **Default Path**: For `grep`, `find`, and `ls`, if `path` is undefined, treat it as `ctx.cwd` for matching.
- **Access Control**:
    - **Zero Access**: Block if path matches any `zeroAccessPaths` pattern.
    - **Grep Glob**: Check the `glob` field of `grep` (`event.input.glob`) against `zeroAccessPaths`.
    - **Read Only**: Block `write` or `edit` calls if path matches `readOnlyPaths`.
    - **No Delete**: Block `bash` calls involving `rm` or similar on `noDeletePaths`.

## 4. Intervention & UI
- **Status Indicator**: Use `ctx.ui.setStatus()` to show an indicator of active safety rules (e.g., "🛡️ Damage-Control Active: 142 Rules").
- **Violation Feedback**: When a violation is blocked or confirmed, update the status temporarily to show the last event (e.g., "⚠️ Last Violation: git reset --hard").
- **Blocking without aborting**: Return `{ block: true, reason: "Security Policy Violation: [Reason]" }`; do not call `ctx.abort()`. The operation fails closed while the agent remains able to report or safely adapt.
- **Protected-path approval**: Interactive path violations may be approved explicitly. Headless Agent Hub children escalate to the dispatcher and fail closed on denial, timeout, missing UI, or an unreachable endpoint. `noDeletePaths` offers only Deny or Allow once; other path categories may use scoped/session grants.
- **Non-exemptible commands**: `bashToolPatterns` never open an approval bypass.
- **User Confirmation (`ask: true`)**: Rules explicitly marked `ask` use `ctx.ui.confirm`; denial blocks without aborting the turn.
- **Notifications**: Use `ctx.ui.notify()` to alert the user when a rule is triggered.

## 5. Logging & Persistence
- Every interception (block or confirm) is logged using `pi.appendEntry("damage-control-log", { tool, input, rule, action })`. This ensures the security audit is part of the permanent session history.

## 6. Implementation Notes
- **Path Resolution**: Must match against both raw input (e.g., `src/main.ts`) and absolute resolved paths. Handle `ctx.cwd` fallback for optional paths.
- **Tilde Expansion**: Manually expand `~` to `process.env.HOME` or `os.homedir()`.
- **Graceful Fallback**: If YAML parsing fails, notify the user and continue with no active rules rather than crashing the extension.
