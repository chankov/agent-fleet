import "../../../../bin/test/helpers/system1-no-network.js";
import assert from "node:assert/strict";
import test from "node:test";

import type { System1Provider } from "./contracts.ts";
import { createSystem1Service } from "./service.ts";

const request = {
  state: { message: "synthetic" },
  questionSetVersion: "fixture-v1",
  questions: [
    {
      id: "priority",
      type: "ordinal" as const,
      instructions: "Rate priority",
      levels: ["low", "medium", "high"],
    },
  ],
};

test("a fake provider can satisfy the Fleet contract without provider-specific fields", async () => {
  const provider: System1Provider = {
    name: "fixture",
    model: "fixture-ordinal",
    capabilities: ["ordinal", "distribution"],
    async evaluate(input) {
      return {
        status: "ok",
        evaluation: {
          answers: [
            {
              questionId: "priority",
              type: "ordinal",
              value: 1.2,
              levels: request.questions[0].levels,
              uncertainty: {
                provenance: "provider",
                distribution: { "0": 0.1, "1": 0.6, "2": 0.3 },
              },
            },
          ],
          metadata: {
            provider: this.name,
            requestedModel: this.model,
            returnedModel: this.model,
            questionSetVersion: input.questionSetVersion,
            latencyMs: 1,
            attempts: 1,
          },
        },
      };
    },
  };

  const result = await createSystem1Service({ provider }).evaluate(request);
  assert.equal(result.status, "ok");
  assert.equal(JSON.stringify(result).includes("noul"), false);
  assert.equal(JSON.stringify(result).includes("score"), false);
  assert.equal(JSON.stringify(result).includes("confidence"), false);
});
