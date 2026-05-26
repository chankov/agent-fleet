# minimal

Model name + context meter in a compact footer.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

Replaces the pi footer with a single compact line showing the active model ID and a
10-block context usage meter — e.g. `claude-opus-4-7 [###-------] 30%`. Useful on its
own or stacked behind another extension as a lightweight status surface.

## Commands & tools

None — footer only.

## Usage

```bash
pi -e .pi/harnesses/minimal/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call in `session_start` were stripped (this repo does not ship pi themes). The footer
  now renders against pi's active theme.
