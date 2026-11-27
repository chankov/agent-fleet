// @ts-check
// System 1 transport decision (PLAN-11-01 tasks 14–16, D32). Pure and offline: no provider,
// registry or catalog access. Every caller uses Fleet's direct TypeSafe adapter (jev.ts), selected
// before any request is built, so one evaluation is never submitted through a second transport.
//
// Pi's native classifier (`ctx.modelRegistry.classify`, Pi 1.1.0; unchanged in the managed 1.6.1)
// was checked against Fleet's guarantees and does not meet them yet. Change this table only with a
// new compatibility decision that establishes every guarantee below for the caller in question.

export const SYSTEM1_DIRECT_TRANSPORT = "direct";

/** Why the native classifier is not used; short, secret-free and suitable for doctor output. */
export const NATIVE_CLASSIFIER_GAPS = Object.freeze([
  "Pi's catalog has no classifier typesafe/jev-1.13.0 (only jev-latest), and models.json cannot declare a classifier",
  "the native result reports the requested model, not the model the provider returned",
  "ordinal (score) answers lose their probability distribution and level legend",
  "the native transport retries after a timeout or unknown outcome and reads bodies without a size bound",
  "Pi may resolve credentials from auth.json, models.json or credential commands; Fleet reads only the configured environment variable",
]);

/** Every System 1 caller and the transport it uses, with the evidence-based reason. */
export const SYSTEM1_TRANSPORTS = Object.freeze([
  { caller: "hub", context: "Hub extension (watchdog, proactive review, dispatch and task triage, Ask System 1, file discovery, context compaction, damage guard)", transport: SYSTEM1_DIRECT_TRANSPORT, reason: "the registry is available, but dispatch triage and file discovery need ordinal distributions, and every consumer relies on returned-model validation, size bounds, attempt metadata and reason codes" },
  { caller: "damage-control-child", context: "child Pi session, client of the Hub broker", transport: SYSTEM1_DIRECT_TRANSPORT, reason: "no provider authority by design; it uses whatever the Hub uses" },
  { caller: "dispatch-triage-eval", context: "standalone CLI", transport: SYSTEM1_DIRECT_TRANSPORT, reason: "no registry" },
  { caller: "task-triage-pilot", context: "standalone CLI with a byte-exact transport check", transport: SYSTEM1_DIRECT_TRANSPORT, reason: "no registry; needs the direct transport hook" },
  { caller: "demo", context: "standalone demo", transport: SYSTEM1_DIRECT_TRANSPORT, reason: "no registry" },
].map(entry => Object.freeze(entry)));

/** The transport for a caller, chosen before any request exists. Unknown callers also get the direct adapter. */
export function selectSystem1Transport(caller = "hub") {
  const entry = SYSTEM1_TRANSPORTS.find(item => item.caller === caller);
  return { transport: SYSTEM1_DIRECT_TRANSPORT, reason: entry?.reason ?? "no compatibility decision for this caller; the direct adapter is the only supported transport" };
}

/** One doctor line: the selected transport and, briefly, why the native classifier is not used. */
export function system1TransportSummary() {
  return `transport: ${SYSTEM1_DIRECT_TRANSPORT} (Fleet's TypeSafe adapter); Pi's native classifier is not used because ${NATIVE_CLASSIFIER_GAPS[0]}, and its results lack the returned model and ordinal distributions`;
}
