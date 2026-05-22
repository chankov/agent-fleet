# pi-pi

Meta-agent that builds pi agents.

> Ported from [`pi-vs-claude-code`](https://github.com/disler/pi-vs-claude-code) by [disler](https://github.com/disler) (MIT). See the [extension catalog](../../../docs/pi-extensions.md).

## What it does

A team of domain-specific research experts — extensions, themes, skills, settings, TUI —
operate **in parallel** to gather pi documentation and patterns. The primary agent
synthesises their findings and is the only writer; the experts are read-only researchers.
Each expert fetches fresh pi documentation via Firecrawl on its first query.

Use it to scaffold new pi extensions, themes, skills, or agent definitions grounded in
current pi docs.

## Commands & tools

- `/experts` — list the available experts and their status
- `/experts-grid N` — set the dashboard column count (default 3)

## Requires

- `.pi/agents/pi-pi/*.md` — the expert persona definitions (shipped in this repo)
- `FIRECRAWL_API_KEY` — environment variable; experts use Firecrawl to crawl pi docs

## Usage

```bash
export FIRECRAWL_API_KEY=fc-...
pi -e .pi/harnesses/pi-pi/index.ts
```

## Upstream changes

- Theme integration removed — the `themeMap.ts` import and the `applyExtensionDefaults()`
  call were stripped (this repo does not ship pi themes). Note: pi-pi still has a
  `theme-expert` research persona — that is unrelated to the stripped UI theming and is
  about *researching* how pi themes are authored.
