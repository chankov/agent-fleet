// Shared offline installation authority. Human configuration remains workspace-local.
// @ts-nocheck
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { checkedSourcePath, safeSourceRead } from './safe-source-read.js';

export const INSTALLATION_STATE_MAX_BYTES = 1024 * 1024;
export function validateInstallationOwner(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || value.includes('\\') || value.includes('\0') || /^[A-Za-z]:/.test(value)
      || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('installationOwner must be a concrete normalized relative directory');
  }
  return value;
}
function present(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function desired(root) {
  const path = join(root, '.ai/agent-fleet.json');
  if (!present(path)) return null;
  const value = JSON.parse(safeSourceRead(root, path, 64 * 1024).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_desired');
  return value;
}
/** Read at each session/read boundary. Never returns state in invalid results.
 * @returns {{status: string, explicitOwner: boolean, localStatePresent: boolean, ownerRoot?: string, statePath?: string, runtimeRoot?: string, reason?: string, state?: any}}
 */
export function readInstallationState(workspace, { afterStateRead = () => {}, readState = true } = {}) {
  const result = { status: 'invalid', explicitOwner: false, localStatePresent: false };
  try {
    if (!present(workspace)) return { ...result, status: 'missing', reason: 'missing_state' };
    const root = realpathSync(workspace);
    result.ownerRoot = root;
    result.statePath = join(root, '.ai/agent-fleet-state.json');
    // Even missing files must not turn a linked human configuration root into consent.
    if (present(join(root, '.ai')) && !lstatSync(join(root, '.ai')).isDirectory()) throw Error('source_denied');
    const config = desired(root);
    const configIdentity = JSON.stringify(config);
    let ownerConfigIdentity;
    result.explicitOwner = config !== null && Object.hasOwn(config, 'installationOwner');
    if (result.explicitOwner) {
      const owner = join(root, validateInstallationOwner(config.installationOwner));
      result.ownerRoot = owner;
      result.statePath = join(owner, '.ai/agent-fleet-state.json');
      result.localStatePresent = present(join(root, '.ai/agent-fleet-state.json'));
      checkedSourcePath(root, owner);
      if (!lstatSync(owner).isDirectory() || !lstatSync(join(owner, '.ai')).isDirectory()) throw Error('source_denied');
      checkedSourcePath(root, join(owner, '.ai'));
      const runtime = realpathSync(join(root, '.pi'));
      if (runtime !== realpathSync(join(owner, '.pi')) || !lstatSync(runtime).isDirectory()) throw Error('runtime_mismatch');
      const ownerConfig = desired(owner);
      ownerConfigIdentity = JSON.stringify(ownerConfig);
      if (ownerConfig && Object.hasOwn(ownerConfig, 'installationOwner')) throw Error('owner_chain');
      result.runtimeRoot = runtime;
    }
    if (!readState) return { ...result, status: result.explicitOwner ? 'shared' : 'local' };
    if (!present(result.statePath)) return { ...result, status: 'missing', reason: result.explicitOwner ? 'missing_owner_state' : 'missing_state' };
    const check = () => {
      if (JSON.stringify(desired(root)) !== configIdentity) throw Error('source_changed');
      if (result.explicitOwner) {
        if (JSON.stringify(desired(result.ownerRoot)) !== ownerConfigIdentity) throw Error('source_changed');
        checkedSourcePath(root, result.ownerRoot);
        if (realpathSync(join(root, '.pi')) !== result.runtimeRoot || realpathSync(join(result.ownerRoot, '.pi')) !== result.runtimeRoot) throw Error('source_changed');
      }
    };
    const state = JSON.parse(safeSourceRead(root, result.statePath, INSTALLATION_STATE_MAX_BYTES, check, afterStateRead).toString('utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state) || ![1, 2].includes(state.schemaVersion)) throw Error('unsupported_state_schema');
    if (state.taskTriageSelected !== undefined && typeof state.taskTriageSelected !== 'boolean') throw Error('invalid_selection');
    return { ...result, status: result.explicitOwner ? 'shared' : 'local', state };
  } catch (error) {
    // Codes only: JSON errors may otherwise expose fragments of private payloads.
    const reason = ['source_denied', 'source_changed', 'state_too_large', 'runtime_mismatch', 'owner_chain', 'unsupported_state_schema', 'invalid_selection'].includes(error.message) ? error.message : 'invalid_owner_evidence';
    return { ...result, status: 'invalid', reason };
  }
}

/** Mutation is never redirected, even if owner evidence is currently missing. */
export function assertInstallationOwner(workspace, operation = 'installation operation') {
  const result = readInstallationState(workspace, { readState: false });
  if (result.explicitOwner) throw Error(`${operation} requires the installation owner; run the same operation with --workspace ${result.ownerRoot ?? workspace}`);
  if (result.status === 'invalid') throw Error(`${operation}: invalid installation owner/state evidence (${result.reason})`);
}
