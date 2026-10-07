---
description: Install/status the Hermes liaison or turn its Telegram ask_user bridge on/off
argument-hint: "<install|status|on|off> [telegram-id] [--profile NAME] [--force] [--restart]"
---

Run the deterministic Agent Fleet controller with the arguments from `$ARGUMENTS`. Supported forms are:

```text
set-hermes-telegram install [--profile NAME] [--force] [--restart]
set-hermes-telegram status [--profile NAME]
set-hermes-telegram on <telegram-id[:topic-id]> [--profile NAME]
set-hermes-telegram off <telegram-id[:topic-id]> [--profile NAME]
```

Use `node bin/cli.js set-hermes-telegram ...` when the checkout-local CLI exists; otherwise use `npx --no-install agent-fleet set-hermes-telegram ...`. Pass parsed values as separately quoted shell arguments. If neither CLI exists, report that Agent Fleet must be installed or updated. Do not reproduce installation or Herdr lifecycle with ad-hoc commands, do not bypass a `--force` refusal, and do not send a test Telegram message. Return the controller output verbatim.
