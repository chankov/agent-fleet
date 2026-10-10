import test from "node:test";
import assert from "node:assert/strict";
import { contextContinuityCompatibility, currentPiRuntimeVersion } from "./context-continuity-compat.ts";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("symlink launchers resolve the runtime package without trusting unknown or legacy versions", () => {
 const dir=mkdtempSync(join(tmpdir(),"d7-compat-"));
 try {
  const pkg=join(dir,"runtime");mkdirSync(join(pkg,"dist/bundle"),{recursive:true});mkdirSync(join(dir,"bin"));
  const entry=join(pkg,"dist/bundle/cli.js");writeFileSync(entry,"// fixture");
  const launcher=join(dir,"bin/pi");symlinkSync("../runtime/dist/bundle/cli.js",launcher);
  const chain=join(dir,"bin/pi-chain");symlinkSync("pi",chain);
  for(const version of ["1.1.0","0.84.2","1.1.1"]) {
   writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"@earendil-works/pi-coding-agent",version}));
   assert.equal(currentPiRuntimeVersion(launcher),version);
   assert.equal(currentPiRuntimeVersion(chain),version);
   assert.equal(contextContinuityCompatibility(currentPiRuntimeVersion(launcher)).supported,version==="1.1.0");
  }
  writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"other-package",version:"1.1.0"}));
  assert.equal(currentPiRuntimeVersion(launcher),"unknown");
  symlinkSync("missing",join(dir,"bin/dangling"));assert.equal(currentPiRuntimeVersion(join(dir,"bin/dangling")),"unknown");
  assert.equal(currentPiRuntimeVersion(join(dir,"missing")),"unknown");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("only exact verified candidate runtime is accepted; legacy/unknown preserve baseline",()=>{
  assert.equal(contextContinuityCompatibility("1.1.0").supported,true);
  for(const version of ["0.84.2","unknown","1.1.1","1.1.0-custom",""]) {
    assert.equal(contextContinuityCompatibility(version).supported,false);
    assert.match(contextContinuityCompatibility(version).reason,/baseline/);
  }
});
