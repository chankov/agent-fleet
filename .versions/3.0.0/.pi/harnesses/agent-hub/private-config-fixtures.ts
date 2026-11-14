import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOLS } from '../../agent-fleet/scripts/lib/fleet-codex-local-mcp.ts';
import { desktopQueuePin } from '../../agent-fleet/scripts/lib/codex-desktop-queue-host.ts';
import { targetKey } from '../../agent-fleet/scripts/lib/fleet-codex-instruction-store.ts';

/** Isolated HOME, Git repository and inert configuration. Never opens a socket/runtime. */
export function privateFixture(t: any) {
 const home = mkdtempSync(join(tmpdir(), 'private-config-'));
 const oldHome = process.env.HOME; process.env.HOME = home;
 t.after(() => { if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome; rmSync(home, { recursive: true, force: true }); });
 const cwd = join(home, 'repo'); mkdirSync(cwd); execFileSync('git', ['init', '-q'], { cwd });
 writeFileSync(join(cwd, '.gitignore'), '.pi/agent-sessions/\n');
 const session = join(cwd, '.pi/agent-sessions/sessions/fixture'); mkdirSync(session, { recursive: true, mode: 0o700 });
 const source = '.pi/agent-sessions/sessions/fixture/check.mjs'; writeFileSync(join(cwd, source), '/* inert verifier source */\n', { mode: 0o600 });
 const folder = join(home, '.local/state/agent-fleet/codex-events/11111111-1111-4111-8111-111111111111/fixture-owner');
 mkdirSync(folder, { recursive: true, mode: 0o700 });
 const owner = { project: 'fixture', peer: 'hub', sessionId: 'session', startedAt: '2026-11-04T00:00:00Z' };
 const config = { optedIn: true, stateRoot: join(home, 'state'), socketPath: join(home, 'unused.sock'), messageBudgetMs: 30000,
  loadedCatalog: { tools: TOOLS.map(t => ({ name: t.name })), identity: 'host_context_validated', nodeVersion: '25.2.1', protocolVersion: '2025-06-18' },
  approval: { binding: { id: 'fixture', epoch: 'epoch', hostInstance: 'fixture-host', threadId: '11111111-1111-4111-8111-111111111111', fleetOwner: targetKey(owner) }, target: owner, authorityRevision: 1, confirmedUntil: Date.now() + 3600000, transportOrigin: 'user_input', mappingEvidence: 'externally_confirmed_loaded_desktop', daemonVersion: desktopQueuePin.daemon, desktopVersion: desktopQueuePin.desktop, addSchema: desktopQueuePin.addSchema, responseSchema: desktopQueuePin.responseSchema } };
 const file = join(folder, 'notification-fixture.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
 return { home, cwd, session, folder, file, source, config };
}
