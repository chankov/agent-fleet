# tool-counter

Rich two-line custom footer.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Replaces the pi footer with two information-dense lines:

- **Line 1** — model + context meter on the left; tokens in/out + cost on the right
- **Line 2** — cwd (and git branch) on the left; a per-tool call tally on the right

It accumulates token and cost figures by traversing the session branch, and updates the
branch display on `onBranchChange`.

## Commands & tools

None — footer only.

## Usage

```bash
pi -e .pi/harnesses/tool-counter/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes). The footer renders against pi's
  active theme.
