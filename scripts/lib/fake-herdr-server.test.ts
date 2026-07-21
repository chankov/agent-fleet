import test from "node:test";
import assert from "node:assert/strict";
import { request } from "../../.pi/harnesses/lib/herdr-client.ts";
import { FakeHerdrServer } from "./fake-herdr-server.ts";

test("fake Herdr serves pane.get over its explicit disposable Unix socket", async () => {
	const fake = await FakeHerdrServer.start({ paneId: "hub-pane", workspaceId: "workspace" });
	try {
		const result = await request<{ pane: { pane_id: string; workspace_id: string } }>("pane.get", { pane_id: "hub-pane" }, { socketPath: fake.socketPath });
		assert.equal(result.pane.pane_id, "hub-pane");
		assert.equal(result.pane.workspace_id, "workspace");
		assert.deepEqual(fake.requests.map(({ method, params }) => ({ method, params })), [{ method: "pane.get", params: { pane_id: "hub-pane" } }]);
		assert.match(fake.socketPath, /^\/tmp\/fake-herdr-/);
	} finally {
		await fake.close();
	}
});
