import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateGateOArtifact } from "./hermes-watchdog-capability-probe.ts";

const matrix = JSON.parse(readFileSync(new URL("../hermes/gates/gate-o-validator-fixtures.json", import.meta.url), "utf8"));

const live = { api: { kind: "argv", name: "hermes origin-update", argumentShape: "[opaque-route] [message]" }, observations: { opaqueOrigin: true, threeIncrementalUpdates: true, wakeReconnect: true, profileIsolation: true, twoChatIsolation: true, structuredInvocation: true }, evidenceIds: ["sanitized-live-a", "sanitized-live-b"], originDelivery: true, liveRunId: "disposable-live-run-1" };

test("only complete sanitized live evidence enables origin delivery", () => {
  assert.deepEqual(validateGateOArtifact(live), { artifactValid: true, originDelivery: true, disposition: "origin-delivery-enabled" });
});

test("schema validity alone never manufactures origin delivery", () => {
  assert.deepEqual(validateGateOArtifact({ ...live, originDelivery: undefined, liveRunId: undefined }), { artifactValid: true, originDelivery: false, disposition: "journal-only-no-steering" });
});

test("the shared Gate O fixture matrix rejects every unsafe marker and target-only route", () => {
  for (const fixture of matrix) {
    assert.equal(validateGateOArtifact(fixture.artifact).originDelivery, fixture.originDelivery, fixture.name);
  }
});

test("unsupported, synthetic, target-only, secret-bearing, and incomplete evidence fail closed", () => {
  for (const artifact of [undefined, { ...live, unsupported: true }, { ...live, synthetic: true }, { ...live, api: { ...live.api, name: "hermes send --to" } }, { ...live, observations: { ...live.observations, twoChatIsolation: false } }, { ...live, evidenceIds: ["token=secret"] }]) {
    const result = validateGateOArtifact(artifact);
    assert.equal(result.originDelivery, false);
    assert.equal(result.disposition, "journal-only-no-steering");
  }
});
