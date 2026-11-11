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
  for(const version of ["1.1.0","1.2.0","1.3.0","0.84.2","1.1.1","1.5.2"]) {
   writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"@earendil-works/pi-coding-agent",version}));
   assert.equal(currentPiRuntimeVersion(launcher),version);
   assert.equal(currentPiRuntimeVersion(chain),version);
   assert.equal(contextContinuityCompatibility(currentPiRuntimeVersion(launcher)).supported,version!=="0.84.2");
  }
  writeFileSync(join(pkg,"package.json"),JSON.stringify({name:"other-package",version:"1.1.0"}));
  assert.equal(currentPiRuntimeVersion(launcher),"unknown");
  symlinkSync("missing",join(dir,"bin/dangling"));assert.equal(currentPiRuntimeVersion(join(dir,"bin/dangling")),"unknown");
  assert.equal(currentPiRuntimeVersion(join(dir,"missing")),"unknown");
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("minimum-version gate admits later releases; legacy/unknown/non-plain preserve baseline",()=>{
  for(const version of ["1.1.0","1.1.1","1.2.0","1.3.0","1.3.1","1.4.0","1.5.2","1.10.0","2.0.0"]) {
    assert.equal(contextContinuityCompatibility(version).supported,true,version);
    assert.match(contextContinuityCompatibility(version).reason,/minimum 1\.1\.0/);
  }
  for(const version of ["1.0.9","0.84.2","0.99.99","unknown","1.1.0-custom","2.0.0-beta.1","1.5","v1.5.2",""]) {
    assert.equal(contextContinuityCompatibility(version).supported,false,version);
    assert.match(contextContinuityCompatibility(version).reason,/baseline/);
  }
});
