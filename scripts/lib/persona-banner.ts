// scripts/lib/persona-banner.ts
//
// Pure logic for the per-pane identity banner (`just _peer`/`_peer-plus`
// print it before exec'ing pi): persona frontmatter → colored ANSI banner.
// Frontmatter parsing mirrors the coms harness convention (name /
// description / color, quoted values allowed). Backend-agnostic — works in
// any terminal, inside or outside herdr.

export interface PersonaMeta {
	name?: string;
	description?: string;
	color?: string;
}

export function parsePersonaFrontmatter(raw: string): PersonaMeta {
	const match = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!match) return {};
	const fm: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			const key = line.slice(0, idx).trim();
			let val = line.slice(idx + 1).trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			fm[key] = val;
		}
	}
	return { name: fm.name, description: fm.description, color: fm.color };
}

export function isValidHex(hex: string): boolean {
	return /^#[0-9a-fA-F]{6}$/.test(hex);
}

function hexFg(hex: string, s: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `\x1b[38;2;${r};${g};${b}m${s}\x1b[0m`;
}

const DEFAULT_COLOR = "#36F9F6";

// Colored banner lines for a peer pane: name in the persona color, purpose
// dimmed below, framed by a rule in the same color. `width` caps the rule so
// narrow panes don't wrap.
export function renderBanner(
	peerName: string,
	meta: PersonaMeta,
	width = 60,
): string[] {
	const color = meta.color && isValidHex(meta.color) ? meta.color : DEFAULT_COLOR;
	const purpose = (meta.description ?? "").trim();
	const rule = hexFg(color, "━".repeat(Math.max(8, Math.min(width, 100))));
	const title = hexFg(color, `● ${peerName}`);
	const lines = [rule, title];
	if (purpose) lines.push(`\x1b[2m${purpose}\x1b[0m`);
	lines.push(rule);
	return lines;
}
