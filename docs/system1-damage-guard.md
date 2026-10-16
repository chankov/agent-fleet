# System 1 damage guard (D6)

D6 is an optional, off-by-default semantic layer over mandatory Damage-Control
baseline policy. Production wiring exists in the current worktree, with bounded
local evidence; **D6 is incomplete and unaccepted**. Independent review and final
testing were deferred, not waived. A1–A8, F12 packaging and F13 final acceptance
remain open. Reading this guide grants no activation, export or effect authority.

## Independent configuration and export scopes

The v2 [System 1 configuration](system1-config.md) has an independent
`consumers.damageGuard` section. Its mode is `off` or `active`; separate boolean
`remoteScopes.commands`, `remoteScopes.edits` and `remoteScopes.results` consent
to different payload classes. Missing scopes grant nothing. D6 has no
`remoteContextApproved` field and inherits no D8/D9/D10 consent.

This inert fragment describes the section under `consumers`, not an activation
or installation procedure:

```json
{"damageGuard":{"mode":"off","remoteScopes":{"commands":false,"edits":false,"results":false},"include":[]}}
```

`include` is an explicit repository-relative export scope, with `git:tracked`
as a supported selector example, not blanket filesystem approval or active
consent. Local access, source provenance, secret recognition and payload bounds
still apply. Unknown provenance, denied sources, secret-bearing or oversized
payloads are not silently truncated into exportable evidence. Diagnostics use
allowlisted numeric/enumerated metadata and hashed identities, not commands,
edit bodies, result text, arbitrary paths or raw provider extras.

Missing/off/invalid D6, root-off or unavailable-key configuration means no new
D6 inference; it does **not** remove durable denial, hold or recovery fences.
Invalid D6 configuration is isolated from other consumers. Configuration is a
session snapshot, not hot-reloaded consent.

## Policy, ownership and actual coverage

`damage-guard/v1` asks two independent choice questions: severe effect and
evidence sufficiency, each allowing unknown. Only valid **severe AND sufficient**
yields an exact-action hold or a result warning. Unknown/partial is neither
proven-safe nor grounds for a speculative hold. There is no numeric confidence
threshold, arbitrary judgment tool, provider override or automatic retry.

The parent Hub owns the shared System 1 service, accepted task/input revision,
durable decision state and approval coordination. Its Damage-Control pre-call
path covers baseline-allowed `bash`, `write` and `edit`, including calls admitted
through baseline path exemptions/approvals. Baseline-blocked calls do not gain
permission from D6. Hard denies, path exemptions, OS isolation, tool/depth/tree
caps, admission and budgets remain authoritative; baseline is revalidated after
an asynchronous wait before effects.

Native specialists, research helpers and nested delegates have independent D6
registration through physical spawn, bounded by their actual effective tools.
Assignments are fresh per physical attempt (including fallback), revocable and
independent of D9 consent. Inherited D6 assignments are stripped at spawn;
children receive scoped transport capabilities, not provider credentials. The
child's Damage-Control takes its assignment from the spawn environment when it
loads and removes it there, so Bash subprocesses do not inherit the capability;
nested delegate registration uses the retained copy, and a malformed assignment
fails closed. Guard registration, result capture and the human wait are
process-shared, because Pi loads every extension with its own module instance.
Research remains read-only: registration permits supported result screening,
not new write authority. Capability loss is not optional inference failure.

Standalone Damage-Control without a trusted assignment retains its baseline;
it does not discover a hidden provider. Coms peers are **not** covered by native
D6 registration. These describe implemented scope, not independently accepted
protection for every launcher or process.

Result screening is narrow: complete provenance-checked `read`, structured bash
output from a simple `cat` form, and exact complete filesystem excerpts.
Arbitrary shell output is unsupported. Image, multiblock, error, partial,
unverifiable and other unsupported sources retain originals and honest coverage
gaps; an absent warning is never evidence of trust.

## Bounds and human waits

Defaults/maxima are:

| Limit field | Bound |
| --- | --- |
| `maxPayloadBytes` | 16 KiB |
| `maxFrameBytes` | 64 KiB IPC frame |
| `hookTimeoutMs` | One 2 s collection/IPC/inference deadline |
| `outageBackoffMs` | 5 s technical backoff |
| `approvalTimeoutMs` | Separate 10 min human wait |

The current parser accepts smaller positive safe-integer values under these
maxima; not every field is equality-pinned. Broker/client also impose fixed
transport bounds, so these fields are not upward configuration knobs or a
promise that every transport bound follows a smaller configured value. Human
wait is separate from the provider deadline. There is no financial quota or
D9-length timeout.

## Durable denial, recovery and dialog-only override

A durable deny key binds task, accepted-input revision, operation, full target
hash and canonical cwd; it excludes call ID, owner and physical attempt so a new
call ID cannot erase the same denial. One-use execution authority additionally
binds the exact action, owner and physical attempt. Matching human consent is
not baseline permission and cannot be replayed.

Resume, compaction, off and outage cannot restore pending grants or clear known
denial/hold/recovery state. Technical unavailability before a new hold is not
the same as disconnect or cancellation after a hold. Corrupt or inconsistent
input/decision history may require new accepted input. Different task/revision
changes semantic identity; it is not a blanket permission grant.

`/af-damage-override [actionId]` arms **one new dialog** for a current matching
blocked action; without an ID it selects the latest eligible blocked action.
It does not execute, clear denial, grant path access or retry. A subsequent
explicit matching attempt still requires successful exact-action approval and
current baseline authority. Failed/cancelled approval grants nothing. This is
not `/af-allow`, which changes only baseline path exemptions and cannot waive a
semantic denial or hard command deny. Semantic and path/baseline waits use the
shared human approval coordinator; cancellation/reset/expiration grant no effect
authority.

## Original evidence versus visible structured output

The composition order is **original → D6 → D8**. An emission-local, frozen,
non-aliased original evidence snapshot is separate from the visible advisory
view. Failed capture is an explicit gap, never a shallow substitute. D8 consumes
original validated evidence, not appended D6 advice. The visible original slot
is not a substitute for independent captured provenance.

Original blocks, status/error/exit, details and usage are preserved; visible
advisory blocks are appended, not promoted to instructions. Structured output
has this programmatic contract:

- Strings retain the original prefix and string type, with advisory text appended.
- Plain objects retain their fields and add `originalStructuredContent` plus
  `damageGuard: {metadata,text}`. Colliding keys or nonplain values use an
  envelope retaining the prior value under `originalStructuredContent`.
- D8 adds an independent `fileDiscovery: {metadata,text}`, preserving the D6
  view or enveloping collisions rather than overwriting it.
- Absent structured output stays absent.

Warnings and coverage are advisory, untrusted data. Warning absence and
`no_additional_finding` never establish source trust: `sourceTrusted: false`.
Off/failure paths retain explicit gaps on supported composition surfaces, not
an invented successful assessment.

## Bounded evidence and remaining gates

Named F10 evidence in session `18aa53af-ac7d-4f4f-9e20-769fc135384a`:

- `artifacts/evidence/builder-5ecc73c9-d426-4086-898e-f554570628a2.md` records
  the structured D8 visibility repair and exact commands/state identities.
- `artifacts/evidence/f10-focused-5ecc73c9.log` and `.exit`: 176/176 passing,
  exit 0, no failures/skips.
- `artifacts/evidence/f10-companion-5ecc73c9.log` and `.exit`: 252/252 passing,
  exit 0, no failures/skips.

Those runs exercised the actual installed SDK/codemode **1.1.0**, Node
**v25.2.1**, using synthetic provider responses under the no-network preload.
F11 read this evidence; it did not rerun F10. These are bounded local checks,
not global Pi compatibility, live accuracy or independent acceptance.

**SDK limitation:** non-structured error rejection exposes the original first
text block, not coverage text. The nested outcome retains coverage/error;
structured error script values retain advice. Therefore not every failure or
script surface carries visible coverage. Older version-specific compatibility
observations elsewhere remain historical, not superseded universal claims.

`npm run test:damage-guard` remains absent until F12; it is the required later
acceptance command, not a documentation check or an executed F11 test. No A1–A8
assertion is proven by these documents or by module presence. Packaging, final
regression, independent review, Checkpoint D and final acceptance remain open.
See the [original implementation record](plans/jev/d6/PLAN-system1-damage-guard.md).
