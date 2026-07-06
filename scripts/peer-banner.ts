// scripts/peer-banner.ts
//
// Print a colored identity banner for a peer pane. Called by the hidden
// `just _peer`/`_peer-plus` recipes right before exec'ing pi, so every pane
// announces who lives in it. Never fails the recipe: any problem (missing
// persona, unreadable file) degrades to a plain banner and exit 0.
//
// usage: peer-banner.ts <persona> [<name>]

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { parsePersonaFrontmatter, renderBanner } from "./lib/persona-banner.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

function main(): void {
	const [persona, nameArg] = process.argv.slice(2);
	if (!persona) return;
	const name = nameArg || persona;

	let meta = {};
	for (const dir of ["agents", path.join(".pi", "agents")]) {
		const p = path.join(REPO_ROOT, dir, `${persona}.md`);
		try {
			meta = parsePersonaFrontmatter(fs.readFileSync(p, "utf-8"));
			break;
		} catch {
			// try the next location; fall through to a plain banner
		}
	}

	const width = process.stdout.columns ? Math.min(process.stdout.columns, 100) : 60;
	for (const line of renderBanner(name, meta, width)) console.log(line);
}

const isEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntry) main();
