import test from "node:test";
import assert from "node:assert/strict";
import { createToolCatalogRuntime } from "./tool-catalog-runtime.ts";
import { catalogSnapshot } from "./tool-catalog-state.ts";
import { createUnknownToolCounter, observeUnknownToolCalls } from "./unknown-tool-counter.ts";

// rankedin, 2026-11-12: one agent run lasted an hour. set_task_tier activated the
// fleet tools 14 s after the run started, but every later dispatch_agent call was
// judged against the catalog latched at run start, counted as an unknown tool, and
// after three calls the operator was told not to retry dispatch_agent at all.
test("a tool activated during an agent run is known from the next model request; a withdrawn one is not", () => {
	const runtime = createToolCatalogRuntime(catalogSnapshot("operator", ["read", "set_task_tier"]));
	const counter = createUnknownToolCounter({ limit: 3 });
	const seenCallIds = new Set<string>();
	const call = (id: string, name: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: {} }] });
	const observe = (id: string, name: string) => observeUnknownToolCalls({ message: call(id, name), catalog: runtime.catalogForMessage(), taskId: "t1", counter, seenCallIds });
	const change = (tools: string[]) => { const previous = runtime.current(); runtime.reconcile({ fromMode: previous.mode, toMode: "operator", previous: previous.tools, next: tools }); };

	runtime.beginTurn(); // before_agent_start
	runtime.beginModelRequest(); // turn_start: first model request
	assert.deepEqual(observe("c1", "set_task_tier"), []);
	change(["read", "set_task_tier", "dispatch_agent"]); // set_task_tier activates the fleet tools
	runtime.beginModelRequest(); // turn_start: next model request in the same run
	assert.deepEqual(observe("c2", "dispatch_agent"), [], "the model was offered dispatch_agent for this request");

	change(["read", "set_task_tier"]); // withdrawn mid-run
	runtime.beginModelRequest();
	const refused = observe("c3", "dispatch_agent");
	assert.equal(refused.length, 1, "a call to a tool the request no longer declares is still unknown");
	assert.equal(refused[0].tool, "dispatch_agent");
	runtime.endTurn();
});

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
