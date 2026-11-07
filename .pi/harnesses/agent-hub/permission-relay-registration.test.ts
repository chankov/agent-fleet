import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {handlePermissionEnvelope} from './permission-relay.ts';

for(const path of ['index.ts','../coms/index.ts'])test(`permission envelope is actually routed in ${path} custom handler`,()=>{
 const source=ts.createSourceFile(path,readFileSync(new URL(path,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true);
 let found=false;
 const visit=(node:ts.Node)=>{
  if(ts.isPropertyAssignment(node)&&node.name.getText(source)==='handleCustomEnvelope'){
   const search=(child:ts.Node)=>{if(ts.isCallExpression(child)&&child.expression.getText(source)==='handlePermissionEnvelope')found=true;ts.forEachChild(child,search);};search(node.initializer);
  }
  ts.forEachChild(node,visit);
 };visit(source);assert.equal(found,true);
});

test('standalone COMS peer explicitly reports unsupported; wrong owner reports stale without execution',()=>{
 const owner={project:'p',peer:'h',sessionId:'s',startedAt:'now'};let body='';
 const socket={end(text:string){body=text;}} as any;
 assert.equal(handlePermissionEnvelope(socket,{type:'permission_request',msg_id:'q',owner},undefined,owner),true);
 assert.equal(JSON.parse(body).status,'unsupported');
 handlePermissionEnvelope(socket,{type:'permission_request',msg_id:'q',owner:{...owner,sessionId:'old'}},undefined,owner);
 assert.equal(JSON.parse(body).status,'stale');
});
