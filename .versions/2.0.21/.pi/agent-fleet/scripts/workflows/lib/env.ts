import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function parseEnv(text: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) continue;
		let value = match[2].trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			const quote = value[0];
			value = value.slice(1, -1);
			if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		values[match[1]] = value;
	}
	return values;
}

export function loadEnv(cwd = process.cwd(), env: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const file = resolve(cwd, ".env");
	if (!existsSync(file)) return {};
	const loaded: Record<string, string> = {};
	for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
		if (env[key] !== undefined) continue;
		env[key] = value;
		loaded[key] = value;
	}
	return loaded;
}
