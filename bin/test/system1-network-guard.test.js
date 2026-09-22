import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const guard = new URL("./helpers/system1-no-network.js", import.meta.url).href;

test("System 1 offline guard fails even a caught HTTPS attempt with an ambient key", () => {
  const child = spawnSync(process.execPath, ["--import", guard, "--input-type=module", "-e", `
    import https from 'node:https';
    import { request } from 'node:https';
    for (const send of [https.request, https.get, request]) {
      try { send('https://api.typesafe.ai/v1/systemone'); }
      catch (error) {
        if (error.message !== 'System 1 offline tests forbid HTTPS requests') throw error;
        console.log('blocked');
      }
    }
  `], { encoding: "utf8", env: { ...process.env, TYPESAFE_API_KEY: "offline-guard-sentinel" } });
  assert.equal(child.status, 1);
  assert.equal(child.stdout, "blocked\nblocked\nblocked\n");
  assert.equal(child.stderr, "");
});
