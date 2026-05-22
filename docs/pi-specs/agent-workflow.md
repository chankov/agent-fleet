# Specification: The Chronicle (agent-workflow)

## 1. Overview
**The Chronicle** is a temporal orchestration extension for the Pi Coding Agent. It enables long-running, state-aware workflows that span multiple sessions and personas. Unlike traditional linear agents, The Chronicle manages a formal **State Machine** where each stage of a project is handled by a specialized agent persona, with the extension acting as a persistent "State Supervisor."

## 2. Core Architecture

### 2.1 The Supervisor Model
The Chronicle operates as a non-working supervisor that delegates tasks to worker agents.
- **The Ledger**: A persistent JSON file (`.pi/chronicle/sessions/<uuid>.json`) that tracks the project state, file snapshots, and transition history.
- **State Isolation**: Each state is executed by a fresh Pi sub-agent process with a specialized system prompt, preventing "persona leakage" and ensuring clean tool contexts.
- **Context Handover**: When transitioning, the Supervisor extracts a "Snapshot" (modified files, key discoveries, pending tasks) and injects it into the next agent's starting context.

### 2.2 Workflow Definition
Workflows are defined in JSON templates:
```json
{
  "name": "Feature Implementation",
  "states": {
    "planning": {
      "persona": "Software Architect",
      "next": ["implementation"],
      "requires_approval": true
    },
    "implementation": {
      "persona": "Senior Engineer",
      "next": ["verification", "planning"]
    }
  }
}
```

## 3. Key Mechanisms

### 3.1 Explicit Transitions
To ensure reliability, transitions are **explicit**. The agent must call a tool to signal completion:
- `workflow_transition(target_state, summary)`: Finalizes the current state, saves the snapshot, and triggers the supervisor to spawn the next agent.
- `workflow_update_snapshot(data)`: Allows agents to "checkpoint" critical findings (e.g., "The API port is 8081, not 8080") that must persist through the entire workflow.

### 3.2 Temporal Persistence
- **Checkpointing**: Every tool call and state change is logged to the Ledger.
- **Recovery**: If a session is interrupted (e.g., power loss, manual exit), the extension can resume exactly where it left off by reading the Ledger and re-priming the sub-agent.

### 3.3 TUI Integration (The Timeline)
A dedicated widget displays the project's journey:
- **Breadcrumbs**: `Planning [✓] -> Implementation [●] -> Verification [ ]`.
- **Metrics**: Displays cumulative token usage and time elapsed per state.
- **Diff View**: Shows which files have been modified since the start of the current state.

## 4. Operational Guardrails

### 4.1 Anti-Looping
If a workflow transitions between the same states more than 3 times (e.g., Planning -> Implementation -> Planning -> Implementation), the Supervisor forces a transition to a `human_intervention` state and blocks further automated moves.

### 4.2 Resource Budgeting
The Supervisor tracks the total cost and token consumption across all sub-agents. It can be configured with hard limits to prevent runaway costs in long-running workflows.

### 4.3 Cleanup
Each state can define a cleanup routine that the Supervisor executes (e.g., killing background processes) before the next agent is spawned.

## 5. Integration
The Chronicle integrates with:
- **agent-team**: To fetch specialized personas for specific states.
- **damage-control**: To enforce safety rules across all worker sub-agents spawned by the Supervisor.
