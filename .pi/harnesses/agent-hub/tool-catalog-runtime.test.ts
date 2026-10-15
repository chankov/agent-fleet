import test from "node:test";
import assert from "node:assert/strict";
import { createToolCatalogRuntime } from "./tool-catalog-runtime.ts";
import { catalogSnapshot } from "./tool-catalog-state.ts";

test("catalog persists initial snapshot and mode/tool changes; restore resets and failures retry",()=>{
 const runtime=createToolCatalogRuntime(catalogSnapshot("operator",["read"]));
 const entries:any[]=[];
 const persist=(...args:any[])=>{entries.push(args);};
 const refresh=(mode:"operator"|"orchestrator",tools:string[])=>{
  const previous=runtime.current();
  const result=runtime.reconcile({fromMode:previous.mode,toMode:mode,previous:previous.tools,next:tools});
  return runtime.persist(result,persist,"refresh");
 };
 assert.equal(refresh("operator",["read"]),true);
 assert.equal(refresh("operator",["read","read"]),false);
 assert.equal(refresh("orchestrator",["read"]),true);
 assert.equal(refresh("orchestrator",["read","grep"]),true);
 assert.equal(entries.length,3);
 runtime.restore(runtime.current());
 assert.equal(refresh("orchestrator",["grep","read"]),true);
 const result=runtime.reconcile({fromMode:"orchestrator",toMode:"operator",previous:["read","grep"],next:["read"]});
 assert.throws(()=>runtime.persist(result,()=>{throw new Error("disk");},"refresh"));
 assert.equal(runtime.persist(result,persist,"refresh"),true);
});
