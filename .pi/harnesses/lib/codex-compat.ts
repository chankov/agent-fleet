/** Pure version prefilter, not queue compatibility or delivery qualification.
 * No default policy: callers must supply an explicit minimum and denylist.
 * Runtime admission still requires identity, contract, consumer and authority evidence.
 */
type Version = {core: readonly [string, string, string]; prerelease: readonly string[]};
type Order = -1 | 0 | 1;
export type CodexVersionAssessment =
 | {eligible: true; reason: 'meets_minimum'}
 | {eligible: false; reason: 'invalid_policy' | 'invalid_version' | 'denied_version' | 'below_minimum'};

const maxVersionLength = 256;
const maxDenylistEntries = 128;
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const numeric = (value: string) => /^[0-9]+$/.test(value);

function parseVersion(value: unknown): Version | undefined {
 if (typeof value !== 'string' || value.length > maxVersionLength) return;
 const match = versionPattern.exec(value);
 if (!match) return;
 const prerelease = match[4]?.split('.') ?? [];
 if (prerelease.some(part => numeric(part) && part.length > 1 && part[0] === '0')) return;
 return {core: [match[1], match[2], match[3]], prerelease};
}

/** The measured initialize UA grammar and our exact Fleet originators only.
 * The first product token carries the daemon build, never the SDK suffix.
 * Version observation is NOT Desktop
 * identity, MCP clientInfo or loaded-consumer evidence. Shared by observer and
 * pinned queue connections so suffix handling cannot diverge. */
export function codexDaemonVersionFromUserAgent(value:unknown):string|undefined {
 if(typeof value!=='string'||value.length>4096||/[\u0000-\u001f\u007f]/.test(value))return;
 const match=/^(?:Codex Desktop|agent_fleet_contract_observer|agent_fleet_queue_bridge)\/([^\s()]+)(?:\s|$)/.exec(value);
 return match&&parseVersion(match[1])?match[1]:undefined;
}

function compareNumeric(left: string, right: string): Order {
 if (left === right) return 0;
 if (left.length !== right.length) return left.length < right.length ? -1 : 1;
 return left < right ? -1 : 1;
}

function compare(left: Version, right: Version): Order {
 for (let i = 0; i < 3; i++) {
  const order = compareNumeric(left.core[i], right.core[i]);
  if (order !== 0) return order;
 }
 if (left.prerelease.length === 0 || right.prerelease.length === 0) {
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length === 0 ? 1 : -1;
 }
 for (let i = 0; i < Math.min(left.prerelease.length, right.prerelease.length); i++) {
  const a = left.prerelease[i], b = right.prerelease[i];
  if (a === b) continue;
  const aNumeric = numeric(a), bNumeric = numeric(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : 1;
 }
 return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/** Strict SemVer 2.0 precedence for <=256 ASCII characters; build metadata is
 * validated but ignored in precedence. Invalid input returns undefined, not 0.
 * Callers must extract actual version fields separately; banners/UA are invalid.
 */
export function compareCodexVersions(left: unknown, right: unknown): Order | undefined {
 const a = parseVersion(left), b = parseVersion(right);
 return a && b ? compare(a, b) : undefined;
}

/** Policy is inert JSON data: {minimum: string, denylist: string[]} (<=128 entries).
 * Malformed JSON-shaped policy/entries fail closed. This is not an exception
 * boundary for arbitrary JavaScript getters/Proxies or a validator of symbol keys.
 * Policy validation precedes version validation, then denial precedes minimum.
 * Denials compare SemVer precedence,
 * so adding/changing build metadata cannot evade a denied release.
 * eligible:true establishes ONLY the version prefilter, never runtime readiness.
 */
export function assessCodexVersion(observed: unknown, policy: unknown): CodexVersionAssessment {
 const invalidPolicy = {eligible: false, reason: 'invalid_policy'} as const;
 if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return invalidPolicy;
 if (Object.keys(policy).length !== 2 || !Object.hasOwn(policy, 'minimum') || !Object.hasOwn(policy, 'denylist')) return invalidPolicy;
 const {minimum, denylist} = policy as {minimum: unknown; denylist: unknown};
 const floor = parseVersion(minimum);
 if (!floor || !Array.isArray(denylist) || denylist.length > maxDenylistEntries) return invalidPolicy;
 const denied: Version[] = [];
 for (const entry of denylist) {
  const parsed = parseVersion(entry);
  if (!parsed) return invalidPolicy;
  denied.push(parsed);
 }
 const version = parseVersion(observed);
 if (!version) return {eligible: false, reason: 'invalid_version'};
 if (denied.some(entry => compare(version, entry) === 0)) return {eligible: false, reason: 'denied_version'};
 if (compare(version, floor) < 0) return {eligible: false, reason: 'below_minimum'};
 return {eligible: true, reason: 'meets_minimum'};
}
