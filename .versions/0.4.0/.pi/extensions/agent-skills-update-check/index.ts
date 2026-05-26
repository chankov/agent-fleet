// agent-skills-update-check — pi extension that surfaces an "update available"
// banner once per session when @chankov/agent-skills has a newer published
// version than the one recorded in .ai/agent-skills-setup.md.
//
// Design constraints:
//   - Never blocks pi startup. The check runs once on the first agent_start
//     event with a soft 3s timeout.
//   - Shares the same XDG cache file as the CLI (~/.cache/agent-skills/
//     latest-version.json) so the CLI and pi don't double-fetch.
//   - Honors AGENT_SKILLS_NO_UPDATE_CHECK / NO_UPDATE_NOTIFIER / CI opt-outs.
//   - Network errors, missing record files, and missing node-fetch all fall
//     through to "do nothing" — never an error notification.

import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';

const PACKAGE_NAME = '@chankov/agent-skills';
const REGISTRY = 'https://registry.npmjs.org';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3000;

const CACHE_DIR = join(
	process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
	'agent-skills',
);
const CACHE_FILE = join(CACHE_DIR, 'latest-version.json');

interface CachePayload {
	latest: string;
	checkedAt: number;
}

export default function updateCheckExtension(pi: ExtensionAPI) {
	let checked = false;

	pi.on('agent_start', async (_event, ctx) => {
		if (checked) return;
		checked = true;

		try {
			await runCheck(ctx);
		} catch {
			// Update checks must never disrupt a session — swallow everything.
		}
	});
}

async function runCheck(ctx: ExtensionContext): Promise<void> {
	if (isDisabled()) return;

	const recorded = readRecordedVersion();
	if (!recorded) return; // workspace was never set up via /setup — nothing to compare

	let latest = readCacheFresh();
	if (!latest) {
		latest = await fetchLatest(FETCH_TIMEOUT_MS);
		if (latest) writeCache({ latest, checkedAt: Date.now() });
	}
	if (!latest) return;

	if (!isGreater(latest, recorded)) return;

	ctx.ui.notify(
		`agent-skills update available: ${recorded} → ${latest}. ` +
		`Run "npx ${PACKAGE_NAME}@latest update" then /setup to apply.`,
		'info',
	);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isDisabled(): boolean {
	return process.env.AGENT_SKILLS_NO_UPDATE_CHECK === '1'
		|| process.env.NO_UPDATE_NOTIFIER === '1'
		|| process.env.CI === 'true';
}

function readRecordedVersion(): string | null {
	// pi runs from the workspace root; the install record lives at .ai/...
	const recordPath = join(process.cwd(), '.ai', 'agent-skills-setup.md');
	if (!existsSync(recordPath)) return null;
	try {
		const text = readFileSync(recordPath, 'utf8');
		const m = text.match(/^version:\s*([^\s#]+)/m);
		return m ? m[1].trim() : null;
	} catch {
		return null;
	}
}

function readCacheFresh(): string | null {
	try {
		if (!existsSync(CACHE_FILE)) return null;
		const payload = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) as CachePayload;
		if (Date.now() - payload.checkedAt >= CACHE_TTL_MS) return null;
		return payload.latest;
	} catch {
		return null;
	}
}

function writeCache(payload: CachePayload): void {
	try {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(payload, null, 2), 'utf8');
	} catch {
		// Cache write failed — fine, we'll re-fetch next session.
	}
}

function fetchLatest(timeoutMs: number): Promise<string | null> {
	return new Promise((resolve) => {
		const url = `${REGISTRY}/${encodeURIComponent(PACKAGE_NAME).replace('%40', '@')}/latest`;
		const req = request(
			url,
			{ method: 'GET', headers: { accept: 'application/json' } },
			(res) => {
				if (res.statusCode !== 200) {
					res.resume();
					resolve(null);
					return;
				}
				let body = '';
				res.setEncoding('utf8');
				res.on('data', (chunk) => { body += chunk; });
				res.on('end', () => {
					try {
						const parsed = JSON.parse(body);
						resolve(typeof parsed.version === 'string' ? parsed.version : null);
					} catch {
						resolve(null);
					}
				});
			},
		);
		req.on('error', () => resolve(null));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve(null);
		});
		req.end();
	});
}

function isGreater(a: string, b: string): boolean {
	const [aMain, aPre = ''] = a.split('-', 2);
	const [bMain, bPre = ''] = b.split('-', 2);
	const aParts = aMain.split('.').map(Number);
	const bParts = bMain.split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const ai = aParts[i] ?? 0;
		const bi = bParts[i] ?? 0;
		if (ai !== bi) return ai > bi;
	}
	if (!aPre && bPre) return true;
	if (aPre && !bPre) return false;
	return aPre > bPre;
}
