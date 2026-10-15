import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";

async function fixture(t: any) {
 const dir=mkdtempSync(join(tmpdir(),"fleet-approval-loader-")); t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const semantic=fileURLToPath(new URL("./semantic-approval.ts",import.meta.url));
 const dialog=fileURLToPath(new URL("./identical-dialog.ts",import.meta.url));
 const source=`import * as semantic from ${JSON.stringify(semantic)}; import * as dialog from ${JSON.stringify(dialog)};
 export default function(pi) {
  pi.registerCommand('reset',{handler:()=>{semantic.resetSemanticApprovals();dialog.resetIdenticalDialogs();}});
  pi.registerCommand('note',{handler:()=>{semantic.bindSemanticScope('task','revision');semantic.noteSemanticDecision('task','revision','docs/empty.txt','allow');}});
  pi.registerCommand('answer',{handler:()=>semantic.semanticAskUserAnswer({question:'Delete "docs/empty.txt"?',options:['Yes','No']})});
  pi.registerCommand('dialog',{handler:(_args,ctx)=>dialog.decideIdenticalDialog('same-task-dialog',ctx.ask)});
 }`;
 const paths=[join(dir,"hub.ts"),join(dir,"ask-user.ts")]; for(const path of paths)writeFileSync(path,source);
 const loaded=await loadExtensions(paths,dir); assert.deepEqual(loaded.errors,[]);
 const call=(index:number,name:string,ctx:any={})=>(loaded.extensions[index].commands.get(name)!.handler as any)("",ctx);
 await call(0,"reset"); t.after(()=>call(0,"reset")); return call;
}

test("real Pi loader shares exact semantic approval between independently loaded extensions",async t=>{
 const call=await fixture(t); await call(0,"note"); assert.equal(await call(1,"answer"),"Yes");
});

test("real Pi loader coalesces concurrent identical questions across extensions",async t=>{
 const call=await fixture(t); let asks=0,release!:(value:string)=>void;
 const ask=()=>{asks++;return new Promise<string>(r=>{release=r;});};
 const first=call(0,"dialog",{ask});const second=call(1,"dialog",{ask});
 assert.equal(asks,1); release("deny"); assert.deepEqual(await Promise.all([first,second]),["deny","deny"]);
 assert.equal(await call(1,"dialog",{ask:async()=>{asks++;return "allow";}}),"deny"); assert.equal(asks,1);
});
