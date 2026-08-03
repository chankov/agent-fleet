// plan.js — turn (manifest × recorded state × disk) into an ordered action list.
//
// This is the deterministic core the whole installer rests on. `install`,
// `upgrade`, and later `doctor --fix` and `uninstall` are the same computation
// with different policies about what each item state means; `apply()` (Phase 4)
// is this plan executed. Because every verb shares the planner, repair and
// setup cannot drift apart in behaviour — that drift is what the prose skill
// could not prevent.
//
// The planner is pure in the sense that matters: it reads the filesystem, and
// writes nothing. Two runs against an unchanged workspace produce identical
// output.
//
// See plans/deterministic-installer-manifest-spec.md §4 for the state and merge
// tables this implements, and plans/deterministic-installer.md phases 3 and 5.

import { itemsForAgent, resolveSelection } from "./manifest.js";
import { evaluateWorkspace, resolveBaseRoot } from "./verify.js";
import { readState, readLegacyRecord, isAgentFleetCheckout } from "./state.js";

export const PLAN_SCHEMA_VERSION = 1;

// What an action does. Ordered by how much it disturbs the workspace, which is
// also the order they are summarised in.
export const ACTION_KINDS = [
  "create",    // nothing there; write it
  "refresh",   // present but behind, or deliberately overwritten
  "repair",    // recorded but missing/broken on disk
  "remove",    // retired upstream, and we own it
  "conflict",  // three-way conflict — needs a human decision, never guessed
  "keep",      // already correct, or a local edit we are preserving
  "exec",      // runs a command; gated on --allow-exec
  "external",  // a package the user installs; reported, never performed
  "operator",  // systemd/pairing/credentials; printed as next steps only
  "skip",      // deliberately not acted on, with a reason
];

// Actions that change the workspace. `changes === 0` is what idempotency means.
const MUTATING = new Set(["create", "refresh", "repair", "remove"]);

// The states that mean "we installed this and it is broken now" — the only
// ones `repair` acts on, and the ones every other verb repairs unconditionally.
const BREAKAGE = {
  "missing":      "recorded as installed but absent on disk",
  "broken-link":  "symlink target no longer exists",
  "foreign-link": "symlink resolves outside the source root",
};

/**
 * Build an action plan.
 *
 * @param {object}   opts
 * @param {string}   opts.workspace        absolute target workspace
 * @param {string}   opts.sourceRoot       absolute agent-fleet package root
 * @param {string}   opts.packageVersion   the running package's version
 * @param {object}   opts.manifest         loaded install manifest
 * @param {"install"|"upgrade"|"repair"|"uninstall"} [opts.verb]
 * @param {string}   [opts.agent]          overrides the recorded agent
 * @param {"copy"|"symlink"} [opts.method]
 * @param {string[]} [opts.profiles]       profile names (install only)
 * @param {string[]} [opts.items]          explicit item ids (install, uninstall)
 * @param {boolean}  [opts.allowExec]      permit `exec` items to be planned
 * @param {"theirs"|"ours"|null} [opts.accept]  non-interactive conflict policy
 * @param {string}   [opts.platform]
 * @returns {object} plan
 */
export function buildPlan({
  workspace,
  sourceRoot,
  packageVersion,
  manifest,
  verb = "install",
  agent = null,
  method = null,
  profiles = [],
  items = [],
  all = false,
  allowExec = false,
  accept = null,
  platform = process.platform,
}) {
  const state = readState(workspace);
  const legacy = readLegacyRecord(workspace);
  const resolvedAgent = agent ?? state?.agent ?? legacy?.agent ?? null;
  if (!resolvedAgent) {
    throw new Error(
      "cannot plan without a coding agent — pass --agent <claude-code|opencode|pi>",
    );
  }

  const recordedVersion = state?.packageVersion ?? legacy?.version ?? null;
  const stateSource = state ? "state-file" : legacy ? "legacy-record" : "none";
  const baseRoot = resolveBaseRoot(sourceRoot, recordedVersion);

  // Symlink installs survive only inside an agent-fleet checkout (see
  // isAgentFleetCheckout). A workspace that recorded `symlink` before the
  // restriction is not left half-supported: the method resolves to `copy`, and
  // the decision table's method-change rule then re-materialises every linked
  // item as a real file on this pass. The CLI refuses an *explicit*
  // `--method symlink` outright rather than downgrading it silently — that one
  // the user typed on purpose.
  const requestedMethod = method ?? state?.method ?? "copy";
  const symlinkSupported = isAgentFleetCheckout(workspace);
  const resolvedMethod = requestedMethod === "symlink" && !symlinkSupported ? "copy" : requestedMethod;

  const evaluations = evaluateWorkspace({
    workspace, sourceRoot, manifest, agent: resolvedAgent, platform, state, baseRoot,
    fileLimit: Infinity,
  });
  const byId = new Map(evaluations.map((e) => [e.id, e]));

  // What are we acting on?
  //
  //   install   — the selection the caller asked for (profiles ∪ items), closed
  //               over `requires` and `companions`.
  //   upgrade   — whatever this workspace already has. An upgrade never widens
  //               the install; new artifacts are reported as available, and the
  //               user adds them with an explicit `install`.
  //   repair    — the same recorded set, but only breakage is actionable.
  //   uninstall — the named recorded items (or all of them), closed downwards
  //               over companions nobody else still needs.
  const recordedIds = Object.keys(state?.items ?? {}).sort();
  const notes = [];

  if (["upgrade", "repair", "uninstall"].includes(verb) && stateSource === "none") {
    throw new Error(
      `nothing to ${verb} — this workspace has no agent-fleet install record. Run \`install\` first.`,
    );
  }

  const selection = verb === "install"
    ? resolveSelection(manifest, resolvedAgent, { profiles, items })
    : verb === "uninstall"
      ? resolveRemoval({ manifest, agent: resolvedAgent, recordedIds, requested: items, all, notes })
      : { selected: recordedIds, unknown: [] };

  const selected = new Set(selection.selected);

  if (resolvedMethod !== requestedMethod) {
    notes.push({
      type: "symlink-retired",
      detail:
        "this workspace was installed with symlinks, which are now supported only inside " +
        "an agent-fleet checkout — linked items are being re-materialised as copies",
    });
  }

  if (["upgrade", "repair"].includes(verb) && stateSource === "legacy-record") {
    notes.push({
      type: "pre-engine-workspace",
      detail:
        "install record predates the state file, so ownership cannot be read back; " +
        "run `install` once to reconstruct it before upgrading",
    });
  }
  if (verb === "upgrade") {
    if (recordedVersion && recordedVersion === packageVersion) {
      notes.push({
        type: "no-version-delta",
        detail: `already at v${packageVersion} — only content drift is actionable`,
      });
    }
    if (!baseRoot && recordedVersion) {
      notes.push({
        type: "base-snapshot-missing",
        detail:
          `no .versions/${recordedVersion} snapshot — merges degrade to two-way ` +
          "and local edits are preserved rather than merged",
      });
    }
  }

  const actions = [];
  for (const evaluation of evaluations) {
    const action = decide({
      evaluation,
      verb,
      selected: selected.has(evaluation.id),
      allowExec,
      accept,
      method: resolvedMethod,
    });
    if (action) actions.push({ ...action, ...describe(evaluation) });
  }

  // Recorded ids the current manifest no longer lists — retired upstream, or
  // catalogued for a different agent — never reach the loop above, because it
  // walks the catalogue. Both verbs that remove things still have to reach them:
  // otherwise a retired artifact could never be cleaned up at all.
  if (["upgrade", "uninstall"].includes(verb)) {
    for (const id of selection.selected) {
      if (byId.has(id)) continue;
      actions.push({
        kind: "remove",
        id,
        itemKind: state?.items?.[id]?.kind ?? "unknown",
        consent: "file",
        state: "gone",
        owned: true,
        target: state?.items?.[id]?.files?.[0]?.path ?? null,
        reason: verb === "uninstall"
          ? "recorded as installed but no longer in the catalogue"
          : "no longer in the catalogue for this agent — retired upstream",
      });
    }
  }

  const ordered = orderActions(actions, manifest, resolvedAgent);
  const conflicts = ordered.filter((a) => a.kind === "conflict");

  return {
    schemaVersion: PLAN_SCHEMA_VERSION,
    verb,
    workspace,
    sourceRoot,
    agent: resolvedAgent,
    method: resolvedMethod,
    packageVersion,
    recordedVersion,
    stateSource,
    baseAvailable: Boolean(baseRoot),
    selection: {
      profiles: [...profiles].sort(),
      requested: [...items].sort(),
      resolved: selection.selected,
      unknown: selection.unknown,
    },
    actions: ordered,
    conflicts,
    notes,
    summary: summarise(ordered, evaluations, selected, verb),
  };
}

/**
 * Which recorded items an `uninstall` should take down.
 *
 * Selection closes *downwards* only. Removing an item takes its companions —
 * but a companion shared with something that stays installed is kept, or
 * removing `pi-extension:btw` would delete the `package.json` five other
 * extensions run from. The mirror rule guards the other direction: an item
 * another installed item `pinnedBy` is refused, not silently orphaned.
 *
 * @returns {{ selected: string[], unknown: string[], refused: object[] }}
 */
function resolveRemoval({ manifest, agent, recordedIds, requested, all, notes }) {
  const recorded = new Set(recordedIds);
  const catalogue = new Map(itemsForAgent(manifest, agent).map((i) => [i.id, i]));
  const unknown = [];

  const roots = [];
  if (all) {
    roots.push(...recorded);
  } else {
    for (const id of requested) {
      if (recorded.has(id)) roots.push(id);
      else unknown.push(id);
    }
  }

  // A fixpoint, not two passes: refusing a pinned item can orphan a companion
  // that was only selected because of it, and expanding companions can surface
  // a newly pinned one. Iterate until neither step changes anything.
  const refused = new Map();
  let selected = new Set();
  for (;;) {
    selected = new Set(roots.filter((id) => !refused.has(id)));

    // Downward closure: a companion travels with its parent.
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of [...selected]) {
        for (const cid of catalogue.get(id)?.companions ?? []) {
          if (!recorded.has(cid) || selected.has(cid) || refused.has(cid)) continue;
          selected.add(cid);
          grew = true;
        }
      }
    }

    // Upward guard: refuse rather than break something that stays. One rule
    // covers both shapes — an explicit `pinnedBy` edge, and a companion whose
    // parent survives (removing `.pi/extensions/package.json` under five
    // extensions is the same mistake as removing a pinned harness).
    const newlyRefused = [...selected]
      .map((id) => ({
        id,
        pinnedBy: [
          ...(catalogue.get(id)?.pinnedBy ?? []),
          ...(catalogue.get(id)?.parents ?? []),
        ].filter((p) => recorded.has(p) && !selected.has(p)),
      }))
      .filter((entry) => entry.pinnedBy.length > 0);

    if (newlyRefused.length === 0) break;
    for (const entry of newlyRefused) refused.set(entry.id, entry);
  }

  for (const entry of [...refused.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    notes.push({
      type: "pinned",
      detail: `${entry.id} is kept — still required by ${entry.pinnedBy.sort().join(", ")}`,
    });
  }

  return {
    selected: [...selected].sort(),
    unknown: uniqSorted(unknown),
    refused: [...refused.values()],
  };
}

function uniqSorted(list) {
  return [...new Set(list)].sort();
}

/** True when the plan needs a human decision before it can be applied. */
export function hasConflicts(plan) {
  return plan.conflicts.length > 0;
}

/** True when applying the plan would change the workspace. */
export function isNoop(plan) {
  return plan.summary.changes === 0 && plan.conflicts.length === 0;
}

// ── the decision table ──────────────────────────────────────────────────────

/**
 * One item's state → one action. This is §4.1 of the spec, plus the one place
 * the two verbs genuinely differ:
 *
 *   `modified` (the user edited an installed file)
 *     • install — refresh. The user named this item, and SKILL.md step 10's
 *       rule applies: selection is consent, so no mid-flight question. The
 *       action carries `overwrites: true` so the confirmation screen can say so.
 *     • upgrade — keep. Nobody asked for this file specifically; a bulk version
 *       bump must never eat a deliberate local edit.
 *
 * The two Phase 6 verbs are narrowings of the same table rather than new ones:
 *
 *   repair    — admits only the three breakage states. Content that is merely
 *               behind or edited is not breakage, and a doctor that quietly
 *               refreshed it would be an upgrade wearing a repair's name.
 *   uninstall — admits only removal, and only of what the state file records.
 */
function decide({ evaluation, verb, selected, allowExec, accept, method }) {
  const { id, state, consent } = evaluation;

  if (verb === "uninstall") {
    if (!selected) return null;
    // The ownership rule, at plan time: `apply()` enforces it again before it
    // deletes anything, but a plan that lists a file we never installed would
    // already have told the user a lie.
    if (!evaluation.owned) {
      return { kind: "skip", id, reason: "not recorded as installed by agent-fleet — never removed" };
    }
    return { kind: "remove", id, reason: "selected for removal" };
  }

  if (verb === "repair") {
    // Only breakage, and only ours. An unowned broken link (a pre-engine
    // workspace, a hand-made link) is still reported — by the doctor scan,
    // which has the rename heuristics the manifest cannot express.
    if (!evaluation.owned || !BREAKAGE[state]) return null;
    return { kind: "repair", id, reason: BREAKAGE[state] };
  }

  // Consent classes the engine never applies itself, regardless of state.
  if (state === "not-applicable") {
    if (!selected) return null;
    if (consent === "exec") {
      return allowExec
        ? { kind: "exec", id, reason: "declared command, permitted by --allow-exec" }
        : { kind: "skip", id, reason: "runs a command — re-run with --allow-exec to include it" };
    }
    if (consent === "external") {
      return {
        kind: "external",
        id,
        reason: `external package — install ${evaluation.packageSpec ?? "it"} yourself; never done for you`,
      };
    }
    if (consent === "operator") {
      return {
        kind: "operator",
        id,
        reason: `${(evaluation.operatorSteps ?? []).length} operator step(s) — printed, never performed`,
      };
    }
    return { kind: "skip", id, reason: "no workspace target" };
  }

  // Owned but retired, or the source vanished: propose the cleanup on upgrade,
  // leave it alone on install.
  if (state === "gone") {
    if (!evaluation.owned) return null;
    return verb === "upgrade"
      ? { kind: "remove", id, reason: "retired upstream — no source in this version" }
      : { kind: "keep", id, reason: "retired upstream; `upgrade` proposes the cleanup" };
  }

  // Recorded as installed but missing or mis-linked on disk. Repair regardless
  // of selection — this is breakage we caused, and leaving it is not an option.
  if (BREAKAGE[state]) {
    if (!evaluation.owned && !selected) return null;
    return { kind: "repair", id, reason: BREAKAGE[state] };
  }

  if (!selected) {
    // Never touched: a narrower profile does not uninstall anything (§2.3).
    return evaluation.owned
      ? { kind: "keep", id, reason: "installed but not in this selection — selection never removes" }
      : null;
  }

  // Install form, not content: a copy whose bytes match the source is still the
  // wrong thing when the workspace asked for symlinks (and vice versa), so a
  // changed --method has to re-materialise even a byte-identical item.
  if (
    ["linked", "up-to-date", "outdated"].includes(state) &&
    ["copy", "symlink"].includes(evaluation.recordedMethod) &&
    evaluation.recordedMethod !== method
  ) {
    return {
      kind: "refresh",
      id,
      reason: `installed as ${evaluation.recordedMethod}; this run asks for ${method}`,
    };
  }

  switch (state) {
    case "absent":
      return { kind: "create", id, reason: "not installed" };

    case "linked":
      return { kind: "keep", id, reason: "symlinked to source — content follows the package" };

    case "up-to-date":
      return { kind: "keep", id, reason: "matches the current source" };

    case "outdated":
      return { kind: "refresh", id, reason: "source is newer; the local copy is unmodified" };

    case "modified":
      return verb === "upgrade"
        ? { kind: "keep", id, reason: "locally modified — preserved by upgrade", preserved: true }
        : { kind: "refresh", id, reason: "locally modified — selecting it overwrites your edits", overwrites: true };

    case "conflict":
      if (accept === "theirs") {
        return { kind: "refresh", id, reason: "conflict resolved by --accept-theirs", overwrites: true };
      }
      if (accept === "ours") {
        return { kind: "keep", id, reason: "conflict resolved by --accept-ours", preserved: true };
      }
      return {
        kind: "conflict",
        id,
        reason: "changed both locally and upstream — resolve with --accept-theirs / --accept-ours",
      };

    case "partial":
      return { kind: "create", id, reason: "partially present — completing the install" };

    case "unchecked":
      // managed-region / json-merge: their real comparison needs the merge
      // logic that lands with apply(). Planning them as a refresh is the safe
      // reading — both strategies are idempotent rewrites of a bounded region.
      return { kind: "refresh", id, reason: "managed region — rewritten from source on every apply" };

    default:
      return { kind: "skip", id, reason: `unhandled state: ${state}` };
  }
}

// ── ordering ────────────────────────────────────────────────────────────────

// Phases apply() walks in order. A command must see the finished file tree —
// `npm ci --prefix .pi/extensions` needs the manifests already written — so no
// amount of dependency ordering inside phase 1 can put an exec early enough to
// be wrong. Reporting-only kinds come last because they change nothing.
const PHASE = { exec: 1, external: 2, operator: 2, skip: 2 };
const phaseOf = (kind) => PHASE[kind] ?? 0;

/**
 * Order actions so apply() can walk them straight through: file work first
 * (requirements before the items that need them, then by id), then commands,
 * then the reporting-only kinds.
 *
 * Two edge sets feed the topological pass — `requires`, which is a hard
 * dependency, and a companion's `parents`, so a companion never lands before
 * the artifact it belongs to. Cycles are legal (the two Fleet Core harnesses
 * require each other, because either one alone cannot boot `just fleet`); the
 * trail guard makes such a pair fall back to id order instead of looping.
 */
function orderActions(actions, manifest, agent) {
  const catalogue = itemsForAgent(manifest, agent);
  const edges = new Map(
    catalogue.map((i) => [i.id, [...(i.requires ?? []), ...(i.parents ?? [])]]),
  );
  const present = new Map(actions.map((a) => [a.id, a]));
  const out = [];
  const seen = new Set();

  const visit = (id, trail) => {
    if (seen.has(id) || trail.has(id)) return;
    trail.add(id);
    for (const dep of [...(edges.get(id) ?? [])].sort()) {
      if (present.has(dep)) visit(dep, trail);
    }
    trail.delete(id);
    seen.add(id);
    out.push(present.get(id));
  };

  for (const id of [...present.keys()].sort()) visit(id, new Set());

  // Stable partition — the topological order survives inside each phase.
  return out
    .map((action, index) => ({ action, index }))
    .sort((a, b) => phaseOf(a.action.kind) - phaseOf(b.action.kind) || a.index - b.index)
    .map((entry) => entry.action);
}

// ── reporting ───────────────────────────────────────────────────────────────

function describe(evaluation) {
  const out = {
    itemKind: evaluation.kind,
    consent: evaluation.consent,
    state: evaluation.state,
    owned: evaluation.owned,
    target: evaluation.target ?? null,
  };
  if (evaluation.changedCount) out.changedCount = evaluation.changedCount;
  // What the human does instead, for the two classes the engine won't do itself.
  if (evaluation.operatorSteps) out.operatorSteps = evaluation.operatorSteps;
  if (evaluation.packageSpec) out.packageSpec = evaluation.packageSpec;
  // Only the paths a human has to act on travel with the action; the rest is
  // noise in a plan that may list a hundred items.
  const notable = (evaluation.files ?? []).filter(
    (f) => f.state === "conflict" || f.state === "modified",
  );
  if (notable.length > 0) out.files = notable.map((f) => ({ path: f.path, state: f.state }));
  return out;
}

function summarise(actions, evaluations, selected, verb) {
  const byKind = Object.fromEntries(ACTION_KINDS.map((k) => [k, 0]));
  for (const a of actions) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;

  // Catalogued for this agent, not installed, not selected: what an `install`
  // with a wider profile would add. Upgrade reports it instead of doing it.
  const newAvailable = evaluations.filter(
    (e) => !e.owned && e.state === "absent" && !selected.has(e.id),
  ).length;

  return {
    ...byKind,
    total: actions.length,
    changes: actions.filter((a) => MUTATING.has(a.kind)).length,
    overwrites: actions.filter((a) => a.overwrites).length,
    preserved: actions.filter((a) => a.preserved).length,
    newAvailable,
    verb,
  };
}
