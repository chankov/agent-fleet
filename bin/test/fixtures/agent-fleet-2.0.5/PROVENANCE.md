# Agent Fleet 2.0.5 installer fixture

Generated from the official npm artifact `@chankov/agent-fleet@2.0.5`:
`https://registry.npmjs.org/@chankov/agent-fleet/-/agent-fleet-2.0.5.tgz`.

Generation command (2026-03-12):

```sh
node package/bin/cli.js setup --workspace fixture --preset default --features none --yes
```

The checked-in `.ai/agent-fleet.json` and `.ai/agent-fleet-state.json` are the
unaltered installer outputs. The fixture intentionally stores installer metadata,
not the full 285-file payload; current setup therefore exercises historical-state
upgrade plus repair in an offline, disposable workspace.
