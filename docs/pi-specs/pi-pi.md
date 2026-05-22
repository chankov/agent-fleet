# Pi Pi — Meta Agent Spec

## Purpose

A Pi extension that builds Pi agents. The "Pi Pi" agent is a meta-agent — it knows how to create extensions, themes, skills, settings, prompt templates, and TUI components by querying a team of domain-specific research agents in parallel.

## Architecture

```
User Request: "Build me a Pi agent that does X"
        │
        ▼
┌──────────────────────────────────┐
│  Primary Agent ("Pi Pi")         │
│  Tools: read,write,edit,bash,    │
│         grep,find,ls,            │
│         query_expert             │
│  Role: WRITER — gathers info    │
│  from experts, then builds       │
└──────┬───────────────────────────┘
       │ query_expert (parallel)
       ├──────────────────────────┐──────────────────────┐──────────────────────┐──────────────────────┐
       ▼                         ▼                      ▼                      ▼                      ▼
┌─────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ ext-expert  │  │ theme-expert │  │ skill-expert │  │ config-expert│  │  tui-expert  │
│ Extensions  │  │ Themes       │  │ Skills       │  │ Settings     │  │  TUI/UI      │
│ Tools, cmds │  │ JSON format  │  │ SKILL.md     │  │ Providers    │  │  Components  │
│ Events, API │  │ Color tokens │  │ Frontmatter  │  │ Models       │  │  Rendering   │
│             │  │ Hot reload   │  │ Directories  │  │ Packages     │  │  Keyboard    │
│ read-only   │  │ read-only    │  │ read-only    │  │ read-only    │  │  read-only   │
└─────────────┘  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘
```

## Flow

1. User asks the primary Pi Pi agent to build something
2. Primary agent identifies which domains are relevant
3. Primary dispatches `query_expert` calls in PARALLEL to all relevant experts
4. Each expert:
   a. Uses `/skill:firecrawl` to scrape fresh Pi documentation for their domain
   b. Searches the local codebase for existing patterns and examples
   c. Returns structured research findings
5. Primary agent receives ALL expert responses
6. Primary agent synthesizes the information and WRITES the actual files

## Expert Agents

### ext-expert (Extensions)
- **Domain**: Pi extensions — custom tools, events, commands, shortcuts, flags, state management, custom rendering, overriding tools
- **Doc URL**: `https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/extensions.md`
- **Tools**: read,grep,find,ls,bash
- **First action**: Fetch fresh extensions.md via firecrawl

### theme-expert (Themes)
- **Domain**: Pi themes — JSON format, 51 color tokens, vars, hex/256-color values, hot reload
- **Doc URL**: `https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/themes.md`
- **Tools**: read,grep,find,ls,bash
- **First action**: Fetch fresh themes.md via firecrawl

### skill-expert (Skills)
- **Domain**: Pi skills — SKILL.md format, frontmatter, directories, validation, /skill:name commands
- **Doc URL**: `https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/skills.md`
- **Tools**: read,grep,find,ls,bash
- **First action**: Fetch fresh skills.md via firecrawl

### config-expert (Settings & Providers)
- **Domain**: Pi settings, providers, models, packages, keybindings — settings.json, models.json, packages, enabledModels
- **Doc URLs**: settings.md, providers.md, models.md, packages.md, keybindings.md
- **Tools**: read,grep,find,ls,bash
- **First action**: Fetch fresh settings.md + providers.md via firecrawl

### tui-expert (TUI Components)
- **Domain**: Pi TUI — Component interface, Text, Box, Container, Markdown, Image, keyboard input, custom components, overlays, theming, SelectList, SettingsList, BorderedLoader, widgets, footers, editors
- **Doc URL**: `https://raw.githubusercontent.com/badlogic/pi-mono/refs/heads/main/packages/coding-agent/docs/tui.md`
- **Tools**: read,grep,find,ls,bash
- **First action**: Fetch fresh tui.md via firecrawl

## Extension Structure

File: `extensions/pi-pi.ts`

### Differences from agent-team.ts

| Feature | agent-team | pi-pi |
|---------|-----------|-------|
| Primary tools | dispatch_agent ONLY | read,write,edit,bash,grep,find,ls + query_expert |
| Subagent tools | varies per agent | read,grep,find,ls,bash (read-only + bash for firecrawl) |
| Dispatch model | Sequential | Parallel (LLM calls query_expert N times) |
| Subagent sessions | Persistent | Ephemeral (--no-session) |
| System prompt | Generic dispatcher | Specialized meta-agent builder |
| First prompt | None | Each expert fetches fresh docs on first query |

### Tool: query_expert

```typescript
pi.registerTool({
  name: "query_expert",
  label: "Query Expert",
  description: "Query a domain expert for Pi documentation and patterns. Experts research in parallel. Use multiple query_expert calls in one response for parallel research.",
  parameters: Type.Object({
    expert: Type.String({ description: "Expert name: ext-expert, theme-expert, skill-expert, config-expert, tui-expert" }),
    question: Type.String({ description: "What to research — be specific about what you need to build" }),
  }),
})
```

### Widget

Grid of expert cards showing:
- Expert name and status (idle/researching/done/error)
- Current question being researched
- Elapsed time

### Justfile Entry

```just
ext-pi-pi:
    pi -e extensions/pi-pi.ts
```

## Agent Definition Files

Located in `.pi/agents/`:
- `ext-expert.md`
- `theme-expert.md`
- `skill-expert.md`
- `config-expert.md`
- `tui-expert.md`

Teams entry in `.pi/agents/teams.yaml`:
```yaml
pi-pi:
  - ext-expert
  - theme-expert
  - skill-expert
  - config-expert
  - tui-expert
```
