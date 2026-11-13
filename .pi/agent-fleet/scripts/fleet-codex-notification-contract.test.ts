import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {captureNotificationContract,contractSelections,queueMethods} from './fixtures/codex-notification-contracts/capture.ts';
import {matchesDesktopQueueTuple} from '../../harnesses/lib/fleet-notification-validation.ts';

const fixtureRoot = new URL('./fixtures/codex-notification-contracts/', import.meta.url);
const snapshot = JSON.parse(readFileSync(new URL('0.167-shared.json', fixtureRoot), 'utf8'));
const measurements = JSON.parse(readFileSync(new URL('measurements.json', fixtureRoot), 'utf8'));
const fragment = (file: string, path = '') => snapshot.fragments[file][path];

// Reconstitute synthetic sources from captured fragments to test the extractor.
// These are NOT original exports; their hashes deliberately differ from those
// recorded in the measured fixture. Re-export validation is documented separately.
function syntheticSources(): Record<string, Uint8Array> {
 return Object.fromEntries(Object.keys(contractSelections).map(file => {
  let root: any = {};
  for (const [path, captured] of Object.entries(snapshot.fragments[file])) {
   let value = structuredClone(captured);
   if (file === 'ServerNotification.json' && path === '/oneOf') {
    value = (value as string[]).map(name => ({properties: {method: {enum: [name]}}}));
   }
   if (path === '') { root = value; continue; }
   const parts = path.slice(1).split('/');
   let node = root;
   for (const part of parts.slice(0, -1)) node = node[part] ??= {};
   node[parts.at(-1)!] = value;
  }
  return [file, Buffer.from(JSON.stringify(root))];
 }));
}

test('measured snapshot covers exactly the offline source and fragment selection', () => {
 assert.equal(snapshot.format, 'fleet-codex-notification-contract/v1');
 assert.deepEqual(Object.keys(snapshot.fragments), Object.keys(contractSelections));
 assert.deepEqual(Object.keys(snapshot.sourceHashes), Object.keys(contractSelections));
 for (const [file, paths] of Object.entries(contractSelections)) {
  assert.match(snapshot.sourceHashes[file], /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(snapshot.fragments[file]), paths);
 }
 assert.deepEqual(measurements.exports.map((entry: any) => entry.version), ['0.167.0', '0.167.1']);
 for (const entry of measurements.exports) {
  assert.equal(entry.snapshot, '0.167-shared.json');
  assert.match(entry.binarySha256, /^[a-f0-9]{64}$/);
 }
});

test('capture preserves selected schema constraints and hashes full original bytes', () => {
 const sources = syntheticSources();
 const original = Object.fromEntries(Object.entries(sources).map(([file, bytes]) => [file, Buffer.from(bytes)]));
 const result = captureNotificationContract(sources);
 assert.deepEqual(result.fragments, snapshot.fragments);
 assert.deepEqual(sources, original);
 for (const [file, source] of Object.entries(sources)) {
  assert.equal(result.sourceHashes[file], createHash('sha256').update(source).digest('hex'));
 }
 // Even omitted schema fields and formatting participate in source hashes.
 const file = 'ClientRequest.json';
 sources[file] = Buffer.concat([sources[file], Buffer.from('\n')]);
 const changed = captureNotificationContract(sources);
 assert.notEqual(changed.sourceHashes[file], result.sourceHashes[file]);
 assert.deepEqual(changed.fragments, result.fragments);
});

test('capture fails rather than silently saving incomplete or changed export shapes', () => {
 const absent = syntheticSources(); delete absent['v2/ThreadReadParams.json'];
 assert.throws(() => captureNotificationContract(absent), /contract_source_missing/);
 const missing = syntheticSources(); missing['v2/ThreadReadResponse.json'] = Buffer.from('{}');
 assert.throws(() => captureNotificationContract(missing), /contract_fragment_missing/);
 const invalid = syntheticSources(); invalid['ClientRequest.json'] = Buffer.from('{');
 assert.throws(() => captureNotificationContract(invalid), SyntaxError);
 const union = syntheticSources(); union['ServerNotification.json'] = Buffer.from('{"oneOf":{}}');
 assert.throws(() => captureNotificationContract(union), {message: 'contract_method_union_required'});
 for (const [kind, message] of [
  ['duplicate', 'contract_duplicate_method'],
  ['missing', 'contract_method_missing:initialize'],
  ['malformed', 'contract_method_shape_changed'],
 ] as const) {
  const sources = syntheticSources(), request = JSON.parse(Buffer.from(sources['ClientRequest.json']).toString('utf8'));
  if (kind === 'duplicate') request.oneOf.push(request.oneOf[0]);
  if (kind === 'missing') request.oneOf = request.oneOf.filter((branch: any) => branch.properties.method.enum[0] !== 'initialize');
  if (kind === 'malformed') request.oneOf[0].properties.method.enum = ['initialize', 'other'];
  sources['ClientRequest.json'] = Buffer.from(JSON.stringify(request));
  assert.throws(() => captureNotificationContract(sources), {message});
 }
});

test('capture hashes exact bytes including BOM and rejects invalid UTF-8', () => {
 const sources = syntheticSources(), file = 'ClientRequest.json';
 const before = captureNotificationContract(sources);
 sources[file] = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), sources[file]]);
 const withBom = captureNotificationContract(sources);
 assert.equal(withBom.sourceHashes[file], createHash('sha256').update(sources[file]).digest('hex'));
 assert.notEqual(withBom.sourceHashes[file], before.sourceHashes[file]);
 assert.deepEqual(withBom.fragments, before.fragments);
 sources[file] = Buffer.concat([sources[file], Buffer.from([0xff])]);
 assert.throws(() => captureNotificationContract(sources), TypeError);
});

test('embedded method parameter definitions match their separately exported schemas', () => {
 for (const name of ['ThreadReadParams', 'ThreadLoadedListParams', 'ThreadQueueAddParams', 'ThreadQueueListParams']) {
  const {$schema, title, definitions, ...standalone} = fragment(`v2/${name}.json`);
  assert.deepEqual(fragment('ClientRequest.json', `/definitions/${name}`), standalone);
 }
});

test('measured requests retain initialize and the four queue adapter methods only', () => {
 const branches = fragment('ClientRequest.json', '/oneOf');
 assert.deepEqual(branches.map((branch: any) => branch.properties.method.enum[0]).sort(), [...queueMethods].sort());
 assert.equal(fragment('ClientRequest.json', '/definitions/InitializeCapabilities').properties.experimentalApi.type, 'boolean');
 const response = fragment('v1/InitializeResponse.json');
 assert.equal(response.properties.userAgent.type, 'string');
 assert.ok(response.required.includes('userAgent'));
});

test('thread metadata snapshot retains the exact ID/status read contract', () => {
 const params = fragment('v2/ThreadReadParams.json');
 assert.deepEqual(params.required, ['threadId']);
 assert.equal(params.properties.threadId.type, 'string');
 assert.equal(params.properties.includeTurns.type, 'boolean');
 assert.ok(fragment('v2/ThreadReadResponse.json', '/required').includes('thread'));
 assert.ok(fragment('v2/ThreadReadResponse.json', '/definitions/Thread/required').includes('id'));
 assert.ok(fragment('v2/ThreadReadResponse.json', '/definitions/Thread/required').includes('status'));
 assert.equal(fragment('v2/ThreadReadResponse.json', '/definitions/Thread/properties/id').type, 'string');
 assert.deepEqual(fragment('v2/ThreadReadResponse.json', '/definitions/Thread/properties/status').allOf, [{$ref: '#/definitions/ThreadStatus'}]);
 const variants = fragment('v2/ThreadReadResponse.json', '/definitions/ThreadStatus').oneOf;
 assert.deepEqual(variants.map((variant: any) => variant.properties.type.enum[0]), ['notLoaded', 'idle', 'systemError', 'active']);
});

test('queue request/response snapshots preserve text, dedup ID and pagination fields', () => {
 const add = fragment('v2/ThreadQueueAddParams.json');
 assert.deepEqual(add.required, ['clientUserMessageId', 'input', 'threadId']);
 for (const field of ['threadId', 'clientUserMessageId']) assert.equal(add.properties[field].type, 'string');
 assert.equal(add.properties.input.type, 'array');
 const text = add.definitions.UserInput.oneOf.find((variant: any) => variant.properties.type.enum[0] === 'text');
 assert.deepEqual(text.required, ['text', 'type']);
 assert.equal(text.properties.text.type, 'string');
 assert.deepEqual(text.properties.text_elements.default, []);
 assert.equal(text.properties.text_elements.type, 'array');
 // Preserve the entire union as evidence; capture does not declare audio compatible.
 assert.ok(add.definitions.UserInput.oneOf.some((variant: any) => variant.properties.type.enum[0] === 'audio'));
 const response = fragment('v2/ThreadQueueAddResponse.json');
 assert.deepEqual(response.required, ['queuedSubmission']);
 assert.deepEqual(response.definitions.QueuedSubmission.required, ['clientUserMessageId', 'id', 'input']);
 assert.deepEqual(response.definitions.UserInput, add.definitions.UserInput);
 for (const file of ['v2/ThreadQueueListResponse.json', 'v2/ThreadLoadedListResponse.json']) {
  const page = fragment(file);
  assert.deepEqual(page.required, ['data']);
  assert.equal(page.properties.data.type, 'array');
  assert.deepEqual(page.properties.nextCursor.type, ['string', 'null']);
 }
});

test('notification list and initialize UA are observations, not consumer identity or authority', () => {
 const names = fragment('ServerNotification.json', '/oneOf');
 assert.equal(new Set(names).size, names.length);
 for (const name of ['thread/queue/changed', 'thread/status/changed', 'model/rerouted']) assert.ok(names.includes(name));
 const observation = measurements.initializeObservation;
 assert.match(observation.userAgent, /^Codex Desktop\/0\.167\.1 /);
 assert.equal(observation.provesDesktopIdentity, false);
 assert.equal(observation.provesLoadedConsumer, false);
 assert.deepEqual(observation.resultKeys, ['codexHome', 'platformFamily', 'platformOs', 'userAgent']);
});

test('historical exact tuples stay admitted; fresh equal exports do not widen runtime admission', () => {
 assert.equal(measurements.historicalExactTuples.length, 3);
 for (const tuple of measurements.historicalExactTuples) {
  assert.equal(matchesDesktopQueueTuple(tuple), true);
  assert.equal(matchesDesktopQueueTuple({...tuple, desktopVersion: tuple.desktopVersion + '.99'}), false);
 }
 const mixed = measurements.historicalExactTuples[2];
 const addSchema = snapshot.sourceHashes['v2/ThreadQueueAddParams.json'];
 const responseSchema = snapshot.sourceHashes['v2/ThreadQueueAddResponse.json'];
 assert.equal(addSchema, mixed.desktopAddSchema);
 assert.equal(responseSchema, mixed.desktopResponseSchema);
 for (const version of ['0.167.0', '0.167.1']) {
  // Change one dimension of a known accepted tuple; its other evidence is valid.
  assert.equal(matchesDesktopQueueTuple({...mixed, daemonVersion: version}), false);
  assert.equal(matchesDesktopQueueTuple({...mixed, desktopVersion: version}), false);
  // Hypothetical fresh pair, with complete schema evidence for BOTH endpoints.
  // No actual Desktop executable/consumer identity was measured in this slice.
  assert.equal(matchesDesktopQueueTuple({
   daemonVersion: version, desktopVersion: version,
   addSchema, responseSchema, desktopAddSchema: addSchema, desktopResponseSchema: responseSchema,
  }), false);
 }
});
