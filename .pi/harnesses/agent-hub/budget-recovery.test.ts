import assert from "node:assert/strict";
import test from "node:test";
import { confirmTaskSupersession, consumeReservedTaskId, createReservedTaskIdentityReset, reserveActualTaskId } from "./budget-recovery.ts";
import { createNoProgressGuard, RECOVER_ENTRY } from "./no-progress.ts";

const yes = async (id: string, params: any) => ({ details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [params.options[0]] } } });

function supersessionPorts(answer: (id: string, params: any) => Promise<unknown>, currentTaskId = "old-task") {
	const asks: Array<{ id: string; params: any }> = [];
	return {
		asks,
		ports: {
			language: () => "English",
			ask: async (id: string, params: any) => { asks.push({ id, params }); return answer(id, params); },
			startWait() {}, endWait() {},
			currentTaskId: () => currentTaskId,
		},
	};
}

test("confirmTaskSupersession grants only a current correlated yes with exact old and reserved new ids", async () => {
	const reserved = reserveActualTaskId();
	const f = supersessionPorts((id, params) => yes(id, params));
	const ok = await confirmTaskSupersession({ oldTaskId: "old-task", newTaskId: reserved, reason: "different work" }, { ui: { notify() {} } } as any, f.ports);
	assert.equal(ok, true);
	assert.match(f.asks[0].params.context, new RegExp(`old-task → ${reserved}`));
	assert.match(f.asks[0].params.context, /operation:supersede/);
	assert.doesNotMatch(f.asks[0].params.context, /pending:/);
	assert.equal(f.asks[0].params.allowMultiple, false);
	assert.equal(f.asks[0].params.allowFreeform, false);
	assert.equal(consumeReservedTaskId(reserved), true);
	assert.equal(consumeReservedTaskId(reserved), false);
});

for (const [name, answer] of [
	["stale request id", async (_id: string, params: any) => yes("other-request", params)],
	["cancel", async () => ({ details: { cancelled: true } })],
	["unanswered", async () => ({ details: {} })],
	["duplicate options", async (id: string, params: any) => ({ details: { runtimeAsk: { requestId: id }, response: { kind: "selection", selections: [params.options[0], params.options[0]] } } })],
] as const) {
	test(`confirmTaskSupersession ${name} grants nothing`, async () => {
		const f = supersessionPorts(answer);
		assert.equal(await confirmTaskSupersession({ oldTaskId: "old-task", newTaskId: reserveActualTaskId(), reason: "x" }, {} as any, f.ports), false);
	});
}

test("confirmTaskSupersession other-task current id cannot reset old obligations", async () => {
	const f = supersessionPorts((id, params) => yes(id, params), "other-task");
	assert.equal(await confirmTaskSupersession({ oldTaskId: "old-task", newTaskId: reserveActualTaskId(), reason: "x" }, {} as any, f.ports), false);
});

test("reserved task identity reset gives the no-progress guard the approved UUID", () => {
 let progressId = "old-progress";
 const progress = { adopt: (id: string) => { progressId = id; }, reset: () => { progressId = "random-progress"; } };
 const coordinator = createReservedTaskIdentityReset(progress);
 const approved = reserveActualTaskId();
 coordinator.run(approved, () => { progress.reset(); });
 assert.equal(progressId, approved);
});

test("wrapped no-progress reset forwards persistence choice without changing default or reserved adoption", () => {
 const saved: Array<{ type: string; data: any }> = [];
 const progress = createNoProgressGuard((type, data) => saved.push({ type, data }));
 const coordinator = createReservedTaskIdentityReset(progress);
 const taskRows = () => saved.filter(row => row.type === RECOVER_ENTRY && row.data?.kind === "guard" && row.data.event?.type === "task");
 progress.reset(false);
 assert.equal(taskRows().length, 0, "startup reset(false) must not persist a new task row");
 progress.reset();
 assert.equal(taskRows().length, 1, "ordinary reset still persists its new identity");
 assert.equal(taskRows()[0].data.event.taskId, progress.taskId());
 const approved = reserveActualTaskId();
 coordinator.run(approved, () => { progress.reset(false); });
 assert.equal(progress.taskId(), approved);
 assert.equal(taskRows().length, 2, "reserved transition still persists its approved identity");
 assert.equal(taskRows()[1].data.event.taskId, approved);
});

test("reserved task identity reset clears its candidate after cancellation or exception", () => {
 let progressId = "old-progress";
 const progress = { adopt: (id: string) => { progressId = id; }, reset: () => { progressId = "unrelated-progress"; } };
 const coordinator = createReservedTaskIdentityReset(progress);
 const approved = reserveActualTaskId();
 assert.throws(() => coordinator.run(approved, () => { throw new Error("reset failed"); }), /reset failed/);
 progress.reset();
 assert.equal(progressId, "unrelated-progress");
});
