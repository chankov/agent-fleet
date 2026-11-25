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
- **Protected-path approval**: Interactive path violations may be approved explicitly. Headless Agent Hub children escalate to the dispatcher and fail closed on denial, timeout, missing UI, or an unreachable endpoint. `noDeletePaths` offers only Allow once or Deny; other path categories may use scoped/session grants.
- **Non-exemptible commands**: `bashToolPatterns` do not support exemptions. Rules explicitly marked `ask: true` offer one-time approval or denial; other matches remain hard blocks.
- **Interactive default**: Local and dispatcher Damage-Control action selectors initially focus **Allow once**. Pressing Enter on that choice authorizes only the displayed request, even if a later request has identical inputs. Escape, timeout, or no reply never authorizes it. Existing approval deadlines are unchanged.
- **Notifications**: Use `ctx.ui.notify()` to alert the user when a rule is triggered.

## 5. Logging & Persistence
- Every interception (block or confirm) is logged using `pi.appendEntry("damage-control-log", { tool, input, rule, action })`. This ensures the security audit is part of the permanent session history.

## 6. Implementation Notes
- **Path Resolution**: Resolve tool paths against `ctx.cwd` (also the fallback for optional paths). For an absolute path inside that execution root, relative non-directory rules match its cwd-relative path, including nested names, not ancestors of `cwd`: `private/**` blocks `private/key` and `nested/private/key`, but not a public file merely because macOS placed the checkout under `/private/var`. Explicit absolute/home rules, paths outside the execution root, raw discovery globs, and trailing-slash directory rules retain full-path handling. Blocks and exemptions use the same matcher.
- **Tilde Expansion**: Manually expand `~` to `process.env.HOME` or `os.homedir()`.
- **Policy Failure**: Legacy mode retains its warning/fallback behavior. Targeted sessions fail closed for a missing, malformed, or changed workspace policy; they must not silently fall back to a global policy or no rules.
