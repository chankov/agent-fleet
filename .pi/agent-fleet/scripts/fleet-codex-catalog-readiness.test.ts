import test from 'node:test';
import assert from 'node:assert/strict';
import {TOOLS,assessLoadedFleetCatalog} from './lib/fleet-codex-local-mcp.ts';
const fresh={identity:'host_context_validated',nodeVersion:'25.2.1',protocolVersion:'2025-06-18',tools:TOOLS.map(t=>({name:t.name}))};
test('loaded 21 tools cannot masquerade as source 24; assessment never reloads or grants',()=>{
 const observed={...fresh,tools:fresh.tools.slice(0,21)};
 const result=assessLoadedFleetCatalog(observed);
 assert.equal(result.ready,false);assert.equal(result.loadedCount,21);assert.equal(result.sourceCount,24);
 assert.deepEqual(result.missing,['fleet_permissions','fleet_permission_decide','fleet_permission_receipt']);
 assert.equal(result.action,'operator_reload_required_not_performed');
 assert.equal(assessLoadedFleetCatalog(fresh).ready,true);
 assert.equal(assessLoadedFleetCatalog({...fresh,identity:'unknown'}).ready,false);
 assert.equal(assessLoadedFleetCatalog({...fresh,tools:[...fresh.tools,fresh.tools[0]]}).ready,false);
});
