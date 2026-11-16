export interface GateOArtifact {
  api?: { kind?: string; name?: string; argumentShape?: string };
  observations?: Record<string, unknown>;
  evidenceIds?: unknown;
  unsupported?: unknown;
  synthetic?: unknown;
  /** Set only by a disposable live run; schema validation never derives this. */
  originDelivery?: unknown;
  liveRunId?: unknown;
}

export interface GateOValidation {
  artifactValid: boolean;
  originDelivery: boolean;
  disposition: "origin-delivery-enabled" | "journal-only-no-steering";
}

const SECRET = /(?:token|bearer|secret|password|authorization|api[_-]?key)\s*[=:]/i;
const safeText = (value: unknown, maximum: number) => typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= maximum && !SECRET.test(value);
const REQUIRED_OBSERVATIONS = ["opaqueOrigin", "threeIncrementalUpdates", "wakeReconnect", "profileIsolation", "twoChatIsolation", "structuredInvocation"];

/** Validates a sanitized *live* artifact. It never probes, sends, or enables a route itself. */
export function validateGateOArtifact(value: unknown): GateOValidation {
  const artifact = value as GateOArtifact | null;
  const api = artifact?.api;
  const observations = artifact?.observations;
  const evidenceIds = artifact?.evidenceIds;
  const evidenceSafe = Array.isArray(evidenceIds) && evidenceIds.length >= 2 && evidenceIds.every(id => safeText(id, 256));
  const apiSafe = safeText(api?.kind, 64) && safeText(api?.name, 128) && !/\bsend\s+--to\b/i.test(api.name) && safeText(api?.argumentShape, 256);
  const observed = !!observations && REQUIRED_OBSERVATIONS.every(key => observations[key] === true);
  const artifactValid = !!artifact && artifact.unsupported !== true && artifact.synthetic !== true && apiSafe && observed && evidenceSafe;
  // This assertion is recorded by a disposable live run. A valid document alone is never capability proof.
  const originDelivery = artifactValid && artifact?.originDelivery === true && safeText(artifact.liveRunId, 256);
  return { artifactValid, originDelivery, disposition: originDelivery ? "origin-delivery-enabled" : "journal-only-no-steering" };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try { console.log(JSON.stringify(validateGateOArtifact(JSON.parse(input)))); }
    catch { console.log(JSON.stringify(validateGateOArtifact(undefined))); process.exitCode = 2; }
  });
}
