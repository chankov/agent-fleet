import {createHash} from 'node:crypto';

// Offline evidence capture only. No runtime imports, compatibility verdict,
// executable invocation, socket discovery, activation or authority changes.
// Paths use only root/object-key JSON Pointers into each original schema.
// This fixed selection does not use escaped tokens or array-index traversal.
export const contractSelections = {
 'ClientRequest.json': [
  '/oneOf',
  '/definitions/RequestId',
  '/definitions/InitializeParams',
  '/definitions/InitializeCapabilities',
  '/definitions/ClientInfo',
  '/definitions/ThreadReadParams',
  '/definitions/ThreadLoadedListParams',
  '/definitions/ThreadQueueAddParams',
  '/definitions/ThreadQueueListParams',
  '/definitions/UserInput',
  '/definitions/TextElement',
  '/definitions/ByteRange',
  '/definitions/ImageDetail',
 ],
 'ServerNotification.json': ['/oneOf'],
 'v1/InitializeResponse.json': [''],
 'v2/ThreadReadParams.json': [''],
 'v2/ThreadReadResponse.json': [
  '/type', '/required', '/properties/thread',
  '/definitions/Thread/type', '/definitions/Thread/required',
  '/definitions/Thread/properties/id', '/definitions/Thread/properties/status',
  '/definitions/ThreadStatus', '/definitions/ThreadActiveFlag',
 ],
 'v2/ThreadLoadedListParams.json': [''],
 'v2/ThreadLoadedListResponse.json': [''],
 'v2/ThreadQueueAddParams.json': [''],
 'v2/ThreadQueueAddResponse.json': [''],
 'v2/ThreadQueueListParams.json': [''],
 'v2/ThreadQueueListResponse.json': [''],
} as const;

export const queueMethods = [
 'initialize', 'thread/read', 'thread/loaded/list', 'thread/queue/add', 'thread/queue/list',
] as const;

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
 if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('contract_object_required');
 return value as JsonObject;
}
function pointer(root: unknown, path: string): unknown {
 let value = root;
 for (const part of path === '' ? [] : path.slice(1).split('/')) {
  const node = object(value);
  if (!Object.hasOwn(node, part)) throw Error(`contract_fragment_missing:${path}`);
  value = node[part];
 }
 return value;
}
function method(branch: unknown): string {
 const names = object(object(branch).properties).method;
 const values = object(names).enum;
 if (!Array.isArray(values) || values.length !== 1 || typeof values[0] !== 'string') {
  throw Error('contract_method_shape_changed');
 }
 return values[0];
}

/** Preserve selected fragments verbatim, not a schema compatibility projection.
 * Source hashes cover full original bytes, including omitted fields/definitions.
 * ThreadReadResponse intentionally captures only the metadata fields Fleet reads.
 * Notification names are observations, NOT a runtime ignore/approval allowlist.
 */
export function captureNotificationContract(sources: Record<string, Uint8Array>) {
 const utf8 = new TextDecoder('utf-8', {fatal: true});
 const sourceHashes: Record<string, string> = {};
 const fragments: Record<string, Record<string, unknown>> = {};
 for (const [file, paths] of Object.entries(contractSelections)) {
  if (!Object.hasOwn(sources, file) || !(sources[file] instanceof Uint8Array)) throw Error(`contract_source_missing:${file}`);
  const source = sources[file];
  const schema = object(JSON.parse(utf8.decode(source)));
  sourceHashes[file] = createHash('sha256').update(source).digest('hex');
  fragments[file] = {};
  for (const path of paths) {
   let value = pointer(schema, path);
   if (path === '/oneOf') {
    if (!Array.isArray(value)) throw Error('contract_method_union_required');
    const names = value.map(method);
    if (new Set(names).size !== names.length) throw Error('contract_duplicate_method');
    if (file === 'ClientRequest.json') {
     for (const name of queueMethods) if (!names.includes(name)) throw Error(`contract_method_missing:${name}`);
     value = value.filter(branch => (queueMethods as readonly string[]).includes(method(branch)));
    } else if (file === 'ServerNotification.json') {
     // Only names are consumed here; notification payloads are outside Phase 0.
     value = names;
    } else {
     throw Error('contract_union_source_not_supported');
    }
   }
   fragments[file][path] = value;
  }
 }
 return {format: 'fleet-codex-notification-contract/v1', sourceHashes, fragments};
}
