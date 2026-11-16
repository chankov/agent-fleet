import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants,type BigIntStats} from 'node:fs';
import {lstat,mkdir,mkdtemp,open,realpath,rm,stat,type FileHandle} from 'node:fs/promises';
import {delimiter,dirname,isAbsolute,join} from 'node:path';
import {tmpdir} from 'node:os';
import {compareCodexVersions,codexDaemonVersionFromUserAgent} from '../../../harnesses/lib/codex-compat.ts';

export class CodexMeasurementError extends Error {
 readonly code: string;
 constructor(code: string) { super(code); this.code = code; }
}
function fail(code: string): never { throw new CodexMeasurementError(code); }
const epoch = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\u0000-\u0020\u007f]/.test(value);
const version = (value: unknown): value is string => typeof value === 'string' && compareCodexVersions(value, value) === 0;
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
type Options = {timeoutMs?: number; signal?: AbortSignal};
function deadline(options: Options, fallback: number) {
 const timeout = options.timeoutMs ?? fallback, signal = options.signal;
 if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30000) fail('invalid_timeout');
 const controller = new AbortController(), expires = performance.now() + timeout; let reason = 'measurement_cancelled';
 const stop = (code: string) => { if (!controller.signal.aborted) { reason = code; controller.abort(); } };
 const abort = () => stop(performance.now() >= expires ? 'measurement_timeout' : 'measurement_cancelled');
 if (signal?.aborted) fail(reason);
 signal?.addEventListener('abort', abort, {once: true});
 const timer = setTimeout(() => stop('measurement_timeout'), timeout);
 // A fulfilled callback/microtask can run before an already-due timer. Never
 // publish an overdue observation merely because that timer has not run yet.
 const check = () => { if (performance.now() >= expires) stop('measurement_timeout'); if (controller.signal.aborted) fail(reason); };
 return {signal: controller.signal, check, error: () => new CodexMeasurementError(reason), close: () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }};
}

export interface DaemonObservationRpc {
 /** Trusted connect-only provider. Both callbacks must honor abort and clean up
  * their own transport. They must not start/resume/queue/approve anything.
  * Existing CodexUnixQueueRpc is NOT loosened or automatically wired here.
  */
 socketEpoch(signal: AbortSignal): unknown | Promise<unknown>;
 /** socketEpoch is captured/checked connection metadata, NEVER a server result
  * or an ambient path snapshot. The provider must fence against expectedEpoch.
  */
 initialize(signal: AbortSignal, expectedEpoch: string): Promise<{result: unknown; socketEpoch: string}>;
}
export type DaemonMeasurement = {kind: 'initialize_version_observation'; version: string; socketEpoch: string};
/** Version claim from the measured UA grammar only; NOT Desktop identity, MCP
 * clientInfo, current consumer presence or persistent approval evidence.
 */
export async function measureDaemon(rpc: DaemonObservationRpc, options: Options = {}): Promise<DaemonMeasurement> {
 const scope = deadline(options, 3000);
 const cancelled = new Promise<never>((_, reject) => scope.signal.addEventListener('abort', () => reject(scope.error()), {once: true}));
 const work = async (): Promise<DaemonMeasurement> => {
  scope.check(); const before = await rpc.socketEpoch(scope.signal); scope.check();
  if (!epoch(before)) fail('invalid_socket_epoch');
  const initialized = await rpc.initialize(scope.signal, before); scope.check();
  if (!initialized || typeof initialized !== 'object' || !epoch(initialized.socketEpoch) || initialized.socketEpoch !== before) fail('initialize_epoch_mismatch');
  const observed = initialized.result;
  const ua = observed && typeof observed === 'object' && !Array.isArray(observed) ? (observed as {userAgent?: unknown}).userAgent : undefined;
  // Shared exact measured prefix; no guessed alias or clientInfo/CLI fallback.
  const observedVersion=codexDaemonVersionFromUserAgent(ua);
  if (!observedVersion) fail('daemon_version_unavailable');
  const after = await rpc.socketEpoch(scope.signal); scope.check();
  if (!epoch(after) || before !== after) fail('socket_epoch_changed');
  return {kind: 'initialize_version_observation', version: observedVersion, socketEpoch: before};
 };
 try { return await Promise.race([work(), cancelled]); }
 catch (error) { if (error instanceof CodexMeasurementError) throw error; throw new CodexMeasurementError('daemon_observation_failed'); }
 finally { scope.close(); }
}

/** Revalidate the previously selected CLI bytes/alias identity without running
 * any command. A cached schema snapshot is not permission to trust a changed
 * executable. This remains byte identity, not daemon/Desktop process identity. */
export async function schemaExportStillCurrent(binary:string,evidence:{binaryEpoch:string;binarySha256:string},options:Options={}){
 const scope=deadline(options,2000);try{if(typeof process.getuid!=='function')return false;scope.check();const current=await binarySnapshot(binary,scope.check,process.getuid());scope.check();return current.epoch===evidence.binaryEpoch&&current.sha256===evidence.binarySha256;}finally{scope.close();}
}

const sourceFiles = ['ClientRequest.json','ClientNotification.json','JSONRPCResponse.json','JSONRPCError.json','v1/InitializeResponse.json','v2/ThreadReadResponse.json','v2/ThreadLoadedListResponse.json','v2/ThreadQueueAddResponse.json','v2/ThreadQueueListResponse.json'] as const;
const maxBinaryBytes = 512 * 1024 * 1024, maxFileBytes = 16 * 1024 * 1024, maxTotalBytes = 32 * 1024 * 1024;
const stamp = (s: BigIntStats) => [s.dev,s.ino,s.size,s.mode,s.uid,s.gid,s.nlink,s.mtimeNs,s.ctimeNs].map(String).join(':');
async function binarySnapshot(path: string, check: () => void, owner: number) {
 check(); const alias = await lstat(path, {bigint: true}); const resolved = await realpath(path);
 const uid = BigInt(owner), checked = new Set<string>();
 // A safe file mode alone cannot stop another UID replacing it through a
 // writable ancestor. Execute only through physically trusted parent chains.
 for (const parent of [dirname(resolved), await realpath(dirname(path))]) {
  for (let dir = parent; !checked.has(dir); dir = dirname(dir)) {
   check(); checked.add(dir); const s = await lstat(dir, {bigint: true});
   if (!s.isDirectory() || s.isSymbolicLink() || (s.uid !== uid && s.uid !== 0n) || ((Number(s.mode) & 0o022) !== 0 && (Number(s.mode) & 0o1000) === 0)) fail('unsafe_binary_parent');
  }
 }
 const before = await lstat(resolved, {bigint: true});
 if (!before.isFile() || before.isSymbolicLink() || (before.uid !== uid && before.uid !== 0n) || (alias.uid !== uid && alias.uid !== 0n) || (Number(before.mode) & 0o6022) !== 0 || (Number(before.mode) & 0o111) === 0) fail('unsafe_binary');
 if (before.size < 1n || before.size > BigInt(maxBinaryBytes)) fail('binary_limit');
 const handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 const hash = createHash('sha256'); let total = 0;
 try {
  if (stamp(await handle.stat({bigint: true})) !== stamp(before)) fail('binary_changed');
  const buffer = Buffer.alloc(1024 * 1024);
  while (true) { check(); const {bytesRead} = await handle.read(buffer, 0, buffer.length, null); if (!bytesRead) break; total += bytesRead; if (total > maxBinaryBytes) fail('binary_limit'); hash.update(buffer.subarray(0, bytesRead)); }
  if (total !== Number(before.size) || stamp(await handle.stat({bigint: true})) !== stamp(before) || stamp(await stat(resolved, {bigint: true})) !== stamp(before) || stamp(await lstat(path, {bigint: true})) !== stamp(alias) || await realpath(path) !== resolved) fail('binary_changed');
 } finally { await handle.close(); }
 check(); const digest = hash.digest('hex');
 return {path: resolved, sha256: digest, epoch: sha(JSON.stringify([path,resolved,stamp(alias),stamp(before),digest]))};
}

/** Fixed local subcommands only. Minimal isolated HOME/CODEX_HOME; no inherited
 * agent grants, auth, NODE_OPTIONS or model/provider configuration. This is not
 * an OS/network sandbox: the explicitly selected executable must be trusted.
 */
function command(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, scope: ReturnType<typeof deadline>): Promise<Buffer> {
 scope.check();
 return new Promise((resolve, reject) => {
  let error: CodexMeasurementError | undefined, stdout = 0, stderr = 0;
  const chunks: Buffer[] = [];
  const child = spawn(binary, args, {cwd, env, shell: false, detached: true, windowsHide: true, stdio: ['ignore','pipe','pipe']});
  const kill = () => { if (child.pid) try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
  const abort = () => { error ??= scope.error(); kill(); };
  scope.signal.addEventListener('abort', abort, {once: true});
  child.on('error', () => { error ??= new CodexMeasurementError('binary_command_failed'); });
  child.stdout.on('data', (data: Buffer) => { stdout += data.length; if (stdout > 16384) { error ??= new CodexMeasurementError('command_output_limit'); kill(); } else chunks.push(data); });
  child.stderr.on('data', (data: Buffer) => { stderr += data.length; if (stderr > 16384) { error ??= new CodexMeasurementError('command_output_limit'); kill(); } });
  child.on('close', code => { scope.signal.removeEventListener('abort', abort); if (error) reject(error); else if (code !== 0) reject(new CodexMeasurementError('binary_command_failed')); else resolve(Buffer.concat(chunks)); });
  if (scope.signal.aborted) abort();
 });
}

export type SchemaExportObservation = {
 kind: 'schema_export_observation'; version: string; socketEpoch: string;
 binarySha256: string; binaryEpoch: string;
 documents: Record<string, unknown>; sourceHashes: Record<string, string>;
};
/** Offline fixed schema export in an owned 0700 temp root, only after EXACT CLI
 * version match (including build metadata). No install/update/start commands.
 * Returns data after cleanup, never a ready/compatible verdict. Epoch freshness
 * must be rechecked by the future caller; no live RPC adapter is installed here.
 */
export async function exportSchema(binary: string, daemon: DaemonMeasurement, options: Options = {}): Promise<SchemaExportObservation> {
 const uid = process.getuid?.();
 if (process.platform === 'win32' || uid === undefined) fail('unsupported_platform');
 if (typeof binary !== 'string' || !isAbsolute(binary) || binary.includes('\0')) fail('invalid_binary_path');
 const observedVersion = daemon?.version, socketEpoch = daemon?.socketEpoch;
 if (daemon?.kind !== 'initialize_version_observation' || !version(observedVersion) || !epoch(socketEpoch)) fail('invalid_daemon_measurement');
 const scope = deadline(options, 30000);
 let root: string | undefined, rootIdentity: string | undefined, rootHandle: FileHandle | undefined;
 let hasResult = false;
 try {
  scope.check();
  const requestedTemp = tmpdir(); if (!isAbsolute(requestedTemp)) fail('unsafe_temp_parent');
  const base = await realpath(requestedTemp), parent = await lstat(base);
  if (!parent.isDirectory() || (parent.uid !== uid && parent.uid !== 0) || ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0)) fail('unsafe_temp_parent');
  root = await mkdtemp(join(base, 'fleet-codex-schema-')); rootIdentity = stamp(await lstat(root, {bigint: true}));
  // Pin the directory inode through cleanup: unlink/recreate cannot reuse it and
  // masquerade as our original root while this handle remains open.
  rootHandle = await open(root, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  if (stamp(await rootHandle.stat({bigint: true})).split(':').slice(0,2).join(':') !== rootIdentity.split(':').slice(0,2).join(':')) fail('unsafe_export_root');
  const home = join(root, 'home'), codexHome = join(root, 'codex-home'), temp = join(root, 'tmp'), output = join(root, 'schema');
  for (const dir of [home,codexHome,temp,output]) await mkdir(dir, {mode: 0o700});
  const env = {PATH: [dirname(process.execPath),'/usr/bin','/bin'].join(delimiter), HOME: home, CODEX_HOME: codexHome, TMPDIR: temp, TMP: temp, TEMP: temp, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TERM: 'dumb', NO_COLOR: '1'};
  const privateRoot = async () => {
   const current = await lstat(root!, {bigint: true});
   if (!current.isDirectory() || current.isSymbolicLink() || current.uid !== BigInt(uid) || (Number(current.mode) & 0o077) !== 0 || stamp(current).split(':').slice(0,2).join(':') !== rootIdentity?.split(':').slice(0,2).join(':')) fail('unsafe_export_root');
  };
  await privateRoot();
  const before = await binarySnapshot(binary, scope.check, uid);
  const rawVersion = new TextDecoder('utf-8', {fatal: true}).decode(await command(before.path, ['--version'], root, env, scope));
  const match = /^codex-cli ([^\r\n ]+)(?:\r?\n)?$/.exec(rawVersion);
  if (!match || !version(match[1]) || match[1] !== observedVersion) fail('export_version_mismatch');
  await privateRoot();
  if ((await binarySnapshot(binary, scope.check, uid)).epoch !== before.epoch) fail('binary_changed');
  await command(before.path, ['app-server','generate-json-schema','--experimental','--out',output], root, env, scope);
  await privateRoot();
  if ((await binarySnapshot(binary, scope.check, uid)).epoch !== before.epoch) fail('binary_changed');
  const documents: Record<string, unknown> = {}, sourceHashes: Record<string, string> = {}; let total = 0;
  for (const file of sourceFiles) {
   scope.check();
   const path = join(output, file);
   for (const dir of file.includes('/') ? [output,dirname(path)] : [output]) { const s = await lstat(dir); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== uid) fail('unsafe_schema_output'); }
   const entry = await lstat(path, {bigint: true});
   if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n) fail('unsafe_schema_output');
   const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
   let bytes: Buffer;
   try {
    const initial = await handle.stat({bigint: true});
    if (stamp(initial) !== stamp(entry)) fail('schema_output_changed');
    if (!initial.isFile() || initial.nlink !== 1n || initial.uid !== BigInt(uid)) fail('unsafe_schema_output');
    if (initial.size < 1n || initial.size > BigInt(maxFileBytes) || total + Number(initial.size) > maxTotalBytes) fail('schema_output_limit');
    const buffer = Buffer.alloc(Number(initial.size) + 1); let offset = 0;
    while (offset < buffer.length) { scope.check(); const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, null); if (!bytesRead) break; offset += bytesRead; }
    bytes = buffer.subarray(0, offset);
    if (bytes.length !== Number(initial.size) || stamp(await handle.stat({bigint: true})) !== stamp(initial)) fail('schema_output_changed');
   } finally { await handle.close(); }
   total += bytes.length;
   let parsed: unknown;
   try { parsed = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)); } catch { fail('invalid_schema_document'); }
   if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('invalid_schema_document');
   documents[file] = parsed; sourceHashes[file] = sha(bytes);
  }
  scope.check(); hasResult = true;
  return {kind: 'schema_export_observation', version: observedVersion, socketEpoch, binarySha256: before.sha256, binaryEpoch: before.epoch, documents, sourceHashes};
 } catch (error) { if (error instanceof CodexMeasurementError) throw error; if (scope.signal.aborted) throw scope.error(); throw new CodexMeasurementError('schema_export_failed'); }
 finally {
  try {
   try {
    if (root) {
     // Directory timestamps change as children are created; bind only dev+inode.
     try {
      const current = await lstat(root, {bigint: true});
      if (stamp(current).split(':').slice(0,2).join(':') !== rootIdentity?.split(':').slice(0,2).join(':') || !current.isDirectory() || current.isSymbolicLink() || current.uid !== BigInt(uid)) fail('unsafe_export_cleanup');
      await rm(root, {recursive: true, force: false});
     } catch (error) { if (error instanceof CodexMeasurementError) throw error; throw new CodexMeasurementError('schema_export_cleanup_failed'); }
    }
   } finally { if (rootHandle) try { await rootHandle.close(); } catch { fail('schema_export_cleanup_failed'); } }
   // Cleanup is mandatory even after cancellation. A completed observation may
   // leave the helper only if its budget/caller is still live after cleanup.
   if (hasResult) scope.check();
  } finally { scope.close(); }
 }
}
