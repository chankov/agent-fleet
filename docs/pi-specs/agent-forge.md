# Specification: Agent Forge (Evolutionary Tooling)

## 1. Overview
**Agent Forge** is an evolutionary extension for the Pi Coding Agent. It enables the agent to expand its own capabilities by dynamically generating, validating, and loading new TypeScript tools on demand. Instead of a static set of capabilities, Agent Forge turns the agent into a meta-developer that builds its own infrastructure.

## 2. Core Architecture

### 2.1 The Toolbox
All evolved tools are stored in the `extensions/` directory with a specific naming pattern:
- `extensions/forge-<name>.ts`: The executable TypeScript logic.
- `extensions/forge-<name>.json`: Metadata, including the tool's description and TypeBox parameters schema.
- `extensions/forge-registry.json`: A central manifest for fast tool discovery during the `before_agent_start` hook.

### 2.2 The Proxy Model
Unlike `agent-team` which spawns new processes, Agent Forge uses a **Hybrid Proxy Model**:
1. **Dynamic Loading**: Uses `jiti` (Pi's internal runtime) to load forged tools into the existing process.
2. **Context Sharing**: Forged tools have direct access to the `ExtensionAPI`, allowing them to interact with the UI, notify the user, and use the existing toolset (read/write/bash).
3. **Zero Overhead**: Execution is instantaneous as it happens within the same Node.js/Bun runtime.

## 3. Core Tools

### 3.1 `forge_tool`
- **Purpose**: Generates a new tool or updates an existing one.
- **Inputs**: `name`, `description`, `parametersSchema`, and `logic` (the TypeScript body).
- **Process**:
    1. Wraps `logic` in a standard tool template.
    2. Writes `.ts` and `.json` files to `extensions/`.
    3. **Pre-flight Check**: Attempts to load the tool via `jiti`. If it fails (syntax error), it reports the error to the agent for "Self-Healing".
    4. Updates `forge-registry.json`.

### 3.2 `use_forge_tool`
- **Purpose**: Executes a previously forged tool.
- **Process**:
    1. Resolves the tool from the registry.
    2. Dynamically imports the `.ts` file.
    3. Passes arguments to the tool's `execute` function.
    4. Handles runtime errors gracefully, offering to "debug" the tool if it crashes.

### 3.3 `list_forge`
- **Purpose**: Lists all available evolved tools and their descriptions.

## 4. Safety & Self-Healing
- **Sandboxing**: Forged tools are restricted to a "Core Library" of imports (fs, path, child_process, typebox).
- **Versioning**: Each `forge_tool` call creates a `.bak` of the previous version.
- **Self-Healing**: If `use_forge_tool` or `forge_tool`'s pre-flight check fails, the agent is provided with the stack trace and the source code to perform an immediate fix.

## 5. UI Integration
- **Forge Widget**: A dedicated dashboard element showing:
    - **Evolved Tools**: Count of active tools.
    - **Last Action**: "Forged 'sql-explorer' 2m ago" or "Executing 'log-parser'...".
    - **Health**: Indicator of any tools currently in a "broken" state.
- **Status Bar**: Displays the "Forge Tier" (based on number of successful tools).

## 6. Template Structure
Every forged tool follows this mandatory structure:
```typescript
import { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export const metadata = {
  name: "custom_tool",
  description: "...",
  parameters: Type.Object({ ... })
};

export async function execute(params: any, pi: ExtensionAPI, ctx: any) {
  // Logic goes here
}
```

## 7. Integration with Agent-Team
Agent Forge can act as a "specialist" within an `agent-team`. The "Engineer" agent in a team can use Agent Forge to build tools for the "Analyst" or "Builder" agents, creating a collaborative ecosystem of meta-programming.
