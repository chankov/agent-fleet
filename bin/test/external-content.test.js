import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyAcceptedProjectFiles, classifyProjectFile, readProjectProvenance } from "../lib/project-provenance.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { transactionRecovery, recoverTransaction } from "../lib/transaction.js";
function fixture(t) {
 const base=mkdtempSync(join(tmpdir(),"external-content-"));t.after(()=>rmSync(base,{recursive:true,force:true}));
 const workspace=join(base,"code"),root=join(base,"docs");mkdirSync(workspace);mkdirSync(root);
 const contentDestination={root,acceptedDecision:"maintainer reviewed destination",evidence:["chat:destination-1"]};
 const change={path:".ai/rules/docs/maintenance.md",source:{origin:"repo-derived"},evidence:["repo:docs"],acceptedDecision:"accepted rule",accepted:true,adopt:true,content:"# Rule\n"};
 return {workspace,root,contentDestination,change};
}
test("explicit external destination retains local provenance, adoption, conflicts and no-op generation",t=>{
 const f=fixture(t);
 applyAcceptedProjectFiles({...f,changes:[f.change]});
 assert.equal(readFileSync(join(f.root,f.change.path),"utf8"),f.change.content);
 assert.equal(existsSync(join(f.workspace,f.change.path)),false);
 const provenance=readProjectProvenance(f.workspace);
 assert.equal(provenance.status,"valid");assert.equal(provenance.state.entries[f.change.path].contentDestination.root,f.root);
 assert.equal(classifyProjectFile({...f,...f.change}).status,"unchanged");
 assert.deepEqual(applyAcceptedProjectFiles({...f,changes:[{...f.change,content:undefined}],generateContent:()=>{throw Error("unexpected generation");}}),{changed:false});
 writeFileSync(join(f.root,f.change.path),"human edit");
 assert.equal(classifyProjectFile({...f,...f.change}).status,"local-edit");
 assert.throws(()=>applyAcceptedProjectFiles({...f,changes:[{...f.change,adopt:false}]}),/adoption|reconciliation/);
 assert.throws(()=>applyAcceptedProjectFiles({...f,contentDestination:undefined,changes:[f.change]}),/destination/);
 assert.equal(readFileSync(join(f.root,f.change.path),"utf8"),"human edit");
});
test("external and local content plus sidecar roll back together on interruption",t=>{
 const f=fixture(t);applyAcceptedProjectFiles({...f,changes:[f.change]});
 const sidecar=readFileSync(join(f.workspace,".ai/agent-fleet-ai-state.json"));
 assert.throws(()=>applyAcceptedProjectFiles({...f,changes:[{...f.change,requestChange:true,content:"replacement"}],failAt:"after-commit"}),/interruption/);
 assert.equal(readFileSync(join(f.root,f.change.path),"utf8"),f.change.content);
 assert.deepEqual(readFileSync(join(f.workspace,".ai/agent-fleet-ai-state.json")),sidecar);
 assert.equal(transactionRecovery(f.workspace).pending,false);
 assert.throws(()=>applyAcceptedProjectFiles({...f,changes:[{...f.change,path:".ai/commands/new.md"}],failAt:"after-journal"}),/interruption/);
 assert.equal(existsSync(join(f.root,".ai/commands/new.md")),false);
});
test("durably committed external transaction cleanup recovers without reverting content",t=>{
 const f=fixture(t);applyAcceptedProjectFiles({...f,changes:[f.change]});
 assert.throws(()=>applyAcceptedProjectFiles({...f,changes:[{...f.change,requestChange:true,content:"durably committed"}],failAt:"after-durable-commit"}),/cleanup/);
 assert.equal(transactionRecovery(f.workspace).phase,"committed");
 assert.equal(readFileSync(join(f.root,f.change.path),"utf8"),"durably committed");
 const result=recoverTransaction(f.workspace);assert.equal(result.finalized,true);
 assert.equal(readFileSync(join(f.root,f.change.path),"utf8"),"durably committed");
 assert.equal(transactionRecovery(f.workspace).pending,false);
});

test("external sibling layout configure/setup/doctor/uninstall preserve human content and local state",t=>{
 const f=fixture(t), cli=fileURLToPath(new URL("../cli.js",import.meta.url));
 writeFileSync(join(f.root,"README.md"),"PRIVATE_HUMAN_DOCS");mkdirSync(join(f.root,".ai/rules"),{recursive:true});
 const run=(args)=>execFileSync(process.execPath,[cli,...args],{cwd:f.workspace,encoding:"utf8",stdio:["ignore","pipe","pipe"]});
 const preview=JSON.parse(run(["configure","--rules","../docs/.ai/rules","--docs","../docs","--dry-run","--json"]));
 run(["configure","--rules","../docs/.ai/rules","--docs","../docs","--expect-hash",preview.expectedHash,"--yes","--json"]);
 run(["setup","--yes","--json"]);
 let doctor;try { doctor=JSON.parse(run(["doctor","--json"])); } catch(error) { doctor=JSON.parse(error.stdout); }
 assert.equal(doctor.verb,"doctor");
 applyAcceptedProjectFiles({...f,changes:[f.change]});
 run(["uninstall","--all","--yes","--json"]);
 assert.equal(readFileSync(join(f.root,"README.md"),"utf8"),"PRIVATE_HUMAN_DOCS");
 assert.equal(readFileSync(join(f.root,f.change.path),"utf8"),f.change.content);
 assert.equal(existsSync(join(f.workspace,"README.md")),false);
 assert.equal(readProjectProvenance(f.workspace).status,"valid");
});

test("external destinations refuse missing approval, ancestors, secrets and symlinks before writes",t=>{
 const f=fixture(t);
 for(const contentDestination of [{root:f.root},{...f.contentDestination,evidence:[]},{...f.contentDestination,root:join(f.root,"..")},{...f.contentDestination,root:f.workspace}])
 assert.throws(()=>applyAcceptedProjectFiles({...f,contentDestination,changes:[f.change]}));
 mkdirSync(join(f.root,".ai"));symlinkSync(f.workspace,join(f.root,".ai/rules"));
 assert.throws(()=>applyAcceptedProjectFiles({...f,changes:[f.change]}),/symlink/);
 assert.throws(()=>applyAcceptedProjectFiles({...f,changes:[{...f.change,path:".ai/commands/secrets/key.pem"}]}),/invalid/);
 assert.equal(existsSync(join(f.workspace,".ai/agent-fleet-ai-state.json")),false);
});
