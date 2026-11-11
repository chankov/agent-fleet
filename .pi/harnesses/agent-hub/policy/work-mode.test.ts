import assert from "node:assert/strict";
import test from "node:test";
import { createWorkModePolicy } from "./work-mode.ts";
import { createContextPressureLifecycle, createContextPressureRootState } from "../lifecycle/context-pressure.ts";

function fixture(rosterSize = 1, _fallbackRosterSize = 0, pendingOperations: any[] = []) {
	let activeTools: string[] = []; const entries: [string, unknown][] = []; const catalogChanges: any[] = [];
	const policy = createWorkModePolicy({
		getBaselineTools: () => ["read", "edit"], getRosterSize: () => rosterSize, getActiveTeamName: () => rosterSize ? "default" : "",
		getComsReady: () => false, getHerdrReady: () => false, getAskUserAvailable: () => true, getIdentityLabel: () => null,
		getTaskTier: () => "feature", getPendingOperations: () => pendingOperations, getContextState: () => "normal",
		getActiveTools: () => activeTools, setActiveTools: tools => { activeTools = tools; }, recordToolCatalog: change => catalogChanges.push(change), persist: (type, data) => entries.push([type, data]),
	});
	const notices: [string, string][] = [];
	const ctx = { hasUI: true, ui: { notify: (message: string, level: string) => notices.push([message, level]), setStatus: () => {} } } as any;
	return { policy, ctx, notices, entries, catalogChanges, tools: () => activeTools };
}

test("the Hub has one work mode: the operator keeps direct tools and its fleet, with no switching surface", () => {
	const f = fixture(0);
	assert.equal(f.policy.getWorkMode(), "operator");
	f.policy.resolveIncomingCapabilities("");
	f.policy.applyWorkModeTools();
	for (const tool of ["read", "edit", "dispatch_agent", "spawn_research", "poll_panel"]) assert.ok(f.tools().includes(tool), tool);
	assert.equal(f.catalogChanges.at(-1).toMode, "operator");
	assert.match(f.policy.statusText(), /Work Mode: operator\nDirect tools: enabled/);
	for (const removed of ["commit", "applySelection", "openPicker", "setRestoredWorkMode", "modelWorkBlockedByRosterRecovery"]) assert.equal((f.policy as any)[removed], undefined, removed);
	assert.equal(f.entries.some(([type]) => type === "agent-hub-work-mode"), false, "nothing persists a work-mode switch");
});

test("pending operation leases keep fleet active beside the operator's direct tools", () => {
	const f = fixture(1, 0, [{ pack: "fleet", kind: "dispatch" }]);
	f.policy.resolveIncomingCapabilities("");
	f.policy.applyWorkModeTools();
	assert.equal(f.policy.getCapabilityResolution().reasons.fleet, "pending-operation");
	assert.ok(f.tools().includes("dispatch_agent") && f.tools().includes("edit"));
});

test("low-pressure lifecycle refresh keeps explicit compaction until a different user request", () => {
 const f=fixture();const root=createContextPressureRootState();
 const ctx:any={hasUI:false,model:{contextWindow:64000},getContextUsage:()=>({tokens:1000,contextWindow:64000,percent:1.5625}),ui:{setStatus(){},notify(){}},isIdle:()=>true};
 const lifecycle=createContextPressureLifecycle({getState:()=>root,setPressure:p=>{root.pressure=p;},getCurrentContext:()=>ctx,appendEntry(){},sendUserMessage(){},resolveCapabilities:f.policy.resolveIncomingCapabilities,applyWorkMode:f.policy.applyWorkModeTools,modelWorkBlocked:()=>false});
 lifecycle.input({source:"interactive",text:"Read README, then use request_compaction."},ctx);
 assert.ok(f.tools().includes("request_compaction"));
 lifecycle.messageEnd({message:{role:"toolResult",content:[]}},ctx);
 lifecycle.turnEnd(ctx);
 assert.ok(f.tools().includes("request_compaction"));
 assert.equal(f.policy.getCapabilityResolution().reasons.compaction,"explicit-compaction");
 assert.ok(!f.policy.getCapabilityResolution().nextTaskPacks.includes("compaction"));
 lifecycle.input({source:"interactive",text:"Explain the parser."},ctx);
 lifecycle.turnEnd(ctx);
 assert.ok(!f.tools().includes("request_compaction"));
});

test("assessment refresh retains only current explicit compaction, not a permanent task pack", () => {
	const f = fixture();
	f.policy.resolveIncomingCapabilities("Please compact the conversation.");
	assert.equal(f.policy.getCapabilityResolution().reasons.compaction, "explicit-compaction");
	f.policy.refreshCapabilities();
	assert.ok(f.policy.getCapabilityResolution().active.includes("compaction"));
	assert.ok(!f.policy.getCapabilityResolution().nextTaskPacks.includes("compaction"));
	assert.ok(!JSON.stringify(f.entries).includes("Please compact"), "refresh never retains raw task text");
	f.policy.resolveIncomingCapabilities("Explain the parser.");
	f.policy.refreshCapabilities();
	assert.ok(!f.policy.getCapabilityResolution().active.includes("compaction"));
});

test("assessment refresh cannot turn a declined provisional pack into permission", () => {
	const f = fixture();
	f.policy.resolveIncomingCapabilities("Please compact the conversation; someone else to handle this");
	f.policy.setCapabilityConfirmation("fleet", "declined");
	f.policy.refreshCapabilities();
	assert.equal(f.policy.getCapabilityConfirmation().fleet, "declined");
	// The operator always holds fleet tools, but a human decline recorded for this
	// task (e.g. from an older session) still gates every fleet side effect.
	assert.equal(f.policy.provisionalCapabilityRefusal("fleet")?.details.confirmation, "declined");
	assert.ok(f.policy.getCapabilityResolution().active.includes("compaction"));
	assert.ok(f.policy.getCapabilityResolution().active.includes("fleet"));
});

test("assessment refresh does not restore explicit compaction from old persisted active state", () => {
	const f = fixture();
	f.policy.resolveIncomingCapabilities("Please compact the conversation.");
	f.policy.resetCapabilities();
	f.policy.restoreCapabilities({ taskPacks: [], provisional: [], confirmation: {} });
	f.policy.refreshCapabilities();
	assert.ok(!f.policy.getCapabilityResolution().active.includes("compaction"));
});

test("ambiguous delegation needs no confirmation because the operator holds fleet; leases keep packs active", () => {
	const f = fixture();
	f.policy.resolveIncomingCapabilities("someone else to handle this");
	assert.ok(!f.policy.getCapabilityResolution().provisional.includes("fleet"));
	assert.ok(f.policy.getCapabilityResolution().active.includes("fleet"));
	assert.equal(f.policy.provisionalCapabilityRefusal("fleet"), null);
	f.policy.resolveIncomingCapabilities("");
	assert.ok(f.policy.getCapabilityResolution().active.includes("fleet"));
	assert.equal(f.policy.provisionalCapabilityRefusal("fleet"), null);
});

test("capability journal records initial state and changes, not repeated refreshes", () => {
 const f=fixture();
 f.policy.resolveIncomingCapabilities("");
 const initial=f.entries.length;
 for(let i=0;i<100;i++)f.policy.refreshCapabilities();
 // The first refresh may change an activation reason to task-retained.
 const settled=f.entries.length;
 for(let i=0;i<100;i++)f.policy.refreshCapabilities();
 assert.equal(f.entries.length,settled);
 assert.ok(settled <= initial+1);
 f.policy.setCapabilityConfirmation("fleet","declined");
 f.policy.refreshCapabilities();
 assert.equal(f.entries.length,settled+1);
 f.policy.resetCapabilities();
 f.policy.resolveIncomingCapabilities("");
 assert.equal(f.entries.length,settled+2);
});
