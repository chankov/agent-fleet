---
"@chankov/agent-skills": patch
---

Fix the `bowser` browser-automation persona/skill so it actually resolves and document its external CLI dependency.

- **Naming fixed** — `agents/bowser.md` referenced a skill named `playwright-bowser`, but the runtime skill is `.pi/skills/bowser/` (`name: bowser`), so the persona's skill hook never resolved. The persona now references the `bowser` skill, and its workflow runs `playwright-cli` commands (not the non-existent `playwright-bowser` command). The `transform-persona.js` pi-only comment is updated to match.
- **External dependency documented** — the skill drives the external **Playwright Agent CLI** (`playwright-cli`), which is not bundled. `.pi/skills/bowser/SKILL.md` gains a Requirements section with the install commands (`npm install -g @playwright/cli@latest`) and a link to <https://playwright.dev/agent-cli/installation>; `docs/pi-extensions.md` notes the same.
- **Guided setup maintains it** — when the `bowser` runtime-skill is selected, `guided-workspace-setup` now checks for `playwright-cli` on PATH and offers the install (treated as an external dependency, like `pi-ask-user`), with matching Red Flag and Verification entries.
- **Broken link removed** — `SKILL.md` no longer points at a non-existent `docs/playwright-cli.md`; workflow step numbering corrected.
