---
"@chankov/agent-fleet": minor
---

Symlink installs are retired for ordinary workspaces — artifacts install as copies.

`--method symlink` is now accepted only when the target workspace **is** an agent-fleet checkout (its `package.json` names `@chankov/agent-fleet`) — the one place where editing an installed artifact is *meant* to edit the source. Everywhere else a symlink install is a trap: the link target can never move again, an npx cache clean breaks every link at once, a `git pull` in the source silently rewrites artifacts the workspace never agreed to change, and Windows needs Developer Mode. A copy plus `agent-fleet upgrade` gives the same freshness with a real three-way merge behind it.

- `--method` is gone from the help text of `init`, `install`, `upgrade`, and `update`. An explicit `--method symlink` outside a checkout is **refused** with an explanation, not silently downgraded — a flag you typed deserves an answer.
- **Existing symlink installs migrate automatically.** `verify` reports the workspace with a new advisory `symlink-retired` finding, and the next `install` or `upgrade` re-materialises every linked item as a real file and flips the recorded method to `copy`. Local edits are still preserved by `upgrade`'s merge; nothing is lost in the conversion.
- `guided-workspace-setup` and the three setup slash commands no longer ask copy-vs-symlink at all. There is no question left to ask.

Inside an agent-fleet checkout nothing changes: `--method symlink` still works, and that is the case the mode now exists for.
