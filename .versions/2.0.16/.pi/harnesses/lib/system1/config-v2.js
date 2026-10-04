// @ts-nocheck
// Pure, immutable document normalizer. No filesystem, environment, or inference.
import { parseProactiveConfig } from './config-proactive.js';
import { parseTriageConfig, parseTaskTriageConfig, TASK_TRIAGE_LIMITS } from './config-triage.js';
export const CONSUMERS = Object.freeze(['watchdog', 'proactiveReview', 'dispatchTriage', 'taskTriage']);
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fields = {
  watchdog: ['mode'],
  proactiveReview: ['mode', 'remoteContext', 'include', 'maxEvaluationsPerSession', 'localBindings'],
  dispatchTriage: ['mode', 'remoteContextApproved', 'maxCalls', 'maxStateBytes', 'maxTaskBytes', 'maxRoleBytes', 'profile', 'orchestratorBeforeDispatch'],
  taskTriage: ['mode', 'remoteContextApproved', 'questionVersion', 'policyVersion', 'limits'],
};
export function normalizeSystem1Config(value) {
  const errors = [];
  const error = (path, code = 'invalid_value') => errors.push({ path, code });
  const empty = status => deepFreeze({ status, errors, consumers: Object.fromEntries(CONSUMERS.map(name => [name, { status: 'off' }])) });
  if (value === undefined) return empty('missing');
  if (!record(value)) { error('$', 'invalid_root'); return empty('invalid'); }
  if (value.version === 1) {
    const keys = ['version', 'mode', 'provider', 'model', 'apiKeyEnv'];
    for (const key of Object.keys(value)) if (!keys.includes(key)) error(`$.${key}`, 'unknown_field');
    for (const key of keys) if (!Object.hasOwn(value, key)) error(`$.${key}`, 'missing_field');
    if (!['auto', 'off'].includes(value.mode)) error('$.mode');
    if (value.provider !== 'typesafe') error('$.provider');
    if (value.model !== 'jev-1.13.0') error('$.model');
    if (value.apiKeyEnv !== 'TYPESAFE_API_KEY') error('$.apiKeyEnv');
    if (errors.length) return empty('invalid');
    error('$.version', 'migration_required');
    return deepFreeze({ ...empty('migration_required'), legacyProvider: { ...value } });
  }
  const rootKeys = ['version', 'mode', 'provider', 'model', 'apiKeyEnv', 'consumers'];
  for (const key of Object.keys(value)) if (!rootKeys.includes(key)) error(`$.${key}`, 'unknown_field');
  for (const [key, valid] of Object.entries({ version: value.version === 2, mode: ['off', 'auto'].includes(value.mode), provider: value.provider === 'typesafe', model: value.model === 'jev-1.13.0', apiKeyEnv: value.apiKeyEnv === 'TYPESAFE_API_KEY', consumers: record(value.consumers) })) if (!valid) error(`$.${key}`);
  if (errors.length) return empty('invalid');
  let document;
  try { document = JSON.parse(JSON.stringify(value)); }
  catch { error('$', 'invalid_json'); return empty('invalid'); }
  const provider = Object.fromEntries(rootKeys.filter(k => k !== 'consumers').map(k => [k, document[k]]));
  // Provider projection is still a valid v2 document, with no consumer policies.
  provider.consumers = {};
  const consumers = {};
  for (const name of Object.keys(document.consumers)) if (!CONSUMERS.includes(name)) error(`$.consumers.${name}`, 'unknown_section');
  for (const name of CONSUMERS) {
    const section = document.consumers[name];
    if (section === undefined) { consumers[name] = { status: 'off' }; continue; }
    const path = `$.consumers.${name}`;
    const before = errors.length;
    if (!record(section)) error(path, 'invalid_section');
    else for (const key of Object.keys(section)) if (!fields[name].includes(key)) error(`${path}.${key}`, 'unknown_field');
    if (errors.length !== before) { consumers[name] = { status: 'invalid' }; continue; }
    if (name === 'proactiveReview' && Array.isArray(section.localBindings)) {
      const schemas = { rule:['path','heading','occurrence','hash'], applicability:['paths','kinds','basename'], exceptions:['paths','legacy'], placement:['prefix'] };
      section.localBindings.forEach((binding, index) => {
        if (!record(binding)) return;
        for (const key of Object.keys(binding)) if (!['version','validator','rule','applicability','exceptions','placement'].includes(key)) error(`${path}.localBindings[${index}].${key}`, 'unknown_field');
        for (const [key, allowed] of Object.entries(schemas)) if (record(binding[key])) for (const field of Object.keys(binding[key])) if (!allowed.includes(field)) error(`${path}.localBindings[${index}].${key}.${field}`, 'unknown_field');
      });
      if (errors.length !== before) { consumers[name] = {status:'invalid'}; continue; }
    }
    if (name === 'taskTriage' && record(section.limits)) {
      const limits = TASK_TRIAGE_LIMITS;
      for (const key of Object.keys(section.limits)) if (!Object.hasOwn(limits,key)) error(`${path}.limits.${key}`,'unknown_field');
      for (const [key, value] of Object.entries(limits)) if (section.limits[key] !== value) error(`${path}.limits.${key}`);
      if (errors.length !== before) { consumers[name] = {status:'invalid'}; continue; }
    }
    try {
      let config;
      if (name === 'watchdog') {
        if (!['off', 'shadow', 'active'].includes(section.mode)) { error(`${path}.mode`); throw new Error(); }
        config = section;
      } else if (name === 'proactiveReview') config = parseProactiveConfig({ version: 1, ...section });
      else if (name === 'dispatchTriage') {
        if (section.profile && Object.keys(section.profile).some(k => !['version','approved','evidence','provider','model','languages','domains','minConfidence','minMargin','securityThreshold','destructiveThreshold'].includes(k))) {
          for (const key of Object.keys(section.profile)) if (!['version','approved','evidence','provider','model','languages','domains','minConfidence','minMargin','securityThreshold','destructiveThreshold'].includes(key)) error(`${path}.profile.${key}`, 'unknown_field');
          throw new Error();
        }
        config = parseTriageConfig({ version: 1, ...section });
        if (!config) throw new Error();
      } else {
        const parsed = parseTaskTriageConfig({ version: 1, provider: value.provider, model: value.model, ...section });
        if (parsed.status === 'invalid') throw new Error();
        config = { version: 1, provider: value.provider, model: value.model, ...section };
      }
      const status = config.mode === 'off' || (name === 'taskTriage' && !config.remoteContextApproved) ? 'off' : 'ready';
      consumers[name] = { status, config };
    } catch (failure) {
      const field = { 'Invalid include scope':'include', 'Explicit include scope required':'include', 'Invalid remoteContext':'remoteContext', 'Invalid session budget':'maxEvaluationsPerSession', 'Invalid local bindings':'localBindings', 'Invalid local binding schema':'localBindings', 'Invalid local binding values':'localBindings' }[failure.message];
      if (errors.length === before) error(field ? `${path}.${field}` : path, 'invalid_section');
      consumers[name] = { status: 'invalid' };
    }
  }
  return deepFreeze({ status: value.mode === 'off' ? 'off' : 'ready', document, provider, consumers, errors });
}
