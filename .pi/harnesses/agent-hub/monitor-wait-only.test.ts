import test from "node:test";
import assert from "node:assert/strict";
import { createMonitorSessionBridge } from "./monitor-session-bridge.ts";
test("wait-only coms cancellation transitions locally and late completion remains bounded history",async()=>{const bridge:any=createMonitorSessionBridge();bridge.startParent({id:"parent",generation:1,hubInstanceId:"hub",checkoutId:"checkout"});await bridge.startChild({key:"coms",id:"child",generation:1,parentId:"parent",specialist:"qa"},{});const cancelled=await bridge.cancelWaitOnly("coms",{kind:"wait_abort"});assert.equal(cancelled.state,"cancelled");const late=await bridge.finishChild("coms","completed");assert.equal(late.state,"cancelled");assert.equal(late.history.at(-1).kind,"late_finish");});
