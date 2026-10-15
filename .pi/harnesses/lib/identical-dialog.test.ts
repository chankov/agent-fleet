import test from 'node:test';
import assert from 'node:assert/strict';
import {decideIdenticalDialog,identicalDialogKey,resetIdenticalDialogs} from './identical-dialog.ts';

test('identical dialog is asked once and a different dialog still asks',async()=>{
 resetIdenticalDialogs();let asks=0;
 const ask=async()=>{asks++;return 'allow' as const;};
 const key=identicalDialogKey(['same','command']);
 assert.equal(await decideIdenticalDialog(key,ask),'allow');
 assert.equal(await decideIdenticalDialog(key,ask),'allow');
 assert.equal(await decideIdenticalDialog(identicalDialogKey(['other','command']),ask),'allow');
 assert.equal(asks,2);
});

test('deny is remembered, cancellation is not, and fresh ignores an earlier allow',async()=>{
 resetIdenticalDialogs();const key=identicalDialogKey(['dialog']);let asks=0;
 assert.equal(await decideIdenticalDialog(key,async()=>{asks++;return 'cancel';}),'cancel');
 assert.equal(await decideIdenticalDialog(key,async()=>{asks++;return 'deny';}),'deny');
 assert.equal(await decideIdenticalDialog(key,async()=>{asks++;return 'allow';}),'deny');
 assert.equal(await decideIdenticalDialog(key,async()=>{asks++;return 'allow';},{fresh:true}),'allow');
 assert.equal(asks,3);
});

test('concurrent identical dialogs share one question',async()=>{
 resetIdenticalDialogs();let asks=0,release:()=>void=()=>{};
 const gate=new Promise<void>(resolve=>{release=resolve;});
 const key=identicalDialogKey(['concurrent']);
 const ask=async()=>{asks++;await gate;return 'allow' as const;};
 const pending=Promise.all([decideIdenticalDialog(key,ask),decideIdenticalDialog(key,ask)]);
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(asks,1);release();
 assert.deepEqual(await pending,['allow','allow']);
});
