import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createCommunicationStore } from "../system1-communication-store.ts";
const coding=import.meta.resolve("@earendil-works/pi-coding-agent"),tui=import.meta.resolve("@earendil-works/pi-tui");
registerHooks({resolve(s,c,next){if(s==="@mariozechner/pi-coding-agent")return{url:coding,shortCircuit:true};if(s==="@mariozechner/pi-tui")return{url:tui,shortCircuit:true};return next(s,c);}});
const {openSystem1Communication}=await import("./system1-communication.ts");
test("Fleet communication enable, rows, Enter pair, both copies, failure and Esc",async()=>{
 const store=createCommunicationStore();let panel:any;const notices:string[]=[];let finish!:()=>void;const copied:string[]=[];let fail=false;
 const ctx:any={ui:{notify:(text:string)=>notices.push(text),custom:(factory:any)=>new Promise<void>(resolve=>{finish=resolve;panel=factory({terminal:{rows:16},requestRender(){}},{},{},resolve);})}};
 const pending=openSystem1Communication(ctx,store,async text=>{if(fail)throw Error();copied.push(text);});
 assert.match(panel.render(120).join("\n"),/capture OFF/);await panel.handleInput("e");assert.equal(store.enabled,true);
 await store.wrap({async evaluate(){return {status:"skipped",reason:"disabled"};}},{provider:"other",model:"model"}).evaluate({state:{task:"password=SENTINEL"},questions:[{id:"x",type:"predicate",instructions:"x"}],questionSetVersion:"dispatch-triage/v1"});
 const list=panel.render(160).join("\n");assert.match(list,/request/);assert.match(list,/response/);
 await panel.handleInput("\r");assert.match(panel.render(160).join("\n"),/Request/);await panel.handleInput("\r");assert.equal(copied.length,1);assert.ok(!copied[0].includes("SENTINEL"));
 await panel.handleInput("\x1b[C");await panel.handleInput("\r");assert.equal(copied.length,2);assert.match(copied[1],/skipped/);
 fail=true;await panel.handleInput("\r");assert.ok(notices.includes("Clipboard unavailable"));
 await panel.handleInput("\x1b");await panel.handleInput("d");assert.equal(store.snapshot().length,0);await panel.handleInput("\x1b");await pending;panel.dispose();finish();
});

test("communication overlay paints an opaque full viewport for empty, populated, detail and resized views",async()=>{
 const {visibleWidth}=await import("@earendil-works/pi-tui");
 const store=createCommunicationStore();let panel:any;
 const terminal={rows:24};
 const ctx:any={ui:{notify(){},custom:(factory:any)=>new Promise<void>(resolve=>{panel=factory({terminal,requestRender(){}},{},{},resolve);})}};
 const pending=openSystem1Communication(ctx,store,async()=>{});
 const assertOpaque=(width:number)=>{
  const lines=panel.render(width);
  assert.equal(lines.length,terminal.rows,"must occupy full terminal height, not a centered short overlay");
  for(const line of lines)assert.equal(visibleWidth(line),width,"blank and short rows must overwrite Fleet background across full width");
  if(terminal.rows>=3 && width>=120)assert.match(lines.at(-1),/Esc/);
 };
 assertOpaque(100);
 await panel.handleInput("e");assertOpaque(100);
 await store.wrap({async evaluate(){return {status:"skipped",reason:"disabled"};}},{provider:"fake",model:"fake"}).evaluate({state:{task:"Inspect code"},questions:[{id:"x",type:"predicate",instructions:"Inspect"}],questionSetVersion:"dispatch-triage/v1"});
 assertOpaque(100);await panel.handleInput("\r");assertOpaque(100);
 terminal.rows=8;assertOpaque(40);terminal.rows=40;assertOpaque(120);
 terminal.rows=2;assertOpaque(12);
 await panel.handleInput("\x1b");await panel.handleInput("\x1b");await pending;panel.dispose();
});
