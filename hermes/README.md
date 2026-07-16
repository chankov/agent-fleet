# Hermes artifacts

This directory contains in-repository Hermes skills for the coms Hermes bridge plan. They are source artifacts only; this pass does not modify `~/.hermes`.

## Skills

- `skills/hub-liaison/` — gateway-side Telegram liaison. It writes `~/.pi/coms/hermes-bridge/questions/<qid>.answer.json` answer files for `[HUB-Q:<qid>]` questions consumed by `scripts/coms-hermes-bridge.ts`.
- `skills/hub-conductor/` — dev-profile conductor. It uses `scripts/coms-cli.ts list` and `scripts/coms-cli.ts send --await --timeout` to delegate to live pi hub-team peers, while preserving the no-herdr damage-control boundary.

## Install

Install a skill into the desired Hermes profile with either option supported by your Hermes setup:

```bash
hermes skills install hermes/skills/hub-liaison
hermes skills install hermes/skills/hub-conductor
```

Or copy the skill directories into the profile's skills directory:

```bash
cp -R hermes/skills/hub-liaison ~/.hermes/<profile>/skills/
cp -R hermes/skills/hub-conductor ~/.hermes/<profile>/skills/
```

Use `hub-liaison` in the gateway-owning Telegram profile and `hub-conductor` in the human's dev/conductor profile. Verify availability with your normal Hermes skill listing command before relying on them.

## Usage notes

For `hub-liaison`, ensure the Telegram-capable profile has terminal/file-write tools enabled so it can create exactly `~/.pi/coms/hermes-bridge/questions/<qid>.answer.json` and nothing outside that questions directory.

For `hub-conductor`, either start the pi team/pool outside Hermes first, or use the repo recipe to create a visible conductor workspace:

```bash
just conductor docs      # conductor pane (`hermes -p dev`) + docs team panes
just conductor-dry docs  # dry-run layout, no herdr calls
```

Inside Hermes, discover and delegate only through coms:

```bash
node --experimental-strip-types /home/nchankov/repos/agent-skills/scripts/coms-cli.ts list
node --experimental-strip-types /home/nchankov/repos/agent-skills/scripts/coms-cli.ts send <peer> "<task>" --await --timeout 300000
```

Hermes must not drive herdr panes or workspaces; the `just conductor` recipe creates the pane before Hermes starts. The no-herdr boundary is documented in `docs/coms-hermes-bridge.md` and governed by `.pi/damage-control-rules.yaml`.
