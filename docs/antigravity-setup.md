# Using agent-skills with Antigravity CLI (agy)

The `agent-skills` package can be installed as a native plugin in the Antigravity CLI (`agy`), giving the agent access to structured workflows, personas, and custom slash commands.

## Setup

### Option 1: Native Plugin Installation (Recommended)

Antigravity CLI has a first-class plugin system that registers skills, agents, and custom commands.

**Install from a local clone:**

1. Clone the repository:
   ```bash
   git clone https://github.com/addyosmani/agent-skills.git
   ```
2. Install the plugin using `agy`:
   ```bash
   agy plugin install /path/to/agent-skills
   ```

This will validate the plugin and install it into your global Antigravity configuration directory (`~/.gemini/antigravity-cli/plugins/agent-skills/`).

### Option 2: Import from Gemini CLI

If you have already installed `agent-skills` under your legacy Gemini CLI installation, you can import it directly:
```bash
agy plugin import gemini
```

Once installed, verify the active plugin:
```bash
agy plugin list
```

---

## Slash Commands

The plugin registers 7 custom slash commands that map to the development lifecycle:

| Command | What it does | Activated Skill |
|---------|--------------|-----------------|
| `/spec` | Write a structured spec before writing code | `spec-driven-development` |
| `/planning` | Break work into small, verifiable tasks | `planning-and-task-breakdown` |
| `/build` | Implement the next task incrementally | `incremental-implementation` |
| `/test` | Run TDD workflow — red, green, refactor | `test-driven-development` |
| `/review` | Five-axis code review | `code-review-and-quality` |
| `/code-simplify` | Reduce complexity without changing behavior | `code-simplification` |
| `/ship` | Pre-launch checklist via parallel persona fan-out | `shipping-and-launch` |

Each command automatically invokes the corresponding skill and guides the agent step-by-step.

> **Note:** Use `/planning` instead of `/plan` to avoid conflicts with Antigravity's internal plan-generation command.

---

## Skills & Discovery

Antigravity automatically discovers skills inside the plugin's `skills/` directory. 
* Antigravity matches user tasks and intents to relevant skills on-demand.
* If a task matches a skill, the agent will load the skill and prompt you for permission before executing.

---

## Verification & Validation

To validate that your local plugin is correctly structured and contains all skills, run:
```bash
agy plugin validate /path/to/agent-skills
```
