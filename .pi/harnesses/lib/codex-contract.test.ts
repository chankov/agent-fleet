import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectSchema,compareProjection,fingerprint,ContractProjectionError,type UsedShape,type UsedSurface} from './codex-contract.ts';

const captured = JSON.parse(readFileSync(new URL('../../agent-fleet/scripts/fixtures/codex-notification-contracts/0.167-shared.json', import.meta.url), 'utf8'));
// Reconstruct ONLY captured fragments, not omitted schema bodies or historical exports.
function documents(): Record<string, any> {
 return Object.fromEntries(Object.entries(captured.fragments).filter(([file]) => file !== 'ServerNotification.json').map(([file, fragments]) => {
  let root: any = {};
  for (const [pointer, value] of Object.entries(fragments as Record<string, unknown>)) {
   if (!pointer) { root = structuredClone(value); continue; }
   const keys = pointer.slice(1).split('/'); let node = root;
   for (const key of keys.slice(0, -1)) node = node[key] ??= {};
   node[keys.at(-1)!] = structuredClone(value);
  }
  return [file, root];
 }));
}
const string: UsedShape = {type: 'string'};
const nullableString: UsedShape = {type: ['string', 'null']};
const literal = (value: string | boolean): UsedShape => ({type: typeof value, literal: value});
const object = (fields: Record<string, UsedShape>): UsedShape => ({type: 'object', fields});
const array = (items: UsedShape): UsedShape => ({type: 'array', items});
const textInput = (response = false): UsedShape => ({...object({type: literal('text'), text: string, ...(!response ? {
 text_elements: array({...object({byteRange: object({start: {type: 'integer'}, end: {type: 'integer'}}), placeholder: nullableString}), sent: ['byteRange']}),
} : {})}), variant: {field: 'type', value: 'text'}});
const submission = object({id: string, clientUserMessageId: string, input: array(textInput(true))});
const params: Record<string, UsedShape> = {
 initialize: object({clientInfo: object({name: literal('agent_fleet_queue_bridge'), title: literal('Fleet queue bridge'), version: literal('1')}), capabilities: object({experimentalApi: literal(true)})}),
 'thread/read': object({threadId: string, includeTurns: {type: 'boolean'}}),
 // Currently only method availability/default empty params, not a future bootstrap pager.
 'thread/loaded/list': object({}),
 'thread/queue/list': object({threadId: string, cursor: nullableString, limit: {type: 'integer'}}),
 'thread/queue/add': object({threadId: string, clientUserMessageId: string, input: array(textInput())}),
};
const surface: UsedSurface = Object.fromEntries(Object.entries(params).map(([method, shape]) => [`${method}/request`, {
 file: 'ClientRequest.json', direction: 'request', shape: {...object({id: string, method: literal(method), params: shape}), variant: {field: 'method', value: method}},
}]));
surface['initialize/response'] = {file: 'v1/InitializeResponse.json', direction: 'response', shape: object({userAgent: string})};
surface['thread/read/response'] = {file: 'v2/ThreadReadResponse.json', direction: 'response', shape: object({thread: object({
 id: string, status: {...object({type: literal('notLoaded')}), variant: {field: 'type', value: 'notLoaded'}},
})})};
surface['thread/queue/add/response'] = {file: 'v2/ThreadQueueAddResponse.json', direction: 'response', shape: object({queuedSubmission: submission})};
for (const [method, data] of [['thread/loaded/list', string], ['thread/queue/list', submission]] as const) {
 surface[`${method}/response`] = {file: method === 'thread/loaded/list' ? 'v2/ThreadLoadedListResponse.json' : 'v2/ThreadQueueListResponse.json', direction: 'response', shape: {...object({data: array(data), nextCursor: nullableString}), optional: ['nextCursor']}};
}
const source = documents();
const known = projectSchema(source, surface);
const method = (docs: Record<string, any>, name: string) => docs['ClientRequest.json'].oneOf.find((b: any) => b.properties.method.enum[0] === name);
const inputFiles = ['ClientRequest.json', 'v2/ThreadQueueAddResponse.json', 'v2/ThreadQueueListResponse.json'];
const mutate = (change: (docs: Record<string, any>) => void) => { const docs = documents(); change(docs); return docs; };
const rejects = (change: (docs: Record<string, any>) => void, code?: string) => {
 assert.throws(() => projectSchema(mutate(change), surface), (e: unknown) => e instanceof ContractProjectionError && (!code || e.code === code));
};
const same = (docs: Record<string, any>) => {
 const observed = projectSchema(docs, surface);
 assert.deepEqual(compareProjection(known, observed), {compatible: true, reasons: []});
 assert.equal(fingerprint(observed), fingerprint(known));
};

test('measured used subgraph has a deterministic versioned SHA256 and embedded dependency closure', () => {
 assert.match(fingerprint(known), /^[a-f0-9]{64}$/);
 // Captured before the response-anyOf extension; this is NOT a qualified hash.
 assert.equal(fingerprint(known), '5e63613f5b517437753f6f73b286eb289d7de5896c67c895eabab4fcdc725472');
 assert.equal(Object.keys(known.roots).length, 10);
 for (const key of ['UserInput', 'TextElement', 'ByteRange', 'ImageDetail']) {
  assert.deepEqual(source['ClientRequest.json'].definitions[key], source['v2/ThreadQueueAddParams.json'].definitions[key]);
 }
 same(documents());
});

test('annotations, object order, required ordering, union ordering and local ref names do not change projection', () => {
 const reorder = (value: any): any => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)])) : value;
 const docs = reorder(documents());
 docs['ClientRequest.json'].oneOf.reverse();
 docs['ClientRequest.json'].definitions.ThreadQueueAddParams.required.reverse();
 docs['ClientRequest.json'].definitions.UserInput.oneOf.reverse();
 docs['ClientRequest.json'].definitions.ClientInfo.description = 'unrelated annotation';
 docs['v2/ThreadQueueAddResponse.json'].definitions.QueuedSubmission.title = 'new name';
 docs['ClientRequest.json'].definitions['ID/~'] = docs['ClientRequest.json'].definitions.RequestId;
 delete docs['ClientRequest.json'].definitions.RequestId;
 for (const branch of docs['ClientRequest.json'].oneOf) branch.properties.id.$ref = '#/definitions/ID~1~0';
 same(docs);
 assert.equal(fingerprint(projectSchema(documents(), Object.fromEntries(Object.entries(surface).reverse()))), fingerprint(known));
});

test('new optional request fields and additional response fields/required entries are ignored', () => {
 same(mutate(docs => {
  docs['ClientRequest.json'].definitions.ThreadQueueAddParams.properties.futureOptional = {$ref: 'unused://not-followed'};
  docs['v2/ThreadQueueAddResponse.json'].properties.extra = {type: 'string'};
  docs['v2/ThreadQueueAddResponse.json'].required.push('extra');
  docs['v2/ThreadQueueListResponse.json'].required.push('nextCursor');
 }));
});

test('additive audio/video variants are ignored but this is not an original historical 0.166 fixture', () => {
 const withoutAudio = mutate(docs => {
  for (const file of inputFiles) docs[file].definitions.UserInput.oneOf = docs[file].definitions.UserInput.oneOf.filter((b: any) => !['audio', 'localAudio'].includes(b.properties.type.enum[0]));
 });
 same(withoutAudio);
 same(mutate(docs => {
  for (const file of inputFiles) docs[file].definitions.UserInput.oneOf.push({type: 'object', properties: {type: {type: 'string', enum: ['video']}, payload: {$ref: 'unused://not-followed'}}, required: ['type', 'payload']});
 }));
});

test('method removal/rename or ambiguous/general discriminator cannot silently pass', () => {
 rejects(docs => { docs['ClientRequest.json'].oneOf = docs['ClientRequest.json'].oneOf.filter((b: any) => b.properties.method.enum[0] !== 'thread/read'); }, 'variant_missing_or_ambiguous');
 rejects(docs => { method(docs, 'thread/read').properties.method.enum = ['renamed']; }, 'variant_missing_or_ambiguous');
 rejects(docs => { docs['ClientRequest.json'].oneOf.push(structuredClone(method(docs, 'thread/read'))); }, 'variant_missing_or_ambiguous');
 rejects(docs => { docs['ClientRequest.json'].oneOf.push({type: 'object', properties: {method: {type: 'string'}}}); });
});

test('request field removal/rename, incompatible type and a required unsent field are rejected', () => {
 rejects(docs => { delete docs['ClientRequest.json'].definitions.ThreadReadParams.properties.threadId; }, 'used_field_missing');
 rejects(docs => { const props = docs['ClientRequest.json'].definitions.ThreadReadParams.properties; props.renamed = props.threadId; delete props.threadId; }, 'used_field_missing');
 rejects(docs => { docs['ClientRequest.json'].definitions.ThreadReadParams.properties.threadId.type = 'integer'; }, 'type_mismatch');
 rejects(docs => { docs['ClientRequest.json'].definitions.ThreadQueueAddParams.required.push('newField'); }, 'required_request_field_not_sent');
 rejects(docs => { docs['ClientRequest.json'].definitions.ThreadLoadedListParams.required = ['limit']; }, 'required_request_field_not_sent');
 same(mutate(docs => { docs['ClientRequest.json'].definitions.UserInput.oneOf.find((b: any) => b.properties.type.enum[0] === 'text').required.push('text_elements'); }));
});

test('text variant removal/change or a new nested required text-element property is rejected', () => {
 rejects(docs => { docs['ClientRequest.json'].definitions.UserInput.oneOf = docs['ClientRequest.json'].definitions.UserInput.oneOf.filter((b: any) => b.properties.type.enum[0] !== 'text'); }, 'variant_missing_or_ambiguous');
 rejects(docs => { docs['ClientRequest.json'].definitions.UserInput.oneOf.find((b: any) => b.properties.type.enum[0] === 'text').properties.text.type = 'integer'; }, 'type_mismatch');
 rejects(docs => { docs['ClientRequest.json'].definitions.TextElement.required.push('placeholder'); }, 'required_request_field_not_sent');
 rejects(docs => { docs['ClientRequest.json'].definitions.InitializeCapabilities.properties.experimentalApi.const = false; }, 'literal_not_supported');
});

test('required response fields, notLoaded and queuedSubmission.id types are protected', () => {
 rejects(docs => { docs['v2/ThreadReadResponse.json'].definitions.ThreadStatus.oneOf.shift(); }, 'variant_missing_or_ambiguous');
 rejects(docs => { docs['v2/ThreadReadResponse.json'].definitions.Thread.required = docs['v2/ThreadReadResponse.json'].definitions.Thread.required.filter((key: string) => key !== 'id'); }, 'required_response_field_missing');
 rejects(docs => { docs['v2/ThreadReadResponse.json'].definitions.ThreadStatus.oneOf[0].required = []; }, 'required_response_field_missing');
 rejects(docs => { docs['v2/ThreadQueueAddResponse.json'].definitions.QueuedSubmission.properties.id.type = 'integer'; }, 'type_mismatch');
 rejects(docs => { delete docs['v2/ThreadQueueAddResponse.json'].definitions.QueuedSubmission.properties.id; }, 'used_field_missing');
 rejects(docs => { docs['v2/ThreadQueueListResponse.json'].required = []; }, 'required_response_field_missing');
 rejects(docs => { delete docs['v2/ThreadLoadedListResponse.json'].properties.nextCursor; }, 'used_field_missing');
 same(mutate(docs => { docs['v2/ThreadLoadedListResponse.json'].properties.nextCursor.type = 'string'; }));
});

test('new scalar/array constraints change fingerprint and compare conservatively', () => {
 for (const change of [
  (docs: Record<string, any>) => { docs['v2/ThreadQueueAddResponse.json'].definitions.QueuedSubmission.properties.id.maxLength = 128; },
  (docs: Record<string, any>) => { docs['ClientRequest.json'].definitions.ThreadQueueAddParams.properties.input.minItems = 1; },
 ]) {
  const observed = projectSchema(mutate(change), surface);
  assert.notEqual(fingerprint(observed), fingerprint(known));
  assert.deepEqual(compareProjection(known, observed), {compatible: false, reasons: ['used_contract_changed']});
 }
});

test('unknown used assertions, unsupported compositions/draft and unresolved/remote/cyclic refs fail closed', () => {
 rejects(docs => { docs['ClientRequest.json'].definitions.ThreadReadParams.if = {required: ['new']}; }, 'unsupported_keyword');
 rejects(docs => { docs['v2/ThreadReadResponse.json'].definitions.Thread.properties.status.allOf.push({type: 'object'}); }, 'unsupported_allof');
 rejects(docs => { docs['ClientRequest.json'].definitions.RequestId = {$ref: '#/definitions/RequestId'}; }, 'unsupported_or_cyclic_ref');
 rejects(docs => { method(docs, 'thread/read').properties.params.$ref = '#/definitions/missing'; }, 'missing_ref');
 rejects(docs => { method(docs, 'thread/read').properties.params.$ref = 'https://example.invalid/schema'; }, 'unsupported_or_cyclic_ref');
 rejects(docs => { docs['v1/InitializeResponse.json'].$schema = 'https://json-schema.org/draft/2020-12/schema'; }, 'unsupported_draft');
 rejects(docs => { docs['ClientRequest.json'].definitions.UserInput.oneOf[1].$schema = 'https://json-schema.org/draft/2020-12/schema'; }, 'unsupported_draft');
 rejects(docs => { docs['ClientRequest.json'].definitions.UserInput.oneOf[1].$id = 'https://example.invalid/new-base'; }, 'unsupported_identifier');
});

test('invalid assertion values and inconsistent local surface descriptors are rejected', () => {
 rejects(docs => { docs['v1/InitializeResponse.json'].properties.userAgent.minLength = 'bad'; }, 'invalid_constraint');
 rejects(docs => { docs['v1/InitializeResponse.json'].properties.userAgent.enum = []; }, 'invalid_enum');
 rejects(docs => { docs['v1/InitializeResponse.json'].properties.userAgent.format = false; }, 'invalid_constraint');
 for (const change of [
  (s: UsedSurface) => { s['initialize/response'].shape.fields!.userAgent.literal = true; },
  (s: UsedSurface) => { s['initialize/response'].shape.sent = ['userAgent']; },
  (s: UsedSurface) => { s['initialize/response'].shape.optional = ['typo']; },
 ]) {
  const bad = structuredClone(surface); change(bad);
  assert.throws(() => projectSchema(documents(), bad), ContractProjectionError);
 }
});

test('surface identity, malformed inputs and resource limits cannot produce a compatible verdict', () => {
 const changed = structuredClone(surface); changed.other = changed['initialize/response']; delete changed['initialize/response'];
 assert.deepEqual(compareProjection(known, projectSchema(documents(), changed)), {compatible: false, reasons: ['surface_changed']});
 assert.throws(() => projectSchema(documents(), {}), ContractProjectionError);
 assert.throws(() => projectSchema([], surface), ContractProjectionError);
 rejects(docs => { let schema: any = {type: 'string'}; for (let i = 0; i < 70; i++) schema = {allOf: [schema]}; method(docs, 'thread/read').properties.id = schema; }, 'projection_limit');
 rejects(docs => { docs['v1/InitializeResponse.json'].properties.userAgent.default = 'x'.repeat(1048577); }, 'projection_limit');
 assert.throws(() => fingerprint({...known, format: 'untrusted'} as any), ContractProjectionError);
 assert.throws(() => fingerprint({...known, roots: {x: undefined}}), ContractProjectionError);
});

test('projection does not mutate even frozen source/selection or retain mutable aliases', () => {
 const freeze = (v: any): any => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
 const docs = documents(), before = structuredClone(docs), selection = structuredClone(surface);
 const observed = projectSchema(freeze(docs), freeze(selection));
 assert.deepEqual(docs, before); assert.deepEqual(selection, surface);
 assert.equal(fingerprint(observed), fingerprint(known));
 const mutable = documents(), projected = projectSchema(mutable, surface), hash = fingerprint(projected);
 mutable['v1/InitializeResponse.json'].properties.userAgent.type = 'integer';
 assert.equal(fingerprint(projected), hash);
});

const primitiveResponse = (schema: any, type: UsedShape['type'] = ['string', 'integer']) => projectSchema({'wire.json': schema}, {wire: {file: 'wire.json', direction: 'response', shape: {type}}});
const idUnion = () => ({definitions: {'ID/~': {type: 'integer', format: 'int64', minimum: 0}}, anyOf: [{$ref: '#/definitions/ID~1~0'}, {type: 'string', minLength: 1}]});

test('disjoint unconstrained response primitives use the existing flat type-set projection', () => {
 same(mutate(docs => { docs['v2/ThreadLoadedListResponse.json'].properties.nextCursor = {anyOf: [{type: 'string'}, {type: 'null'}]}; }));
 const types = ['null', 'boolean', 'string', 'number'];
 const union = primitiveResponse({anyOf: types.map(type => ({type}))}, types);
 assert.deepEqual(union, primitiveResponse({type: types}, types));
 assert.deepEqual(primitiveResponse({anyOf: [{type: 'string'}]}, 'string'), primitiveResponse({type: 'string'}, 'string'));
});

test('primitive response branch assertions survive refs, branch order and annotations', () => {
 const measuredId = primitiveResponse(source['ClientRequest.json'].definitions.RequestId);
 assert.equal(measuredId.roots.wire.schema.anyOf.find((b: any) => b.type[0] === 'integer').constraints.format, 'int64');
 const schema = idUnion(), knownUnion = primitiveResponse(schema), hash = fingerprint(knownUnion);
 const branches = knownUnion.roots.wire.schema.anyOf;
 assert.equal(branches.find((b: any) => b.type[0] === 'integer').constraints.format, 'int64');
 assert.equal(branches.find((b: any) => b.type[0] === 'integer').constraints.minimum, 0);
 schema.anyOf.reverse(); (schema as any).description = 'annotation';
 assert.equal(fingerprint(primitiveResponse(schema)), hash);
 assert.deepEqual(primitiveResponse({definitions: schema.definitions, allOf: [{anyOf: schema.anyOf}]}), knownUnion);
});

test('every response branch must fit; branch constraints cannot be flattened away', () => {
 const knownUnion = primitiveResponse(idUnion());
 for (const change of [
  (s: any) => { s.definitions['ID/~'].format = 'other'; },
  (s: any) => { s.definitions['ID/~'].minimum = 1; },
  (s: any) => { s.anyOf[1].maxLength = 64; },
  (s: any) => { s.anyOf[1].enum = ['one', 'two']; },
 ]) { const schema: any = idUnion(); change(schema); assert.deepEqual(compareProjection(knownUnion, primitiveResponse(schema)), {compatible: false, reasons: ['used_contract_changed']}); }
 assert.throws(() => primitiveResponse(idUnion(), 'string'), (e: unknown) => e instanceof ContractProjectionError && e.code === 'type_mismatch');
 const added: any = idUnion(); added.anyOf.push({type: 'boolean'});
 assert.throws(() => primitiveResponse(added), (e: unknown) => e instanceof ContractProjectionError && e.code === 'type_mismatch');
});

test('general, overlapping, nested and unbounded response anyOf remains fail-closed', () => {
 for (const branches of [[], [{type: 'string'}, {type: 'string'}], [{type: 'integer'}, {type: 'number'}], [{type: 'number'}, {type: 'integer'}], [{type: 'object', properties: {}}], [{type: 'array', items: {type: 'string'}}], [{anyOf: [{type: 'string'}]}], [true], [false], [{type: ['string', 'null']}], Array.from({length: 6}, () => ({type: 'string'}))]) assert.throws(() => primitiveResponse({anyOf: branches}), ContractProjectionError);
 for (const order of [['integer', 'number'], ['number', 'integer']]) assert.throws(() => primitiveResponse({anyOf: order.map(type => ({type}))}, ['integer', 'number']), (e: unknown) => e instanceof ContractProjectionError && e.code === 'unsupported_anyof');
 const sparse: any[] = []; sparse.length = 1;
 const mixedSparse: any[] = [{type: 'string'}]; mixedSparse.length = 2;
 for (const anyOf of [sparse, mixedSparse]) assert.throws(() => primitiveResponse({anyOf}), ContractProjectionError);
 const oversized: any[] = []; oversized.length = 6; Object.defineProperty(oversized, 0, {get() { assert.fail('over-limit branches must not be read'); }});
 assert.throws(() => primitiveResponse({anyOf: oversized}), (e: unknown) => e instanceof ContractProjectionError && e.code === 'unsupported_anyof');
 assert.throws(() => primitiveResponse({anyOf: [{type: 'string', if: {const: 'x'}}]}), ContractProjectionError);
 assert.throws(() => primitiveResponse({anyOf: [{type: 'string', minLength: 'bad'}]}), ContractProjectionError);
 assert.throws(() => projectSchema({'wire.json': {anyOf: [{type: 'string'}]}}, {wire: {file: 'wire.json', direction: 'response', shape: {type: 'string', literal: 'x'}}}), ContractProjectionError);
});

test('primitive unions do not widen ordinary typed schemas or closed request fields', () => {
 assert.throws(() => projectSchema({'wire.json': {type: 'object', properties: {result: true}, required: ['result']}}, {wire: {file: 'wire.json', direction: 'response', shape: object({result: object({})})}}), ContractProjectionError);
 assert.throws(() => projectSchema({'wire.json': {type: 'object', properties: {method: {type: 'string'}}, required: ['method'], additionalProperties: false}}, {wire: {file: 'wire.json', direction: 'request', shape: object({method: string, params: object({})})}}), ContractProjectionError);
});

test('primitive response unions preserve frozen inputs and detached results', () => {
 const schema = idUnion(), before = structuredClone(schema);
 Object.freeze(schema.definitions['ID/~']); Object.freeze(schema.definitions); Object.freeze(schema.anyOf); Object.freeze(schema);
 const result = primitiveResponse(schema), hash = fingerprint(result);
 assert.deepEqual(schema, before);
 const mutable = idUnion(), projected = primitiveResponse(mutable), detachedHash = fingerprint(projected);
 mutable.definitions['ID/~'].minimum = 10;
 assert.equal(fingerprint(projected), detachedHash); assert.equal(hash, detachedHash);
});

const opaqueShape = (): UsedShape => object({result: {type: 'opaque'}});
const opaqueDocument = (...args: any[]): any => ({type: 'object', properties: {result: args.length ? args[0] : true}, required: ['result']});
const opaqueResponse = (schema: any = opaqueDocument(), shape: UsedShape = opaqueShape(), direction: 'request' | 'response' = 'response') => projectSchema({wire: schema}, {wire: {file: 'wire', direction, shape}});

test('explicit opaque selector records only required response property presence', () => {
 const projected = opaqueResponse();
 assert.deepEqual(projected.roots.wire.schema.required, ['result']);
 assert.deepEqual(projected.roots.wire.schema.properties.result, {type: ['opaque'], constraints: {}});
 assert.match(fingerprint(projected), /^[a-f0-9]{64}$/);
});

test('opaque requiredness and declared property cannot be weakened or made optional', () => {
 const missingRequired = opaqueDocument(); missingRequired.required = [];
 assert.throws(() => opaqueResponse(missingRequired), (e: unknown) => e instanceof ContractProjectionError && e.code === 'required_response_field_missing');
 const missingProperty = opaqueDocument(); delete missingProperty.properties.result;
 assert.throws(() => opaqueResponse(missingProperty), (e: unknown) => e instanceof ContractProjectionError && e.code === 'used_field_missing');
 assert.throws(() => opaqueResponse(opaqueDocument(), {...opaqueShape(), optional: ['result']}), (e: unknown) => e instanceof ContractProjectionError && e.code === 'invalid_opaque_surface');
});

test('opaque selector refuses every non-literal-true schema instead of stripping constraints', () => {
 for (const schema of [undefined, null, 0, 'true', [], false, {}, {type: 'object'}, {type: 'string'}, {type: 'opaque'}, {const: null}, {anyOf: [true]}, {allOf: [true]}, {$ref: '#/definitions/Opaque'}, {$id: 'changed'}]) {
  const doc = opaqueDocument(schema); doc.definitions = {Opaque: true};
  assert.throws(() => opaqueResponse(doc), (e: unknown) => e instanceof ContractProjectionError && e.code === 'unsupported_opaque_schema');
 }
});

test('opaque is not a JSON type, request selector, root or array-items escape hatch', () => {
 assert.throws(() => opaqueResponse(opaqueDocument(), opaqueShape(), 'request'), ContractProjectionError);
 assert.throws(() => opaqueResponse({}, {type: 'opaque'}), ContractProjectionError);
 assert.throws(() => opaqueResponse(true, {type: 'opaque'}), ContractProjectionError);
 assert.throws(() => opaqueResponse({type: 'array', items: true}, array({type: 'opaque'})), ContractProjectionError);
 assert.throws(() => opaqueResponse(opaqueDocument(), object({result: {type: ['opaque', 'string']}})), ContractProjectionError);
 for (const extra of [{fields: {}}, {items: string}, {literal: null}, {variant: {field: 'type', value: 'x'}}, {sent: []}, {optional: []}]) assert.throws(() => opaqueResponse(opaqueDocument(), object({result: {type: 'opaque', ...extra}})), ContractProjectionError);
});

test('opaque support does not replace typed payload checks or admit closed request fields', () => {
 assert.throws(() => opaqueResponse(opaqueDocument(), object({result: object({})})), ContractProjectionError);
 assert.throws(() => opaqueResponse(opaqueDocument(), object({result: string})), ContractProjectionError);
 assert.throws(() => projectSchema({wire: {type: 'object', properties: {method: {type: 'string'}}, required: ['method'], additionalProperties: false}}, {wire: {file: 'wire', direction: 'request', shape: object({method: string, params: object({})})}}), (e: unknown) => e instanceof ContractProjectionError && e.code === 'used_field_missing');
});

test('opaque selection preserves frozen inputs and detached projections', () => {
 const doc = opaqueDocument(), shape = opaqueShape(), before = structuredClone(doc);
 Object.freeze(doc.properties); Object.freeze(doc.required); Object.freeze(doc);
 Object.freeze(shape.fields!.result); Object.freeze(shape.fields); Object.freeze(shape);
 const projected = opaqueResponse(doc, shape), hash = fingerprint(projected);
 assert.deepEqual(doc, before);
 const mutable = opaqueDocument(), detached = opaqueResponse(mutable), detachedHash = fingerprint(detached);
 mutable.properties.result = false; mutable.required.length = 0;
 assert.equal(fingerprint(detached), detachedHash); assert.equal(hash, detachedHash);
});

// Synthetic initialized fixture, not a measured/qualified production profile.
const initializedDocument = (): any => ({$schema: 'http://json-schema.org/draft-07/schema#', oneOf: [{type: 'object', properties: {method: {type: 'string', enum: ['initialized']}}, required: ['method']}]});
const initializedShape = (): UsedShape => ({...object({method: literal('initialized'), params: object({})}), variant: {field: 'method', value: 'initialized'}});
const initializedBranch = (doc: any): any => doc.oneOf[0];
const openSentRequest = (doc = initializedDocument(), shape = initializedShape(), direction: 'request' | 'response' = 'request') => projectSchema({wire: doc}, {wire: {file: 'wire', direction, shape}});

test('open sent empty-object property equals its pre-change declared projection', () => {
 for (const explicit of [false, true]) {
  const doc = initializedDocument(); if (explicit) initializedBranch(doc).additionalProperties = true;
  const projected = openSentRequest(doc), declared = structuredClone(doc);
  initializedBranch(declared).properties.params = {type: 'object'};
  assert.deepEqual(projected, openSentRequest(declared));
  assert.deepEqual(projected.roots.wire.schema.required, ['method', 'params']);
  assert.deepEqual(projected.roots.wire.schema.properties.params, {type: ['object'], constraints: {}, required: [], properties: {}});
  // Recorded before this extension; NOT a qualified fingerprint.
  if (!explicit) assert.equal(fingerprint(projected), '01f7d615e6168333faa1f820a9cbc21efe01f4c36d0deaac7fa320a0754bb66b');
 }
 const shape = initializedShape(); shape.fields!.params = {type: ['object'], fields: {}, sent: []};
 assert.doesNotThrow(() => openSentRequest(initializedDocument(), shape));
});

test('a declared optional params schema always wins over open-field fallback', () => {
 for (const schema of [undefined, null, false, true, {}, {type: 'string'}, {type: 'array', items: string}, {type: 'object', required: ['newRequired']}, {$ref: '#/definitions/Missing'}]) {
  const doc = initializedDocument(); initializedBranch(doc).properties.params = schema;
  assert.throws(() => openSentRequest(doc), ContractProjectionError);
 }
 const incompatible = initializedDocument(); initializedBranch(incompatible).properties.params = {type: 'integer'};
 assert.throws(() => openSentRequest(incompatible), (e: unknown) => e instanceof ContractProjectionError && e.code === 'type_mismatch');
 const malformed = initializedDocument(); initializedBranch(malformed).properties.params = {type: 'object', minProperties: 'bad'};
 assert.throws(() => openSentRequest(malformed), (e: unknown) => e instanceof ContractProjectionError && e.code === 'invalid_constraint');
});

test('parent permissions, scopes and actually-sent requiredness remain fail-closed', () => {
 const closed = initializedDocument(); initializedBranch(closed).additionalProperties = false;
 assert.throws(() => openSentRequest(closed), (e: unknown) => e instanceof ContractProjectionError && e.code === 'used_field_missing');
 initializedBranch(closed).properties.params = {type: 'object'};
 assert.doesNotThrow(() => openSentRequest(closed));
 for (const value of [undefined, null, 0, 'true', {}, {type: 'object'}]) {
  const doc = initializedDocument(); initializedBranch(doc).additionalProperties = value;
  assert.throws(() => openSentRequest(doc), (e: unknown) => e instanceof ContractProjectionError && e.code === 'unsupported_additional_properties');
 }
 for (const assertion of [{patternProperties: {params: false}}, {propertyNames: {enum: ['method']}}, {if: {}}, {$id: 'changed'}, {$schema: 'https://json-schema.org/draft/2020-12/schema'}]) {
  const doc = initializedDocument(); Object.assign(initializedBranch(doc), assertion);
  assert.throws(() => openSentRequest(doc), ContractProjectionError);
 }
 const required = initializedDocument(), known = openSentRequest(required);
 initializedBranch(required).required.push('params'); assert.deepEqual(openSentRequest(required), known);
 initializedBranch(required).required.push('notSent');
 assert.throws(() => openSentRequest(required), (e: unknown) => e instanceof ContractProjectionError && e.code === 'required_request_field_not_sent');
});

test('open empty-object fallback does not admit unsent/response fields or general schema templates', () => {
 assert.throws(() => openSentRequest(initializedDocument(), {...initializedShape(), sent: ['method']}), (e: unknown) => e instanceof ContractProjectionError && e.code === 'used_field_missing');
 assert.throws(() => openSentRequest(initializedDocument(), {...initializedShape(), optional: ['params']}, 'response'), (e: unknown) => e instanceof ContractProjectionError && e.code === 'used_field_missing');
 for (const params of [string, array(string), object({nested: object({})}), {type: 'opaque'}]) {
  const shape = initializedShape(); shape.fields!.params = params;
  assert.throws(() => openSentRequest(initializedDocument(), shape), ContractProjectionError);
 }
 for (const params of [{type: 'object', fields: {}, sent: ['ghost']}, {type: 'object', fields: {}, optional: []}, {type: 'object', fields: {}, items: string}, {type: 'object', fields: {}, unknownControl: true}]) {
  const shape = initializedShape(); shape.fields!.params = params;
  assert.throws(() => openSentRequest(initializedDocument(), shape), ContractProjectionError);
 }
 assert.throws(() => projectSchema({wire: true}, {wire: {file: 'wire', direction: 'request', shape: object({})}}), ContractProjectionError);
 assert.throws(() => projectSchema({wire: {type: 'array', items: true}}, {wire: {file: 'wire', direction: 'request', shape: array(object({}))}}), ContractProjectionError);
});

test('new declared params or parent assertions change the used contract, not disappear', () => {
 const known = openSentRequest();
 for (const target of ['parent', 'params']) {
  const doc = initializedDocument();
  if (target === 'parent') initializedBranch(doc).maxProperties = 1;
  else initializedBranch(doc).properties.params = {type: 'object', minProperties: 1};
  const observed = openSentRequest(doc);
  assert.notEqual(fingerprint(observed), fingerprint(known));
  assert.deepEqual(compareProjection(known, observed), {compatible: false, reasons: ['used_contract_changed']});
 }
});

test('open sent projection preserves frozen sources/shape and detached output', () => {
 const doc = initializedDocument(), shape = initializedShape(), before = structuredClone(doc);
 Object.freeze(initializedBranch(doc).properties); Object.freeze(initializedBranch(doc).required); Object.freeze(initializedBranch(doc)); Object.freeze(doc.oneOf); Object.freeze(doc);
 Object.freeze(shape.fields!.params.fields); Object.freeze(shape.fields!.params); Object.freeze(shape.fields); Object.freeze(shape);
 const projected = openSentRequest(doc, shape), hash = fingerprint(projected);
 assert.deepEqual(doc, before);
 const mutable = initializedDocument(), detached = openSentRequest(mutable);
 initializedBranch(mutable).additionalProperties = false;
 initializedBranch(mutable).properties.params = {type: 'integer'};
 assert.equal(fingerprint(detached), hash);
});

const emptyArrayRequest = (schema: any, shape: UsedShape = {type: 'array', literal: []}, direction: 'request' | 'response' = 'request') => projectSchema({wire: schema}, {wire: {file: 'wire', direction, shape}});

test('known sent empty array retains const and array assertions without fictional items', () => {
 const schema = {type: 'array', items: {type: 'object', required: ['notSent']}, minItems: 0, maxItems: 8, uniqueItems: true};
 const projected = emptyArrayRequest(schema);
 assert.deepEqual(projected.roots.wire.schema, {type: ['array'], constraints: {const: [], minItems: 0, maxItems: 8, uniqueItems: true}});
 assert.equal('items' in projected.roots.wire.schema, false);
 const changed = {...schema, items: {$id: 'unused-item-scope', unknownAssertion: true}};
 assert.deepEqual(emptyArrayRequest(changed), projected);
 assert.doesNotThrow(() => emptyArrayRequest({type: 'array', items: false, maxItems: 0}));
});

test('empty request literal cannot bypass nonempty/enum/const or unknown array assertions', () => {
 for (const schema of [{type: 'array', minItems: 1}, {type: 'array', enum: [[1]]}, {type: 'array', const: [1]}, {type: 'array', contains: {}}, {type: 'array', minItems: 'bad'}, {type: 'array', prefixItems: []}]) assert.throws(() => emptyArrayRequest(schema), ContractProjectionError);
 assert.doesNotThrow(() => emptyArrayRequest({type: 'array', enum: [[], [1]], const: []}));
 const before = emptyArrayRequest({type: 'array', maxItems: 2}), after = emptyArrayRequest({type: 'array', maxItems: 1});
 assert.deepEqual(compareProjection(before, after), {compatible: false, reasons: ['used_contract_changed']});
});

test('empty array request literal does not add response/nonempty/object/general-schema literals', () => {
 for (const literal of [[1], new Array(1), {}, [undefined]]) assert.throws(() => emptyArrayRequest({type: 'array'}, {type: 'array', literal} as any), ContractProjectionError);
 assert.throws(() => emptyArrayRequest({type: 'array'}, {type: 'array', literal: []}, 'response'), ContractProjectionError);
 assert.throws(() => emptyArrayRequest({type: 'array'}, {type: 'array', literal: [], items: string}), ContractProjectionError);
 assert.throws(() => emptyArrayRequest(true), ContractProjectionError);
 assert.throws(() => emptyArrayRequest({type: ['array', 'null']}, {type: ['array', 'null'], literal: []}), ContractProjectionError);
});

test('actual captured text_elements can describe only the empty array actually sent', () => {
 const complete = structuredClone(surface);
 complete['thread/queue/add/request'].shape.fields!.params.fields!.input.items!.fields!.text_elements = {type: 'array', literal: []};
 const doc = documents(), snapshot = structuredClone(doc), literalValue = complete['thread/queue/add/request'].shape.fields!.params.fields!.input.items!.fields!.text_elements.literal!;
 Object.freeze(literalValue);
 const projected = projectSchema(doc, complete), hash = fingerprint(projected);
 doc['ClientRequest.json'].definitions.TextElement.required.push('futureUnusedRequired');
 doc['ClientRequest.json'].definitions.TextElement.properties.futureUnusedRequired = {type: 'string'};
 assert.deepEqual(projectSchema(doc, complete), projected);
 assert.equal(fingerprint(projected), hash);
 assert.notDeepEqual(doc, snapshot);
});
