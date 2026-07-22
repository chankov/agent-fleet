# Authoring a pi Harness

Reference for the harness branch of the `designing-agents` skill. Read this before writing
any file under `.pi/harnesses/`. It is the harness equivalent of `docs/skill-anatomy.md`.

## What a harness is

A pi harness is a TypeScript pi extension that reshapes a whole session. The harnesses
in `.pi/harnesses/` were ported from `disler/pi-vs-claude-code`; `docs/pi-extensions.md`
is their catalog. A harness can:

- set status, widgets, or overlays — `agent-hub`, `damage-control-continue`
- gate every tool call and block or confirm it — `damage-control-continue`
- register a new tool or `/command` — `agent-hub`, `coms`
- inject text into the system prompt — `agent-hub`
- orchestrate sub-agents — `agent-hub`
- add cross-agent messaging — `agent-hub`, `coms`

### Harness vs. utility extension — where it lives

pi auto-discovers and loads **every** directory under `.pi/extensions/`. The three there
(`mcp-bridge`, `chrome-devtools-mcp`, `compact-and-continue`) are always-on utilities that
coexist. Harnesses are different: most are **mutually exclusive** — two that both replace
the footer fight, two that register the same CLI flag abort startup. So harnesses live in
`.pi/harnesses/`, which pi does **not** auto-discover, and load explicitly via `pi -e <path>`
or the `justfile`. The supported stack is `damage-control-continue` before `agent-hub`; never put a
harness under `.pi/extensions/`.

## Directory anatomy

Every harness has these three required baseline files:

```
.pi/harnesses/<name>/
  index.ts        # the extension
  package.json    # shared manifest fields; persistent-UI targets add a version stamp
  README.md       # the discovery surface
```

Persistent-UI targets may additionally include a local `version.ts` provenance reader beside
their adjacent stamped `package.json`; do not describe those target harnesses as having exactly
three files.

### package.json

Every harness manifest shares the same base shape (only `name` changes). Persistent-UI targets
add a root-derived `version` stamp:

```json
{
  "name": "agent-fleet-pi-<name>",
  "private": true,
  "type": "module",
  "main": "index.ts",
  "version": "<root package version>"
}
```

The root `package.json` is canonical; `bin/sync-harness-versions.js` synchronizes the adjacent
harness stamps. A persistent-UI harness may keep a local provenance reader beside that manifest
so a copied or symlinked directory resolves its adjacent stamp, not the launch cwd. This does
**not** make it dependency-free. Runtime dependencies remain in `.pi/harnesses/package.json` and
are installed once by `just install`; copied/symlinked target harnesses still need that full
harness dependency installation. The `@mariozechner/pi-*` packages are provided by the pi runtime.
If a harness needs a new dependency, add it to `.pi/harnesses/package.json`, not the per-harness
file.

## The ExtensionAPI surface

`index.ts` exports a default function that receives the `ExtensionAPI`:

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // register handlers, tools, and commands here
}
```

Use only events and methods confirmed in an existing harness — a misspelled event name
fails silently. The list below is what the ported harnesses use.

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
- `ctx.ui.setFooter(fn)` / `setWidget(id, fn, opts)` / `setStatus(key, text)` — UI surfaces.
  Use a stable, namespaced status key per concern. Stack-wide data such as the harness version
  uses one shared key so stacked harnesses deduplicate `v<version>`; mutable status (for example,
  Damage-Control activity or violations) uses its own key and must not overwrite that version.
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
| Blocks tool calls from a rules file | `damage-control-continue` | ~530 |
| Sets widgets/status or registers orchestration commands/tools | `agent-hub` | large |
| Orchestrates sub-agents | `agent-hub` | large |
| Adds local cross-agent messaging | `coms`, `agent-hub` | large |

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

<Files or env vars the harness needs. Omit the section if nothing.>

## Usage

\`\`\`bash
pi -e .pi/harnesses/<name>/index.ts
\`\`\`
```

A ported harness also carries an attribution blockquote and an "Upstream changes" section.
A **new** harness authored in this repo needs neither.

## Wiring — three edits beyond the directory

1. **`justfile`** — add a recipe under the matching `# -----` category header, **inside the `agent-fleet:harnesses` managed-region sentinels** (so guided-workspace-setup ships and refreshes it in target workspaces):
   ```
   # <Name>: <short description>
   ext-<name>:
       pi -e .pi/harnesses/<name>/index.ts
   ```
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
