// Setup-only human-owned v2 configuration planning. No inference or implicit consent.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { loadSystem1Snapshot } from '../../.pi/harnesses/lib/system1/config-loader.js';
import { TASK_TRIAGE_LIMITS, TASK_TRIAGE_QUESTION_VERSION, TASK_TRIAGE_POLICY_VERSION } from '../../.pi/harnesses/lib/system1/config-triage.js';
import { assertSafeWorkspaceTarget } from './workspace-safety.js';
const SECTION = Object.freeze({mode:'experimental',remoteContextApproved:true,questionVersion:TASK_TRIAGE_QUESTION_VERSION,policyVersion:TASK_TRIAGE_POLICY_VERSION,limits:TASK_TRIAGE_LIMITS});
function inspect(workspace, sharedSnapshot) {
 const path=assertSafeWorkspaceTarget(workspace,'.ai/system1.json',{allowLeafSymlink:false});
 return {path,snapshot:sharedSnapshot ?? loadSystem1Snapshot(workspace)};
}
export function planTaskTriageConfig(workspace, sharedSnapshot) {
 const {path,snapshot}=inspect(workspace, sharedSnapshot);
 if(snapshot.status==='missing') {
  for (const legacy of ['proactive-review.json','dispatch-triage.json','task-triage.json']) {
   try { lstatSync(join(workspace,'.ai',legacy)); return {path,write:false,preserved:true,alreadyApproved:false,status:'migration_required'}; }
   catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const target={version:2,mode:'auto',provider:'typesafe',model:'jev-1.13.0',apiKeyEnv:'TYPESAFE_API_KEY',consumers:{taskTriage:SECTION}};
  return {path,write:true,text:JSON.stringify(target,null,2)+'\n',alreadyApproved:false,status:'missing'};
 }
 if(snapshot.status==='migration_required'||snapshot.status==='invalid')return {path,write:false,preserved:true,alreadyApproved:false,status:snapshot.status};
 const section=snapshot.consumers.taskTriage;
 const raw=snapshot.document.consumers.taskTriage;
 let status=section.status==='invalid'?'invalid':!raw?'missing':raw.mode==='off'?'off':!raw.remoteContextApproved?'unapproved':'active';
 // Missing section can be proposed, but existing sections and provider mode remain human-owned.
 if(!raw && !snapshot.errors.length) {
  const target={...snapshot.document,consumers:{...snapshot.document.consumers,taskTriage:SECTION}};
  return {path,write:true,text:JSON.stringify(target,null,2)+'\n',formattingChanged:true,changes:{addedTaskTriage:SECTION,rootModePreserved:snapshot.document.mode,existingConsumerPoliciesPreserved:true},alreadyApproved:false,status};
 }
 return {path,write:false,preserved:true,alreadyApproved:status==='active',status};
}
export function planTaskTriageProviderConfig(workspace) {
 const {path,snapshot}=inspect(workspace);
 return {path,write:false,preserved:true,status:snapshot.status};
}
