import test from 'node:test'; import assert from 'node:assert/strict';
import { parseTriageConfig, parseTaskTriageConfig, TASK_TRIAGE_LIMITS } from './config-triage.js';
test('triage strict fields and pinned policy',()=>{
 const dispatch={version:1,mode:'advisory',remoteContextApproved:true,maxCalls:20,maxStateBytes:20000,maxTaskBytes:10000,maxRoleBytes:5000,orchestratorBeforeDispatch:true};
 assert.deepEqual(parseTriageConfig(dispatch),dispatch);
 assert.equal(parseTriageConfig({...dispatch,unknown:1}),null);
 const task={version:1,mode:'experimental',remoteContextApproved:true,provider:'typesafe',model:'jev-1.13.0',questionVersion:'task-triage/questions/v1',policyVersion:'task-triage/policy/v1',limits:TASK_TRIAGE_LIMITS};
 assert.equal(parseTaskTriageConfig(task).status,'active');
 assert.equal(parseTaskTriageConfig({...task,limits:{...task.limits,maxCallsPerSession:101}}).status,'invalid');
});
