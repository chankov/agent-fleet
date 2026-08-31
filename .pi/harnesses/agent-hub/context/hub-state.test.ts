import assert from "node:assert/strict";
import test from "node:test";
import { createHubStateContext } from "./hub-state.ts";

test("Hub state context forwards typed access without owning mutable state", () => {
	let current: any = null;
	let exemptions: string | null = null;
	let sessionDir = "";
	let widget: any = null;
	let handoff: { target: string; token: string } | null = null;
	const context = createHubStateContext({
		getCurrentContext: () => current, setCurrentContext: value => { current = value; },
		getExemptionsFile: () => exemptions, setExemptionsFile: value => { exemptions = value; },
		getSessionDir: () => sessionDir, setSessionDir: value => { sessionDir = value; },
		getWidgetContext: () => widget, setWidgetContext: value => { widget = value; },
		getPendingHandoff: () => handoff, setPendingHandoff: value => { handoff = value; },
	});
	const extensionContext = { cwd: "/repo" } as any;
	context.setCurrentContext(extensionContext);
	context.setExemptionsFile("/tmp/exemptions");
	context.setSessionDir("/repo/.pi/agent-sessions");
	context.setWidgetContext({ ui: true });
	context.setPendingHandoff({ target: "peer", token: "secret" });
	assert.equal(context.getCurrentContext(), extensionContext);
	assert.equal(context.getExemptionsFile(), "/tmp/exemptions");
	assert.equal(context.getSessionDir(), "/repo/.pi/agent-sessions");
	assert.deepEqual(context.getWidgetContext(), { ui: true });
	assert.deepEqual(context.getPendingHandoff(), { target: "peer", token: "secret" });
});
