import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMonitorLifecycle } from "./monitor-lifecycle.ts";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";
import { MonitorRegistry } from "../../../scripts/lib/hermes-monitor-registry.ts";

test("lifecycle snapshot/output/cancel share one bridge-backed task store", async () => {
  const root=mkdtempSync(join(tmpdir(),"monitor-live-")); mkdirSync(join(root,"profile"));
  const bridge=createMonitorSessionBridge(); const lifecycle=createMonitorLifecycle({registry:new MonitorRegistry({runtimeDir:join(root,"runtime")})});
  const registration=await lifecycle.start({profilePath:join(root,"profile"),hubInstanceId:"hub",snapshot:()=>bridge.snapshot(),output:(r:any)=>bridge.readOutput?.(r)});
  try {
    assert.equal(typeof registration.output,"function","lifecycle must expose bridge-backed output route");
    assert.equal(typeof registration.cancel,"function","lifecycle must expose bridge-backed cancel route");
    assert.ok("snapshot" in registration);
  } finally { await lifecycle.stop(); }
});

test("bridge timestamps retention and snapshot output cursor/truncation metadata", () => {
  const bridge=createMonitorSessionBridge({now:()=>new Date("2026-01-08T00:00:00Z")});
  assert.equal(typeof bridge.prune,"function","bridge must apply seven-day/200 retention");
  assert.equal(typeof bridge.readOutput,"function","bridge must expose cursor output to UDS");
});

test("native owned cancellation waits for fake exit before publishing cancelled and never exposes workspace close", async () => {
  const bridge=createMonitorSessionBridge({createOwnedHandleRegistry:()=>({})});
  assert.equal(typeof bridge.registerOwnedProcess,"function");
  assert.equal(typeof bridge.cancelOwnedProcess,"function","bridge must own native TERM/wait/revalidate/KILL cancellation");
  assert.equal("workspaceClose" in bridge,false);
});

test("index keeps local operator cancellation independent from optional monitor bookkeeping", () => {
  const source=readFileSync(new URL("./index.ts",import.meta.url),"utf8");
  assert.match(source,/cancelLocalOwnedProcess\(\{/);
  assert.match(source,/cancelLocalWaitOnly\(\{/);
});

test("registry persists owner-only profile discovery metadata with relative socket/token references and restart lease", () => {
  const root=mkdtempSync(join(tmpdir(),"monitor-discovery-")); const profile=join(root,"profile"); mkdirSync(profile);
  const registration=new MonitorRegistry({runtimeDir:join(root,"runtime")}).register({profilePath:profile,hubInstanceId:"hub",snapshot:()=>({})}) as any;
  assert.ok(registration.discoveryPath,"registry must publish owner-only discovery metadata");
  const discovery=JSON.parse(readFileSync(registration.discoveryPath,"utf8"));
  assert.deepEqual(Object.keys(discovery).sort(),["lease","owner","socket","token"]);
  assert.equal(discovery.socket.startsWith("/"),false);
  assert.equal(discovery.token.includes(registration.token),false);
});
