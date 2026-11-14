import type {UsedShape,UsedSurface} from './codex-contract.ts';

/** ABI footprint of the current queue host and initialize-only observer, NOT a
 * qualified version/identity registry or activation authority. A future transcript
 * probe/bootstrap consumer must extend this profile before claiming coverage.
 * Return detached graphs so callers cannot mutate another policy's surface. */
export const codexNotificationSurfaceId = 'fleet-codex-notification/v1';
export function codexNotificationSurface(): UsedSurface {
 const string: UsedShape = {type: 'string'};
 const nullableString: UsedShape = {type: ['string', 'null']};
 const literal = (value: string | boolean | number): UsedShape => ({type: typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value, literal: value});
 const object = (fields: Record<string,UsedShape>): UsedShape => ({type: 'object', fields});
 const array = (items: UsedShape): UsedShape => ({type: 'array', items});
 const text = (sent: boolean): UsedShape => ({...object({type: literal('text'), text: string,
  ...(sent ? {text_elements: {type: 'array', literal: []} as UsedShape} : {}),
 }), variant: {field: 'type', value: 'text'}});
 const submission = object({id: string, clientUserMessageId: string, input: array(text(false))});
 const surface: UsedSurface = {};
 const add = (name: string, file: string, direction: 'request'|'response', shape: UsedShape) => {
  surface[`${codexNotificationSurfaceId}/${name}`] = {file, direction, shape};
 };
 const request = (name: string, params: UsedShape, suffix = '') => add(`${name}${suffix}/request`, 'ClientRequest.json', 'request', {
  ...object({id: string, method: literal(name), params}), variant: {field: 'method', value: name},
 });
 for (const [suffix,name,title,experimentalApi] of [
  ['/queue','agent_fleet_queue_bridge','Fleet queue bridge',true],
  ['/observer','agent_fleet_contract_observer','Fleet contract observer',false],
 ] as const) request('initialize', object({clientInfo: object({name: literal(name), title: literal(title), version: literal('1')}), capabilities: object({experimentalApi: literal(experimentalApi)})}), suffix);
 add('initialized/request', 'ClientNotification.json', 'request', {...object({method: literal('initialized'), params: object({})}), variant: {field: 'method', value: 'initialized'}});
 add('jsonrpc/response', 'JSONRPCResponse.json', 'response', object({id: {type: ['string','integer']}, result: {type: 'opaque'}}));
 add('jsonrpc/error', 'JSONRPCError.json', 'response', object({id: {type: ['string','integer']}, error: object({})}));
 add('initialize/response', 'v1/InitializeResponse.json', 'response', object({userAgent: string}));
 request('thread/read', object({threadId: string, includeTurns: literal(false)}));
 add('thread/read/response', 'v2/ThreadReadResponse.json', 'response', object({thread: object({id: string,
  status: {...object({type: literal('notLoaded')}), variant: {field: 'type', value: 'notLoaded'}},
 })}));
 request('thread/queue/add', object({threadId: string, clientUserMessageId: string, input: array(text(true))}));
 add('thread/queue/add/response', 'v2/ThreadQueueAddResponse.json', 'response', object({queuedSubmission: submission}));
 request('thread/queue/list', object({threadId: string, limit: literal(100), cursor: nullableString}));
 add('thread/queue/list/response', 'v2/ThreadQueueListResponse.json', 'response', {...object({data: array(submission), nextCursor: nullableString}), optional: ['nextCursor']});
 // loaded/list is only in the RPC whitelist, with no current notification caller.
 // No fictional data fields, transcript fields, or ServerNotification payloads.
 return structuredClone(surface);
}

/** Distinct prospective bootstrap footprint: adds only metadata thread.path.
 * Optional/nullable in the wire schema, mandatory usable path in a future probe
 * driver. This factory is not no-load capability/identity or live qualification. */
export const codexNotificationBootstrapSurfaceId = 'fleet-codex-notification-bootstrap/v1';
export function codexNotificationBootstrapSurface(): UsedSurface {
 const surface = Object.fromEntries(Object.entries(codexNotificationSurface()).map(([name,root]) => [
  codexNotificationBootstrapSurfaceId + name.slice(codexNotificationSurfaceId.length), root,
 ]));
 const thread = surface[`${codexNotificationBootstrapSurfaceId}/thread/read/response`].shape.fields!.thread;
 thread.fields!.path = {type: ['string','null']};
 thread.optional = ['path'];
 return surface;
}
export function codexNotificationBootstrapPolicy(referenceDocuments: unknown) {
 const policy = codexNotificationPolicy(referenceDocuments);
 policy.profile.surface = codexNotificationBootstrapSurface();
 return policy;
}

/** Server-owned policy only. Floors and empty denylists explicitly approved by
 * the human; version eligibility never establishes identity, probe or consent.
 * referenceDocuments must be bounded trusted package/capture data, NOT tool args.
 * No fingerprint is promoted automatically and all returned graphs are detached. */
export function codexNotificationPolicy(referenceDocuments: unknown) {
 return {
  daemon: {minimum: '0.166.0', denylist: [] as string[]},
  desktop: {minimum: '0.166.0-alpha.5.1', denylist: [] as string[]},
  profile: {surface: codexNotificationSurface(), referenceDocuments: structuredClone(referenceDocuments), verifiedFingerprints: [] as string[]},
 };
}
