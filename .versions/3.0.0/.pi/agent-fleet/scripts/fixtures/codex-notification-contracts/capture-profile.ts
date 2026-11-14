import {createHash} from 'node:crypto';
import {captureNotificationContract,contractSelections} from './capture.ts';
import {codexNotificationSurface,codexNotificationSurfaceId,codexNotificationBootstrapSurface,codexNotificationBootstrapSurfaceId} from '../../../../harnesses/lib/codex-notification-profile.ts';
import {projectSchema,fingerprint} from '../../../../harnesses/lib/codex-contract.ts';

export const notificationProfileSources = [...Object.keys(contractSelections), 'ClientNotification.json','JSONRPCResponse.json','JSONRPCError.json'] as const;
/** Offline fixture capture only; never executable/process/consumer attestation.
 * Preserve original 11 fragments/hashes and add the 3 actually used envelopes.
 * Reference documents reconstruct ONLY captured fragments + complete envelopes,
 * not missing historical bodies. No filesystem/runtime/activation side effects. */
export function captureNotificationProfile(sources: Record<string,Uint8Array>) {
 const owned: Record<string,Uint8Array> = {};
 let total = 0;
 for (const file of notificationProfileSources) {
  const bytes = Object.hasOwn(sources,file) ? sources[file] : undefined;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > 16*1024*1024 || (total += bytes.byteLength) > 32*1024*1024) throw Error('profile_source_invalid');
  owned[file] = Uint8Array.from(bytes);
 }
 const capture = captureNotificationContract(owned);
 const documents: Record<string,any> = {};
 for (const [file,fragments] of Object.entries(capture.fragments)) {
  if (file === 'ServerNotification.json') continue;
  let root: any = {};
  for (const [pointer,value] of Object.entries(fragments)) {
   if (!pointer) { root = structuredClone(value); continue; }
   const parts = pointer.slice(1).split('/'); let node = root;
   for (const part of parts.slice(0,-1)) node = node[part] ??= {};
   node[parts.at(-1)!] = structuredClone(value);
  }
  documents[file] = root;
 }
 const hashes = {...capture.sourceHashes}, decoder = new TextDecoder('utf-8',{fatal:true});
 for (const file of ['ClientNotification.json','JSONRPCResponse.json','JSONRPCError.json']) {
  documents[file] = JSON.parse(decoder.decode(owned[file]));
  hashes[file] = createHash('sha256').update(owned[file]).digest('hex');
 }
 const projection = projectSchema(documents,codexNotificationSurface());
 return {format:'fleet-codex-notification-profile-reference/v1',surfaceId:codexNotificationSurfaceId,qualification:'not_qualified',sourceHashes:hashes,referenceDocuments:documents,projection,fingerprint:fingerprint(projection)};
}

/** Separate offline bootstrap reference; never alters/promotes the current v1.
 * Full ThreadReadResponse retains all parent assertions and path dependencies,
 * not a fabricated path field or stripped schema. No transcript bytes are read. */
export function captureNotificationBootstrapProfile(sources: Record<string,Uint8Array>) {
 const reference = captureNotificationProfile(sources), file = 'v2/ThreadReadResponse.json';
 const input = sources[file];
 if (!(input instanceof Uint8Array) || input.byteLength > 16*1024*1024) throw Error('profile_source_invalid');
 const bytes = Uint8Array.from(input);
 if (createHash('sha256').update(bytes).digest('hex') !== reference.sourceHashes[file]) throw Error('profile_source_changed');
 reference.referenceDocuments[file] = JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 const projection = projectSchema(reference.referenceDocuments,codexNotificationBootstrapSurface());
 return {...reference,format:'fleet-codex-notification-bootstrap-profile-reference/v1',surfaceId:codexNotificationBootstrapSurfaceId,projection,fingerprint:fingerprint(projection)};
}
