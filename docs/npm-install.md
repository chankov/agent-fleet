# npm install path

The `@chankov/agent-skills` package ships every skill, persona, slash command,
and pi extension as installable content, plus a thin CLI that hands off to the
LLM-driven `guided-workspace-setup` skill. The CLI never writes installable
artifacts on its own — that decision (and the conversation around it) belongs
to the coding agent.

## Package name vs CLI name

| | Name |
|---|---|
| **npm package** (use this for `npm install` and the first `npx`) | `@chankov/agent-skills` |
| **CLI binary** (the command the package ships) | `agent-skills` |

The package is published under the `@chankov` npm scope to guarantee identity —
only [Nikolay Chankov](https://www.npmjs.com/~chankov) can publish to that
scope. The CLI binary stays the short name `agent-skills` because that's what
goes on `PATH` after install.

So:

- First time / one-shot: `npx @chankov/agent-skills <cmd>` — npx resolves the
  scoped package and runs its bin.
- After a project / global install: `npx agent-skills <cmd>` works too,
  because the bin is named `agent-skills`.

## Quick start

```bash
# In the workspace you want to configure:
npx @chankov/agent-skills init
# Then open your coding agent in this directory and run:
#   /setup
```

That's it. `npx` fetches the package, the CLI detects your coding agent and
prints the next-step command, and `/setup` runs the full guided install
inside your agent.

## Commands

### `npx @chankov/agent-skills init`

Materializes the package and hands off to `/setup`.

| Flag | Default | Purpose |
|------|---------|---------|
| `--agent <claude-code\|opencode\|pi>` | auto-detect | Skip the agent prompt |
| `--method <copy\|symlink>` | `copy` | Default install method passed to the skill |
| `--workspace <path>` | `cwd` | Target workspace |
| `--launch` | off | Shell into the coding agent after init (best effort) |

```bash
npx @chankov/agent-skills init --agent claude-code
npx @chankov/agent-skills init --workspace ~/projects/foo --method symlink
```

### `npx @chankov/agent-skills doctor`

Deterministic preflight scan — walks every install-target directory, lists
broken symlinks and stale persona references, and offers fixes. Same scan
that `/doctor` runs inside the agent.

| Flag | Default | Purpose |
|------|---------|---------|
| `--workspace <path>` | `cwd` | Target workspace |
| `--dry-run` | off | Show findings; do not apply |
| `--yes` / `-y` | off | Apply all suggested fixes without prompting |

```bash
npx @chankov/agent-skills doctor --workspace ~/projects/foo --dry-run
npx @chankov/agent-skills doctor -y
```

### `npx @chankov/agent-skills update`

Reads the workspace's `.ai/agent-skills-setup.md`, compares the recorded
package version against the installed package version, and prints the next
step. The actual diff-aware refresh runs inside the coding agent via
`/setup`.

```bash
# Upgrade the package itself first, then check the delta:
npm install -g @chankov/agent-skills@latest
npx agent-skills update --workspace .
# Then open your agent and run /setup to review per-artifact diffs.
```

## Versioning

The package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html):

| Change | Bump |
|---|---|
| Skill removed, renamed, or its documented workflow changes; persona retired; command removed; install-record schema breakage | **major** |
| New skill, new persona, new command, new option in an existing skill | **minor** |
| Wording fix, doctor scan improvement, CLI bug fix | **patch** |

### Pinning

To pin a workspace to a specific version, install the package as a project
dependency instead of using `npx`:

```bash
npm install --save-dev @chankov/agent-skills@1.4.2
npx agent-skills init   # resolves to the pinned 1.4.2
```

Or pin globally:

```bash
npm install -g @chankov/agent-skills@1.4.2
```

### What "update" actually changes

The package update is just `npm`'s usual upgrade. The interesting part runs
inside the agent: `guided-workspace-setup` reads the `version:` line from
`.ai/agent-skills-setup.md`, computes the delta against the current package
version, and surfaces per-artifact `Status` based on a three-way diff:

| Status | Means |
|---|---|
| `installed · upgrade available` | Source changed upstream; user copy still matches the old source → clean refresh |
| `installed · conflicting upgrade` | Source changed upstream AND user modified the copy → three-way diff shown, write requires explicit consent |
| `installed · removed upstream` | Artifact gone in the new version → proposed for deletion (subject to the removal-scope rule) |
| `not installed · new in this version` | New artifact added in the new version → offered, marked `★` if recommended |

The diff is sourced from `.versions/<recorded-version>/` inside the package —
a snapshot the release pipeline writes for every published version.

## Other install paths

npm is the recommended path for most users. The other two stay supported:

- **[Claude Code plugin marketplace](../README.md#quick-start)** — best UX
  inside Claude Code. Same skills, marketplace-managed updates.
- **Git clone + symlinks** — best for skill authors and contributors. Clone
  the repo, run `/setup` from there, choose `symlink` in Step 8. Updates
  flow through `git pull`. Symlinks need Developer Mode on Windows.

All three paths converge on the same `guided-workspace-setup` skill — the
difference is only in how the source files reach the workspace.

## CI usage

`npx @chankov/agent-skills init` is interactive by default (it prompts for
the agent when detection is ambiguous). For CI, pass `--agent` explicitly:

```bash
npx --yes @chankov/agent-skills@latest init --agent claude-code --method copy --workspace .
```

`doctor` accepts `--yes` for non-interactive repair. Note that the
LLM-driven `/setup` flow is not CI-runnable by design — confirmation gates
exist precisely so a human approves every write.

## Troubleshooting

- **"Could not auto-detect your coding agent."** Pass `--agent` or run
  `init` from a workspace that already has one of `.claude/`, `.opencode/`,
  or `.pi/`.
- **`update` says "no install record".** Run `init` once first; the install
  record is what `update` reads.
- **The version-aware menu shows `(snapshot missing)`.** The recorded version
  is older than the snapshot retention in this package. The skill falls back
  to "treat installed copy as canonical" — refresh manually if you want to
  reset the baseline.
