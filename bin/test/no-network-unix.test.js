import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const preload=fileURLToPath(new URL('./helpers/system1-no-network.js',import.meta.url));
const run=code=>spawnSync(process.execPath,['--import',preload,'--input-type=module','-e',code],{encoding:'utf8',timeout:5000});
for(const [name,code] of [
 ['HTTP TCP',`import http from 'node:http';try{http.request('http://127.0.0.1:1')}catch{}`],
 ['URL object cannot pretend to be Unix options',`import http from 'node:http';const u=new URL('http://127.0.0.1:1');u.socketPath='/tmp/fleet-never-created.sock';try{http.request(u)}catch{}`],
 ['HTTPS remains denied',`import https from 'node:https';try{https.request({socketPath:'/tmp/fleet-never-created.sock',path:'/'})}catch{}`],
 ['TLS remains denied',`import tls from 'node:tls';try{tls.connect({path:'/tmp/fleet-never-created.sock'})}catch{}`],
 ['TCP net remains denied',`import net from 'node:net';try{net.createConnection({host:'127.0.0.1',port:1})}catch{}`],
 ['fetch remains denied',`try{await fetch('http://127.0.0.1:1')}catch{}`],
])test(`offline guard: ${name}, even caught, fails the child process`,()=>{const result=run(code);assert.equal(result.status,1,result.stderr);});

test('offline guard permits explicit HTTP framing over Unix IPC, not a TCP fallback',()=>{
 const result=run(`import http from 'node:http';import net from 'node:net';import assert from 'node:assert/strict';const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const root=mkdtempSync(join(tmpdir(),'offline-unix-'));process.on('exit',()=>rmSync(root,{recursive:true,force:true}));const path=join(root,'absent.sock');const request=http.request({socketPath:path,path:'/',createConnection:()=>net.createConnection(path)});request.on('error',e=>assert.equal(e.code,'ENOENT'));request.end();`);
 assert.equal(result.status,0,result.stderr);
});
