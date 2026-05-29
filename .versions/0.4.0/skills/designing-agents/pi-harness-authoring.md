# Authoring a pi Harness

Reference for the harness branch of the `designing-agents` skill. Read this before writing
any file under `.pi/harnesses/`. It is the harness equivalent of `docs/skill-anatomy.md`.

## What a harness is

A pi harness is a TypeScript pi extension that reshapes a whole session. The 15 in
`.pi/harnesses/` were ported from `disler/pi-vs-claude-code`; `docs/pi-extensions.md` is
their catalog. A harness can:

- replace the footer or status line — `minimal`, `tool-counter`
- gate every tool call and block or confirm it — `damage-control`, `tilldone`, `purpose-gate`
- register a new tool or `/command` — `tilldone`, `system-select`, `session-replay`
- inject text into the system prompt — `purpose-gate`, `system-select`
- orchestrate sub-agents — `agent-team`, `agent-chain`, `subagent-widget`, `pi-pi`
- add cross-agent messaging — `coms`, `coms-net`

### Harness vs. utility extension — where it lives

pi auto-discovers and loads **every** directory under `.pi/extensions/`. The three there
(`mcp-bridge`, `chrome-devtools-mcp`, `compact-and-continue`) are always-on utilities that
coexist. Harnesses are different: they are **mutually exclusive** — two that both replace
the footer fight, two that register the same CLI flag abort startup. So harnesses live in
`.pi/harnesses/`, which pi does **not** auto-discover, and load one (or two stacked) at a
time via `pi -e <path>`. Never put a harness under `.pi/extensions/`.

## Directory anatomy

Every harness is a directory with exactly three files:

```
.pi/harnesses/<name>/
  index.ts        # the extension
  package.json    # four fields, identical shape for every harness
  README.md       # the discovery surface
```

### package.json

Identical shape for every harness — only `name` changes:

```json
{
  "name": "agent-skills-pi-<name>",
  "private": true,
  "type": "module",
  "main": "index.ts"
}
```

Runtime dependencies are **not** declared here. Shared deps (`@sinclair/typebox`, `yaml`)
live in `.pi/harnesses/package.json` and are installed once by `just install`. The
`@mariozechner/pi-*` packages are provided by the pi runtime. If a harness needs a new
dependency, add it to `.pi/harnesses/package.json`, not the per-harness file.

## The ExtensionAPI surface

`index.ts` exports a default function that receives the `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // register handlers, tools, and commands here
}
```

Use only events and methods confirmed in an existing harness — a misspelled event name
fails silently. The list below is what the 15 ported harnesses use.

### Events — `pi.on(event, handler)`

Handlers are `async (event, ctx) => …`.

| Event | Fires when | The handler can |
|---|---|---|
| `session_start` | A session opens | Initialise state; set footer / widget / status; scan files |
| `session_switch` / `session_fork` / `session_tree` | The user navigates session history | Reconstruct state from `ctx.sessionManager` |
| `input` | The user submits a prompt | Return `{ action: "continue" }` or `{ action: "handled" }` to swallow it |
| `before_agent_start` | Just before the model runs | Return `{ systemPrompt }` to replace or extend the system prompt |
| `tool_call` | The agent calls any tool | Return `{ block: false }`, or `{ block: true, reason }` to gate it |
| `agent_end` | The agent finishes a turn | Nudge with `pi.sendMessage`; refresh UI |

### Registering tools and commands

- `pi.registerTool({ name, label, description, parameters, execute, renderCall, renderResult })`
  — `parameters` is a TypeBox schema (`import { Type } from "@sinclair/typebox"`). The
  `description` is read by the model, so write it the way you'd write a skill description.
  `execute` is `async (toolCallId, params, signal, onUpdate, ctx) => { content, details }`.
- `pi.registerCommand("name", { description, handler })` — adds a `/name` slash command;
  `handler` is `async (args, ctx) => …`.

### Other pi methods

- `pi.getActiveTools()` / `pi.setActiveTools(names)` — read or restrict the tool set
- `pi.sendMessage(msg, { triggerTurn })` — inject a message, optionally starting a turn
- `pi.appendEntry(type, data)` — write a custom entry into the session log

### The context object — `ctx`

- `ctx.cwd` — project root
- `ctx.model` — active model (`ctx.model?.id`)
- `ctx.getContextUsage()` — `{ percent }` context-window usage
- `ctx.getSystemPrompt()` — the current system prompt
- `ctx.sessionManager.getBranch()` — session entries, for state reconstruction
- `ctx.abort()` — abort the current turn
- `ctx.hasUI` — false in headless runs; guard UI-only commands with it
- `ctx.ui.setFooter(fn)` / `setWidget(id, fn, opts)` / `setStatus(text, id)` — UI surfaces
- `ctx.ui.notify(text, level)` — transient message (`info` | `warning` | `error` | `success`)
- `ctx.ui.confirm(title, body, opts)` — yes/no dialog
- `ctx.ui.select(title, options)` — pick-one dialog
- `ctx.ui.input(title, placeholder)` — text-input dialog
- `ctx.ui.custom(fn)` — full-screen overlay component

UI rendering uses `@mariozechner/pi-tui` helpers (`Text`, `Container`, `DynamicBorder`,
`truncateToWidth`, `visibleWidth`, `matchesKey`). Render against pi's active theme — do
not ship theme files (the ported harnesses had their theme code stripped).

## index.ts skeleton

The minimum viable harness — adapt to the chosen surface:

```ts
/**
 * <Name> — <one-line purpose>
 *
 * <2-3 lines on what it does and why.>
 *
 * Usage: pi -e .pi/harnesses/<name>/index.ts
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // initialise state, set UI surfaces
  });

  // add a tool_call gate / registerTool / registerCommand as the purpose requires
}
```

## Copy the closest existing harness

Do not write from scratch. Pick the nearest pattern and adapt it:

| If the harness… | Study | Approx. lines |
|---|---|---|
| Replaces the footer with status | `minimal` | 30 |
| Counts or summarises tool calls | `tool-counter`, `tool-counter-widget` | 70–100 |
| Gates the session on a precondition | `purpose-gate` | 80 |
| Blocks tool calls from a rules file | `damage-control` | 200 |
| Adds a `/command` that picks from files | `system-select` | 165 |
| Registers a tool + gate + multi-surface UI | `tilldone` | 720 |
| Orchestrates sub-agents | `agent-team`, `agent-chain`, `subagent-widget` | large |

Start from the smallest one that has the surface you need.

## README.md template

The README is the discovery surface — keep it to these sections, matching the others in
`.pi/harnesses/`:

```markdown
# <name>

<One-line subtitle.>

## What it does

<1-2 short paragraphs: the session surface it changes and why it is useful.>

## Commands & tools

<List each `/command` and registered tool — or "None — <surface> only.">

## Requires

<Files, env vars, or a sibling harness it stacks with. Omit the section if nothing.>

## Usage

\`\`\`bash
pi -e .pi/harnesses/<name>/index.ts
\`\`\`
```

A ported harness also carries an attribution blockquote and an "Upstream changes" section.
A **new** harness authored in this repo needs neither.

## Wiring — three edits beyond the directory

1. **`justfile`** — add a recipe under the matching `# -----` category header:
   ```
   # <Name>: <short description>
   ext-<name>:
       pi -e .pi/harnesses/<name>/index.ts
   ```
   If the harness has no footer of its own, stack `minimal`:
   `pi -e .pi/harnesses/<name>/index.ts -e .pi/harnesses/minimal/index.ts`.
2. **`docs/pi-extensions.md`** — add one row to the catalog table:
   `| [<name>](../.pi/harnesses/<name>/README.md) | <Category> | <what it does> | `just ext-<name>` |`.
   Categories in use: UI, Focus, Safety, Orchestration, Messaging.
3. **`.pi/harnesses/package.json`** — add any new runtime dependency (only if one is needed).

## Verify the harness runs

```bash
just install                          # only if a dependency was added
pi -e .pi/harnesses/<name>/index.ts    # launches without error
just ext-<name>                        # the recipe works
```
