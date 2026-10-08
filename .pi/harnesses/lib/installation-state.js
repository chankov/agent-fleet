// Workspace-local installation evidence, shared by the CLI and runtime.
// @ts-nocheck
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { safeSourceRead } from './safe-source-read.js';

export const INSTALLATION_STATE_MAX_BYTES = 1024 * 1024;
export const RETIRED_INSTALLATION_OWNER_MESSAGE = 'installationOwner is no longer supported; use a standalone installation in the workspace (for multiple repositories, install at their common parent). No state is redirected or migrated automatically.';
export function rejectInstallationOwner(config) {
  if (config && Object.hasOwn(config, 'installationOwner')) throw Error(RETIRED_INSTALLATION_OWNER_MESSAGE);
}
function present(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function desired(root) {
  const path = join(root, '.ai/agent-fleet.json');
  if (!present(path)) return null;
  const value = JSON.parse(safeSourceRead(root, path, 64 * 1024).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_desired');
  rejectInstallationOwner(value);
  return value;
}
/** Read afresh at each boundary. Invalid evidence never returns a state payload.
 * @returns {{status: string, workspaceRoot?: string, statePath?: string, reason?: string, state?: any}}
 */
export function readInstallationState(workspace, { afterStateRead = () => {}, readState = true } = {}) {
  const result = { status: 'invalid' };
  try {
    if (!present(workspace)) return { status: 'missing', reason: 'missing_state' };
    const root = realpathSync(workspace);
    result.workspaceRoot = root;
    result.statePath = join(root, '.ai/agent-fleet-state.json');
    // Linked human configuration must never become consent, even without state.
    if (present(join(root, '.ai')) && !lstatSync(join(root, '.ai')).isDirectory()) throw Error('source_denied');
    const configIdentity = JSON.stringify(desired(root));
    if (!readState) return { ...result, status: 'local' };
    if (!present(result.statePath)) return { ...result, status: 'missing', reason: 'missing_state' };
    const check = () => {
      if (JSON.stringify(desired(root)) !== configIdentity) throw Error('source_changed');
    };
    const state = JSON.parse(safeSourceRead(root, result.statePath, INSTALLATION_STATE_MAX_BYTES, check, afterStateRead).toString('utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state) || ![1, 2].includes(state.schemaVersion)) throw Error('unsupported_state_schema');
    if (state.taskTriageSelected !== undefined && typeof state.taskTriageSelected !== 'boolean') throw Error('invalid_selection');
    return { ...result, status: 'local', state };
  } catch (error) {
    // JSON errors may expose private fragments; return only known codes.
    const reason = error.message === RETIRED_INSTALLATION_OWNER_MESSAGE ? 'installation_owner_removed'
      : ['source_denied', 'source_changed', 'state_too_large', 'unsupported_state_schema', 'invalid_selection'].includes(error.message) ? error.message : 'invalid_installation_evidence';
    return { ...result, status: 'invalid', reason };
  }
}

/** Refuse retired/unsafe layouts before mutation, without blocking state recovery. */
export function assertLocalInstallation(workspace, operation = 'installation operation') {
  const result = readInstallationState(workspace, { readState: false });
  if (result.status !== 'invalid') return;
  throw Error(`${operation}: ${result.reason === 'installation_owner_removed' ? RETIRED_INSTALLATION_OWNER_MESSAGE : `invalid local installation evidence (${result.reason})`}`);
}
