import { closeSync, constants, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { normalizeSystem1Config } from '../../.pi/harnesses/lib/system1/config-v2.js';
import { parseConfigJson } from '../../.pi/harnesses/lib/system1/config-json.js';
import { assertSafeWorkspaceTarget, assertWorkspaceRootSafe } from './workspace-safety.js';
import { assertPlanFingerprints, capturePlanFingerprints, runTransaction } from './transaction.js';
export const SYSTEM1_MIGRATION_PATHS = Object.freeze(['.ai/system1.json', '.ai/proactive-review.json', '.ai/dispatch-triage.json', '.ai/task-triage.json', '.ai/agent-fleet-overrides.md']);
const migrationError = (message, exitCode = 1) => Object.assign(new Error(message), { exitCode });
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function migrationPreviewDigest(plan) {
  return createHash('sha256').update(JSON.stringify(canonical({ workspace: plan.workspace, status: plan.status, target: plan.target, operations: plan.operations, fingerprints: plan.fingerprints }))).digest('hex');
}
function finalizePlan(plan) {
  plan.fingerprints = capturePlanFingerprints(plan, { items: [] });
  plan.digest = migrationPreviewDigest(plan);
  return plan;
}
function readInput(workspace, relative) {
  const path = assertSafeWorkspaceTarget(workspace, relative, { allowLeafSymlink: false });
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  if (!stat.isFile()) throw new Error(`${relative} must be a regular file`);
  if (stat.size > 1024 * 1024) throw new Error(`${relative} is too large`);
  return readFileSync(path, 'utf8');
}
/** Remove one recognized legacy key across either section alias, preserving other bytes. */
export function migrateWatchdogOverride(text) {
  if (text === undefined) return { text, mode: undefined };
  let inHub = false, count = 0, mode;
  const output = [];
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const heading = line.replace(/\r?\n$/, '').match(/^##\s+(.+?)\s*$/);
    if (heading) inHub = ['agent-hub', 'agent-team'].includes(heading[1].trim().toLowerCase());
    if (inHub && /^\s*watchdog-system1\s*:/i.test(line)) {
      count++;
      const match = line.match(/^\s*watchdog-system1\s*:\s*(off|shadow|active)\s*(?:\r?\n)?$/i);
      if (!match) throw new Error('Invalid overrides watchdog-system1 value');
      mode = match[1].toLowerCase();
    } else output.push(line);
  }
  if (count > 1) throw migrationError('Duplicate overrides watchdog-system1 across agent-hub/agent-team sections', 3);
  return { text: output.join(''), mode };
}
export function planSystem1Migration(workspace) {
  assertWorkspaceRootSafe(workspace);
  const input = Object.fromEntries(SYSTEM1_MIGRATION_PATHS.map(path => [path, readInput(workspace, path)]));
  const providerText = input['.ai/system1.json'];
  if (providerText === undefined) throw migrationError('Missing .ai/system1.json; migration cannot choose a provider/model. See docs/system1-config.md#consumer-only-legacy-workspaces for manual v2 mode: off instructions; no files changed.');
  const provider = parseConfigJson(providerText);
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) throw migrationError('Invalid provider document');
  const override = migrateWatchdogOverride(input['.ai/agent-fleet-overrides.md']);
  const legacyPaths = SYSTEM1_MIGRATION_PATHS.slice(1,4).filter(path => input[path] !== undefined);
  if (provider.version === 2) {
    const snapshot = normalizeSystem1Config(provider);
    if (snapshot.errors.length) throw new Error(`Invalid v2: ${JSON.stringify(snapshot.errors)}`);
    if (legacyPaths.length || override.mode !== undefined) throw migrationError('v2 plus legacy configuration: explicit conflict resolution required; nothing deleted', 3);
    return finalizePlan({ workspace, verb:'configure', actions:[{files:SYSTEM1_MIGRATION_PATHS.map(path=>({path}))}], operations:[], status:'noop', target:provider });
  }
  if (provider.version !== 1 || Object.keys(provider).length !== 5 || !['version','mode','provider','model','apiKeyEnv'].every(k=>Object.hasOwn(provider,k))) throw new Error('Invalid v1 provider schema');
  const target = { ...provider, version:2, consumers:{} };
  if (override.mode !== undefined) target.consumers.watchdog = { mode:override.mode };
  for (const [name,path] of [['proactiveReview','.ai/proactive-review.json'],['dispatchTriage','.ai/dispatch-triage.json'],['taskTriage','.ai/task-triage.json']]) {
    if (input[path] === undefined) continue;
    const legacy = parseConfigJson(input[path]);
    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || legacy.version !== 1) throw new Error(`Invalid legacy schema: ${path}`);
    const { version, ...section } = legacy;
    if (name === 'taskTriage') {
      if (section.provider !== provider.provider || section.model !== provider.model) throw migrationError(`${path}: provider/model conflict`, 3);
      delete section.provider; delete section.model;
    }
    target.consumers[name] = section;
  }
  const snapshot = normalizeSystem1Config(target);
  if (snapshot.errors.length || !['off','ready'].includes(snapshot.status)) throw new Error(`Invalid migration inputs: ${JSON.stringify(snapshot.errors)}`);
  const operations = [{path:'.ai/system1.json',text:JSON.stringify(target,null,2)+'\n'}, ...legacyPaths.map(path=>({path,remove:true}))];
  if (override.mode !== undefined) operations.push({path:'.ai/agent-fleet-overrides.md',text:override.text});
  const plan = { workspace, verb:'configure', actions:[{files:SYSTEM1_MIGRATION_PATHS.map(path=>({path}))}], operations, target, status:'migration', preserveBackup:true };
  return finalizePlan(plan);
}
export function applySystem1Migration(plan, { failAt = null, lockHeld = false, expectDigest = plan.digest } = {}) {
  if (expectDigest !== plan.digest || plan.digest !== migrationPreviewDigest(plan)) throw migrationError('System1 migration preview digest mismatch; inputs or target changed. Run --dry-run again and use its --expect-digest.', 3);
  if (plan.status === 'noop') { assertPlanFingerprints(plan, { items: [] }); return {status:'noop'}; }
  return runTransaction({workspace:plan.workspace,plan,manifest:{items:[]},lockHeld,
    failAt: ['after-journal','after-commit','after-durable-commit'].includes(failAt) ? failAt : null,
    validate:()=> { if (normalizeSystem1Config(plan.target).errors.length) throw new Error('Invalid migration target'); },
    commit:()=> {
      for (const [index, operation] of plan.operations.entries()) {
        const path = assertSafeWorkspaceTarget(plan.workspace,operation.path,{allowLeafSymlink:false});
        if (operation.remove) rmSync(path); else writeFileSync(path,operation.text,{mode:0o600,flag:constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW});
        // Persist both content and directory changes before the committed journal phase.
        for (const durablePath of operation.remove ? [dirname(path)] : [path, dirname(path)]) {
          const fd = openSync(durablePath, 'r');
          try { fsyncSync(fd); } finally { closeSync(fd); }
        }
        if (failAt === `operation-${index}`) throw new Error('injected migration interruption');
      }
      const saved = parseConfigJson(readInput(plan.workspace,'.ai/system1.json'));
      if (normalizeSystem1Config(saved).errors.length) throw new Error('Written migration target invalid');
      return {status:'migrated', backup:plan.backup, paths:plan.operations.map(o=>o.path)};
    }
  });
}
