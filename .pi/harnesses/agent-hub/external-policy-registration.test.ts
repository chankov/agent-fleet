import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { resolvePolicyReferences, resolvePolicyRoots } from "../lib/policy-roots.ts";
import { buildProjectDocsProtocol, buildProjectRulesProtocol, buildSpecialistContextManifest, nativeResearchSystemPrompt, nativeSpecialistSystemPrompt } from "../lib/context-budget-child-prompt.ts";
import { adaptDiscovery } from "./file-discovery/adapters.ts";
import { discoverCandidates } from "./file-discovery/discovery.ts";
import { createDiscoveryRuntime } from "./file-discovery/runtime.ts";
import { parseFileDiscoveryConfig } from "../lib/system1/config-file-discovery.js";

const piEntry=import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadPromptTemplates,expandPromptTemplate }=await import(new URL([".","core","prompt-templates.js"].join("/"),piEntry).href);
function fixture(t: test.TestContext) {
 const base=mkdtempSync(join(tmpdir(),"fleet-external-registration-"));
 t.after(()=>rmSync(base,{recursive:true,force:true}));
 const cwd=join(base,"code"),docs=join(base,"docs"),agentDir=join(base,"agent");
 mkdirSync(join(cwd,".pi/prompts"),{recursive:true});mkdirSync(join(docs,".ai/commands"),{recursive:true});mkdirSync(join(docs,".ai/codex-skills/external-test"),{recursive:true});mkdirSync(agentDir);
 writeFileSync(join(docs,"README.md"),"# External docs\n");
 return {base,cwd,docs,agentDir};
}

test("read grants do not register resources; explicit skill registration and thin local command adapter preserve external sources",t=>{
 const {base,cwd,docs,agentDir}=fixture(t);
 const source=join(docs,".ai/commands/audit.md"),skill=join(docs,".ai/codex-skills/external-test/SKILL.md"),marker=join(base,"EXECUTED");
 writeFileSync(source,"# External audit\nUse the reviewed project workflow.\n");
 writeFileSync(skill,"---\nname: external-test\ndescription: Test explicit external registration. Use when asked for an external audit.\n---\nRead ../../commands/audit.md before work.\n");
 mkdirSync(join(docs,".ai/codex-skills/external-test/scripts"));
 writeFileSync(join(docs,".ai/codex-skills/external-test/scripts/marker.sh"),`#!/bin/bash\ntouch ${marker}\n`,{mode:0o700});
 const table=resolvePolicyRoots(cwd,{docsPaths:["../docs"]});
 assert.equal(table.roots.length,2);
 assert.equal(loadSkills({cwd,agentDir,skillPaths:[],includeDefaults:true}).skills.length,0);
 assert.equal(loadPromptTemplates({cwd,agentDir,promptPaths:[],includeDefaults:true}).length,0);
 const registered=loadSkills({cwd,agentDir,skillPaths:[skill],includeDefaults:false});
 assert.equal(registered.skills.length,1);assert.equal(registered.skills[0]!.filePath,skill);
 const target=resolvePolicyReferences(table,["../docs/.ai/commands/audit.md"],"docs")[0]!;
 writeFileSync(join(cwd,".pi/prompts/project-audit.md"),`---\ndescription: External project audit adapter\n---\nRead ${target} and follow it for this request: $ARGUMENTS\n`);
 const prompts=loadPromptTemplates({cwd,agentDir,promptPaths:[],includeDefaults:true});
 const expanded=expandPromptTemplate("/project-audit docs",prompts);
 assert.ok(expanded.includes(target));assert.ok(expanded.includes("request: docs"));
 assert.equal(existsSync(marker),false,"resource discovery/expansion must not execute skill scripts");
 assert.equal(existsSync(join(cwd,".ai/commands/audit.md")),false);
 assert.equal(readFileSync(source,"utf8"),"# External audit\nUse the reviewed project workflow.\n");
});

test("specialist, research and shared delegate/coms protocols retain canonical references under nested cwd",t=>{
 const {cwd,docs}=fixture(t);mkdirSync(join(docs,"rules"));mkdirSync(join(cwd,"nested"));
 const table=resolvePolicyRoots(cwd,{rulesDirs:["../docs/rules"],docsPaths:["../docs/README.md"]});
 const policy={rulesPaths:resolvePolicyReferences(table,["../docs/rules"],"rules"),docsPaths:resolvePolicyReferences(table,["../docs/README.md"],"docs")};
 const manifest=buildSpecialistContextManifest({personaName:"builder",personaPath:"agents/builder.md",personaPrompt:"",task:"task",...policy,hasAssertions:false,hasScope:false,hasArtifacts:false,delegateRoles:["recon"]});
 const rendered=[nativeSpecialistSystemPrompt({manifest,userLanguage:"Bulgarian",agentKey:"builder",runNumber:1}),nativeResearchSystemPrompt({cwd:join(cwd,"nested"),...policy}),buildProjectRulesProtocol(policy.rulesPaths)+buildProjectDocsProtocol(policy.docsPaths)];
 for(const prompt of rendered){assert.ok(prompt.includes(join(docs,"rules")));assert.ok(prompt.includes(join(docs,"README.md")));assert.ok(!prompt.includes("../docs"));}
});

test("file-discovery adapters, discovery and runtime retain separate export consent despite external read grants",async t=>{
 const {cwd,docs}=fixture(t);mkdirSync(join(cwd,"local-docs"));
 const source=join(docs,"README.md");
 resolvePolicyRoots(cwd,{docsPaths:["../docs"]});
 const adapted=adaptDiscovery({tool:"filesystem",args:{path:docs,operation:"inventory"},result:{details:{result:{root:docs,totalEntries:1,truncated:false,entries:[{name:"README.md",path:source,type:"file"}]}}},cwd,root:cwd,include:["local-docs"]});
 assert.equal(adapted.discoveryComplete,false);assert.deepEqual(adapted.paths,[]);
 const config=parseFileDiscoveryConfig({mode:"active",remoteContextApproved:true,include:["local-docs"]});
 assert.throws(()=>parseFileDiscoveryConfig({...config,include:["../docs"]}));
 let traversals=0,calls=0;
 const discovered=await discoverCandidates({root:cwd,cwd,config,paths:[source],directories:[docs],patterns:["*.md"],signal:new AbortController().signal,canDiscover:()=>true,runFind:async()=>{traversals++;return {ok:false,reason:"unavailable"};}});
 assert.deepEqual(discovered.paths,[]);assert.equal(traversals,0);
 const runtime=createDiscoveryRuntime({root:cwd,sessionId:"s",config,context:()=>"task",persist(){},service:{evaluate:async()=>{calls++;return {status:"unavailable",reason:"network"};}}});
 t.after(()=>runtime.dispose());
 const result=await runtime.rank({owner:"hub",paths:["../docs/README.md"],task:"task",query:"docs",discoveryComplete:true,canDisplay:()=>true,canRead:()=>true,permissionIdentity:()=>"read-only-policy"});
 assert.equal(calls,0);assert.ok(result.rows.every(row=>row.status==="unscored"));
});
