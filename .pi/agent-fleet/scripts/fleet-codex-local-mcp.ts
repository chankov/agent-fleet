#!/usr/bin/env node
// Fixed launcher options only. Never reads env identity or discovers policy roots.
import { LocalCodexMcp, McpProtocol } from './lib/fleet-codex-local-mcp.ts';

function options(args: string[]) {
 const allowed = ['--registry-root','--policy-root','--host-profile','--principal'];
 const values = new Map<string,string>();
 for (let i=0;i<args.length;i+=2) {
  const k = args[i], v = args[i+1];
  if (!allowed.includes(k) || values.has(k) || !v || v.startsWith('--')) throw new Error('INVALID_LAUNCH');
  values.set(k,v);
 }
 if (values.size !== 4) throw new Error('INVALID_LAUNCH');
 return { registryRoot: values.get('--registry-root')!, policyRoot: values.get('--policy-root')!,
  hostProfile: values.get('--host-profile')!, principal: values.get('--principal')! };
}
async function main() {
 let protocol: McpProtocol;
 try { protocol = new McpProtocol(new LocalCodexMcp(options(process.argv.slice(2)))); }
 catch { process.stderr.write('LOCAL_MCP_START_FAILED\n'); process.exitCode = 64; return; }
 process.stdout.on('error',() => {});
 const tasks = new Set<Promise<void>>();
 async function output(response: unknown) {
  if (response === undefined) return;
  let line = JSON.stringify(response)+'\n';
  if (Buffer.byteLength(line)>262144) line = JSON.stringify({ jsonrpc: '2.0', id: (response as { id?: unknown }).id ?? null,
   error: { code: -32000, message: 'OUTPUT_LIMIT' } })+'\n';
  await new Promise<void>((r,j) => process.stdout.write(line,e => e ? j(e) : r()));
 }
 const error = (message: string,code = -32700) => output({ jsonrpc: '2.0', id: null, error: { code,message } });
 let buffered = Buffer.alloc(0), dropping = false, failed = false;
 const schedule = async (line: Buffer) => {
  if (!line.length) return;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8',{ fatal:true }).decode(line)); }
  catch { await error('PARSE_ERROR'); return; }
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : undefined;
  // Control notifications, especially cancellation, must not wait behind eight slow calls.
  if (record?.jsonrpc === '2.0' && typeof record.method === 'string' && !Object.hasOwn(record,'id')) {
   await protocol.handle(record); return;
  }
  if (tasks.size>=8) {
   const id = record?.id;
   await output({ jsonrpc:'2.0', id: typeof id === 'string' && id.length<=128 || typeof id === 'number' && Number.isSafeInteger(id) ? id : null,
    error: { code:-32000, message:'BUSY' } }); return;
  }
  let task: Promise<void>;
  task = protocol.handle(value).then(output).catch(() => { failed = true; process.stdin.destroy(); }).finally(() => tasks.delete(task));
  tasks.add(task);
 };
 try {
  for await (const raw of process.stdin) {
   if (failed) break;
   const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
   let offset = 0;
   while (offset<chunk.length) {
    const end = chunk.indexOf(10,offset), stop = end === -1 ? chunk.length : end;
    if (!dropping) {
     const part = chunk.subarray(offset,stop);
     if (buffered.length+part.length>65536) { buffered = Buffer.alloc(0); dropping = true; await error('INPUT_LIMIT',-32600); }
     else buffered = Buffer.concat([buffered,part]);
    }
    if (end !== -1) { if (!dropping) await schedule(buffered); buffered = Buffer.alloc(0); dropping = false; }
    offset = end === -1 ? chunk.length : end+1;
   }
  }
  if (buffered.length && !dropping && !failed) await schedule(buffered);
  await Promise.all(tasks);
  if (failed) throw new Error('STDIO_FAILED');
 } catch { process.stderr.write('LOCAL_MCP_IO_FAILED\n'); process.exitCode = 1; }
}
await main();
