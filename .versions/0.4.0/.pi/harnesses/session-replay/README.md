# session-replay

Scrollable timeline overlay of session history.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Adds a `/replay` overlay that renders the current session as a scrollable timeline of
user, assistant, and tool entries — each with timestamps and elapsed-time deltas. Useful
for reviewing what happened in a long session without scrolling the live transcript.

## Commands & tools

- `/replay` — open the timeline overlay
- Inside the overlay: `↑`/`↓` to move, `Enter` to expand an entry, `Esc` to close

## Usage

```bash
pi -e .pi/harnesses/session-replay/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes). The overlay renders against
  pi's active theme.
