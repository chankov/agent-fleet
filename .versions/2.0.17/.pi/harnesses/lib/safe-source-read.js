// @ts-nocheck
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync} from 'node:fs';
import {isAbsolute,join,relative,resolve} from 'node:path';
export function checkedSourcePath(root,path) {
 const realRoot=realpathSync(root), full=resolve(path), rel=relative(realRoot,full);
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('source_denied');
 let cursor=realRoot;
 for(const part of rel.split('/')) {cursor=join(cursor,part);if(lstatSync(cursor).isSymbolicLink())throw Error('source_denied');}
 if(realpathSync(full)!==full)throw Error('source_denied');
 return full;
}
export function safeSourceRead(root,path,maxBytes,check=()=>{},afterFirstRead=()=>{}) {
 check();const full=checkedSourcePath(root,path), fd=openSync(full,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const before=fstatSync(fd);
  if(!before.isFile())throw Error('source_denied');
  if(before.size>maxBytes)throw Error('state_too_large');
  // Recheck the opened descriptor against the fenced pathname before any bytes
  // are read, including an ancestor swapped between the preflight and open.
  checkedSourcePath(root,full);const opened=lstatSync(full);
  if(opened.ino!==before.ino||opened.dev!==before.dev)throw Error('source_changed');
  const read=()=>{const b=Buffer.alloc(before.size);let offset=0;while(offset<b.length){check();const n=readSync(fd,b,offset,b.length-offset,offset);if(!n)throw Error('source_changed');offset+=n;}return b;};
  const bytes=read();afterFirstRead();const confirm=read(),after=fstatSync(fd);checkedSourcePath(root,full);const final=lstatSync(full);
  if(!bytes.equals(confirm)||['size','mtimeMs','ctimeMs','ino','dev'].some(k=>before[k]!==after[k])||final.ino!==after.ino||final.dev!==after.dev)throw Error('source_changed');
  if(bytes.includes(0))throw Error('source_denied');
  try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('source_denied');}
  check();return bytes;
 }finally{closeSync(fd);}
}
