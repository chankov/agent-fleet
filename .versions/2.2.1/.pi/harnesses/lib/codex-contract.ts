import {createHash} from 'node:crypto';

/** Offline, inert JSON only. No filesystem/transport or runtime admission. */
type Obj = Record<string, any>;
type Direction = 'request' | 'response';
type Primitive = string | number | boolean | null;
export type UsedShape = {
 /** 'opaque' selects only presence of a required response property with schema true.
  * It is not a JSON Schema type and makes no payload/value guarantee. */
 type: string | readonly string[];
 fields?: Record<string, UsedShape>;
 items?: UsedShape;
 variant?: {field: string; value: string};
 /** Empty array is request-only: no item is sent/consumed by this literal. */
 literal?: Primitive | readonly [];
 sent?: readonly string[];
 optional?: readonly string[];
};
export type UsedSurface = Record<string, {file: string; direction: Direction; shape: UsedShape}>;
export type ContractProjection = {format: 'fleet-codex-projection/v1'; surfaceKey: string; roots: Obj};
export class ContractProjectionError extends Error {
 readonly code: string;
 readonly path: string;
 constructor(code: string, path: string) { super(`${code}:${path}`); this.code = code; this.path = path; }
}
const fail = (code: string, path: string): never => { throw new ContractProjectionError(code, path); };
const object = (v: unknown, path: string): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : fail('object_required', path);
const annotations = new Set(['description', 'title', '$schema', 'definitions', '$defs', '$comment', 'examples', 'deprecated', 'readOnly', 'writeOnly']);
const assertions = new Set(['default', 'enum', 'const', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', 'additionalProperties', 'minProperties', 'maxProperties']);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
const own = (v: Obj, key: string) => Object.hasOwn(v, key);

/** Bounded canonical JSON, with no coercion, mutation or dependence on key order. */
function canonical(value: unknown): string {
 let nodes = 0, characters = 0;
 const walk = (v: unknown, depth: number): unknown => {
  if (typeof v === 'string') characters += v.length;
  if (++nodes > 8192 || depth > 64 || characters > 1048576) return fail('projection_limit', '$');
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return Array.from(v, item => walk(item, depth + 1));
  const obj = object(v, '$');
  return Object.fromEntries(Object.keys(obj).sort().map(key => { characters += key.length; return [key, walk(obj[key], depth + 1)]; }));
 };
 return JSON.stringify(walk(value, 0));
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
function names(value: unknown, path: string): string[] {
 if (!Array.isArray(value) || value.length > 256 || value.some(x => typeof x !== 'string') || new Set(value).size !== value.length) return fail('string_set_required', path);
 return [...value].sort();
}
function schemaTypes(schema: Obj, path: string): string[] {
 const result = names(typeof schema.type === 'string' ? [schema.type] : schema.type, path);
 if (!result.length || result.some(t => !types.has(t))) return fail('type_required', path);
 return result;
}
function allowed(schema: Obj, structural: string[], path: string) {
 if (schema.$schema !== undefined && schema.$schema !== 'http://json-schema.org/draft-07/schema#') fail('unsupported_draft', path);
 for (const key of Object.keys(schema)) if (!annotations.has(key) && !structural.includes(key)) fail('unsupported_keyword', path);
}

/** Resolve only local JSON Pointers and singleton allOf wrappers. Unsupported
 * assertions/ref formats fail closed, rather than being silently stripped.
 * Request anyOf may select one accepting branch. Response anyOf is restricted
 * to disjoint single-primitive-type branches; branch constraints are retained.
 */
export function projectSchema(documents: unknown, surface: UsedSurface): ContractProjection {
 const docs = object(documents, '$documents');
 const roots = object(surface, '$surface');
 const rootNames = Object.keys(roots).sort();
 if (!rootNames.length || rootNames.length > 32) fail('surface_limit', '$surface');
 const surfaceKey = sha(canonical(surface));
 let nodes = 0;
 const step = (path: string, depth: number) => { if (++nodes > 4096 || depth > 64) fail('projection_limit', path); };
 const projectRoot = (name: string) => {
  const root = object(roots[name], name);
  if (!/^[A-Za-z0-9_.:/-]{1,96}$/.test(name) || Object.keys(root).sort().join(',') !== 'direction,file,shape' || !['request', 'response'].includes(root.direction) || typeof root.file !== 'string' || !own(docs, root.file)) fail('invalid_root', name);
  const doc = object(docs[root.file], name), direction: Direction = root.direction;
  const resolve = (raw: unknown, shape: UsedShape, path: string, depth: number, refs: string[] = [], tagOnly = false): Obj => {
   step(path, depth);
   const schema = object(raw, path);
   if (own(schema, '$id') || own(schema, '$anchor') || own(schema, '$dynamicRef') || own(schema, '$dynamicAnchor')) fail('unsupported_identifier', path);
   if (schema.$schema !== undefined && schema.$schema !== 'http://json-schema.org/draft-07/schema#') fail('unsupported_draft', path);
   if (own(schema, '$ref')) {
    allowed(schema, ['$ref'], path);
    const ref = schema.$ref;
    if (typeof ref !== 'string' || !/^#\/(definitions|\$defs)\//.test(ref) || refs.includes(ref)) fail('unsupported_or_cyclic_ref', path);
    let target: any = doc;
    for (const token of ref.slice(2).split('/')) {
     if (/~(?![01])/.test(token)) fail('invalid_ref', path);
     const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
     if (!target || typeof target !== 'object' || !own(target, key)) fail('missing_ref', path);
     target = target[key];
    }
    return resolve(target, shape, path, depth + 1, [...refs, ref], tagOnly);
   }
   // A disjoint discriminator proves an unused branch cannot match our tagged
   // packet. Its unrelated payload/composition must not be traversed.
   if (tagOnly && own(schema, 'properties')) return schema;
   if (own(schema, 'allOf')) {
    allowed(schema, ['allOf'], path);
    if (!Array.isArray(schema.allOf) || schema.allOf.length !== 1) fail('unsupported_allof', path);
    return resolve(schema.allOf[0], shape, path, depth + 1, refs, tagOnly);
   }
   if (own(schema, 'anyOf')) {
    allowed(schema, ['anyOf'], path);
    if (!Array.isArray(schema.anyOf) || !schema.anyOf.length || schema.anyOf.length > (direction === 'response' ? 5 : 256)) fail('unsupported_anyof', path);
    // Defer response branches to project: every branch must fit the consumer,
    // unlike request selection, which may choose one accepting branch.
    if (direction === 'response') return schema;
    const wanted = names(typeof shape.type === 'string' ? [shape.type] : shape.type, path);
    const branches = schema.anyOf.map((branch: unknown) => resolve(branch, shape, path, depth + 1, refs));
    const matches = branches.filter((branch: Obj) => wanted.every(t => schemaTypes(branch, path).includes(t)));
    if (matches.length !== 1) fail('ambiguous_anyof', path);
    return matches[0];
   }
   return schema;
  };
  const project = (raw: unknown, selection: UsedShape, path: string, depth: number, requiredResponseProperty = false): Obj => {
   step(path, depth);
   const shape = object(selection, path);
   for (const key of Object.keys(shape)) if (!['type', 'fields', 'items', 'variant', 'literal', 'sent', 'optional'].includes(key)) fail('invalid_surface', path);
   if (shape.type === 'opaque') {
    if (direction !== 'response' || !requiredResponseProperty || Object.keys(shape).length !== 1) fail('invalid_opaque_surface', path);
    if (raw !== true) fail('unsupported_opaque_schema', path);
    return {type: ['opaque'], constraints: {}};
   }
   const wanted = schemaTypes({type: shape.type}, path);
   if (wanted.join() !== 'object' && (shape.fields || shape.sent || shape.optional)) fail('invalid_surface', path);
   if (wanted.join() !== 'array' && shape.items) fail('invalid_surface', path);
   if ((direction === 'request' && shape.optional) || (direction === 'response' && shape.sent)) fail('invalid_surface', path);
   const emptyArrayLiteral = own(shape, 'literal') && direction === 'request' && wanted.join() === 'array' && Array.isArray(shape.literal) && shape.literal.length === 0;
   if (own(shape, 'literal')) {
    const value = shape.literal;
    const matches = emptyArrayLiteral || (value === null ? wanted.includes('null') : typeof value === 'number' ? Number.isFinite(value) && (wanted.includes('number') || (Number.isInteger(value) && wanted.includes('integer'))) : ['string', 'boolean'].includes(typeof value) && wanted.includes(typeof value));
    if (!matches) fail('invalid_surface_literal', path);
   }
   let schema = resolve(raw, selection, path, depth);
   if (direction === 'response' && own(schema, 'anyOf')) {
    if (wanted.some(t => t === 'object' || t === 'array') || shape.variant || own(shape, 'literal')) fail('unsupported_anyof', path);
    const seen = new Set<string>();
    const branches: Obj[] = Array.from(schema.anyOf, (rawBranch: unknown) => {
     const branch = resolve(rawBranch, selection, path, depth + 1);
     if (own(branch, 'anyOf')) fail('unsupported_anyof', path);
     const actual = schemaTypes(branch, path);
     if (actual.length !== 1 || actual[0] === 'object' || actual[0] === 'array') fail('unsupported_anyof', path);
     const type = actual[0];
     if (seen.has(type) || (type === 'number' && seen.has('integer')) || (type === 'integer' && seen.has('number'))) fail('unsupported_anyof', path);
     seen.add(type);
     if (!wanted.includes(type)) fail('type_mismatch', path);
     return project(branch, {type}, path, depth + 1);
    });
    // An unconstrained primitive union is the existing flat type-set form.
    // Otherwise preserve per-branch assertions rather than factoring them out.
    if (!branches.some(branch => Object.keys(branch.constraints).length)) return {type: wanted, constraints: {}};
    branches.sort((a, b) => { const x = canonical(a), y = canonical(b); return x < y ? -1 : x > y ? 1 : 0; });
    return {type: wanted, constraints: {}, anyOf: branches};
   }
   if (shape.variant) {
    const variant = object(shape.variant, path);
    if (wanted.join() !== 'object' || Object.keys(variant).sort().join(',') !== 'field,value' || typeof variant.field !== 'string' || typeof variant.value !== 'string') fail('invalid_variant', path);
    const branchTag = (branch: Obj): string[] => {
     const props = object(branch.properties, path);
     const tag = resolve(props[variant.field], {type: 'string'}, path, depth + 1);
     allowed(tag, ['type', 'enum'], path);
     if (schemaTypes(tag, path).join() !== 'string') fail('invalid_discriminator', path);
     const values = names(tag.enum, path);
     if (!values.length) fail('invalid_discriminator', path);
     return values;
    };
    if (own(schema, 'oneOf')) {
     allowed(schema, ['oneOf'], path);
     if (!Array.isArray(schema.oneOf) || !schema.oneOf.length || schema.oneOf.length > 256) fail('invalid_variant_union', path);
     const branches = schema.oneOf.map((branch: unknown) => resolve(branch, selection, path, depth + 1, [], true));
     const matches = branches.filter((branch: Obj) => branchTag(branch).includes(variant.value));
     if (matches.length !== 1) fail('variant_missing_or_ambiguous', path);
     schema = resolve(matches[0], selection, path, depth + 1);
    } else if (!branchTag(schema).includes(variant.value)) fail('variant_missing_or_ambiguous', path);
   }
   const actual = schemaTypes(schema, path);
   if (!(direction === 'request' ? wanted.every(t => actual.includes(t)) : actual.every(t => wanted.includes(t)))) fail('type_mismatch', path);
   const structural = ['type', ...assertions];
   if (wanted.includes('object')) structural.push('properties', 'required');
   if (wanted.includes('array')) structural.push('items');
   allowed(schema, structural, path);
   const constraints: Obj = {};
   for (const key of assertions) if (own(schema, key)) {
    let value = schema[key];
    if (key === 'enum') {
     if (!Array.isArray(value) || !value.length || value.length > 256) fail('invalid_enum', path);
     value = value.map((v: unknown) => canonical(v)).sort();
     if (new Set(value).size !== value.length) fail('invalid_enum', path);
     value = value.map((v: string) => JSON.parse(v));
    }
    if (key === 'additionalProperties' && typeof value !== 'boolean') fail('unsupported_additional_properties', path);
    if (key === 'uniqueItems' && typeof value !== 'boolean') fail('invalid_constraint', path);
    if (['format', 'pattern'].includes(key) && typeof value !== 'string') fail('invalid_constraint', path);
    if (['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'].includes(key) && (typeof value !== 'number' || !Number.isFinite(value) || (key === 'multipleOf' && value <= 0))) fail('invalid_constraint', path);
    if (['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'].includes(key) && (!Number.isSafeInteger(value) || value < 0)) fail('invalid_constraint', path);
    constraints[key] = value;
   }
   if (own(shape, 'literal')) {
    const value = canonical(shape.literal);
    if ((own(constraints, 'enum') && !constraints.enum.some((v: unknown) => canonical(v) === value)) || (own(constraints, 'const') && canonical(constraints.const) !== value)) fail('literal_not_supported', path);
    delete constraints.enum;
    constraints.const = shape.literal;
   }
   const result: Obj = {type: wanted, constraints};
   if (wanted.includes('object')) {
    if (wanted.length !== 1 || !own(shape, 'fields')) fail('object_surface_required', path);
    const fields = object(shape.fields, path), properties = object(schema.properties ?? {}, path);
    const fieldNames = Object.keys(fields).sort();
    const required = names(schema.required ?? [], path);
    const controls = names((direction === 'request' ? shape.sent : shape.optional) ?? (direction === 'request' ? fieldNames : []), path);
    if (controls.some(k => !own(fields, k))) fail('invalid_surface', path);
    const guaranteed = direction === 'request' ? controls : fieldNames.filter(k => !controls.includes(k));
    if (direction === 'request' ? required.some(k => !guaranteed.includes(k)) : guaranteed.some(k => !required.includes(k))) fail(direction === 'request' ? 'required_request_field_not_sent' : 'required_response_field_missing', path);
    result.required = guaranteed;
    result.properties = Object.fromEntries(fieldNames.map(key => {
     const fieldPath = `${path}.${key}`;
     if (!/^[A-Za-z0-9_-]{1,96}$/.test(key)) fail('used_field_missing', fieldPath);
     const declared = own(properties, key);
     let property = declared ? properties[key] : undefined;
     if (!declared) {
      if (direction !== 'request' || !guaranteed.includes(key) || (own(schema, 'additionalProperties') && schema.additionalProperties !== true)) fail('used_field_missing', fieldPath);
      const selected = object(fields[key], fieldPath);
      if (schemaTypes({type: selected.type}, fieldPath).join() !== 'object' || !own(selected, 'fields') || Object.keys(object(selected.fields, fieldPath)).length) fail('used_field_missing', fieldPath);
      // Open properties accept the known empty object we send; this is not a
      // general true-schema resolver or permission to ignore a declared schema.
      property = {type: 'object'};
     }
     return [key, project(property, fields[key], fieldPath, depth + 1, direction === 'response' && guaranteed.includes(key))];
    }));
   } else if (wanted.includes('array')) {
    if (wanted.length !== 1 || (!emptyArrayLiteral && !shape.items)) fail('array_surface_required', path);
    if (emptyArrayLiteral) {
     if (own(shape, 'items') || (constraints.minItems ?? 0) > 0) fail('literal_not_supported', path);
    } else result.items = project(schema.items, shape.items, `${path}[]`, depth + 1);
   } else if (shape.fields || shape.items || shape.sent || shape.optional) fail('invalid_surface', path);
   return result;
  };
  return {direction, schema: project(doc, root.shape, name, 0)};
 };
 const result = {format: 'fleet-codex-projection/v1' as const, surfaceKey, roots: Object.fromEntries(rootNames.map(name => [name, projectRoot(name)]))};
 return JSON.parse(canonical(result)) as ContractProjection;
}

export function fingerprint(projection: ContractProjection): string {
 if (projection?.format !== 'fleet-codex-projection/v1' || !/^[a-f0-9]{64}$/.test(projection.surfaceKey) || !Object.keys(object(projection.roots, '$roots')).length) fail('invalid_projection', '$');
 return sha('fleet-codex-projection/v1\n' + canonical(projection));
}
/** Deliberately conservative: unknown used constraints must match exactly.
 * Additive fields/variants and annotations never enter the used projection.
 */
export function compareProjection(known: ContractProjection, observed: ContractProjection) {
 if (known.surfaceKey !== observed.surfaceKey) return {compatible: false, reasons: ['surface_changed']};
 const compatible = fingerprint(known) === fingerprint(observed);
 return {compatible, reasons: compatible ? [] : ['used_contract_changed']};
}
