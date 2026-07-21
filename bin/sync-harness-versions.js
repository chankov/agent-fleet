#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_PACKAGE_NAME = "@chankov/agent-fleet";

export const HARNESS_VERSION_MANIFESTS = [
	".pi/harnesses/agent-hub/package.json",
	".pi/harnesses/coms/package.json",
	".pi/harnesses/damage-control-continue/package.json",
];

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function readJson(path, label) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`${label} is missing or unreadable: ${path}`, { cause: error });
	}
	try {
		return JSON.parse(raw);
	} catch (error) {
		throw new Error(`${label} is malformed JSON: ${path}`, { cause: error });
	}
}

function validateVersion(version, label) {
	if (typeof version !== "string" || !SEMVER.test(version)) {
		throw new Error(`${label} must contain a valid semantic version`);
	}
	return version;
}

function rootVersion(sourceRoot) {
	const pkg = readJson(join(sourceRoot, "package.json"), "root package.json");
	if (pkg.name !== ROOT_PACKAGE_NAME) {
		throw new Error(`root package.json name must be ${ROOT_PACKAGE_NAME}`);
	}
	return validateVersion(pkg.version, "root package.json");
}

/**
 * Stamp the three UI-owning harness manifests from the canonical root version.
 * `check` is read-only and throws when a derived stamp has drifted.
 */
export function syncHarnessVersions(sourceRoot = root, { check = false } = {}) {
	const version = rootVersion(sourceRoot);
	const results = [];
	for (const relativeManifest of HARNESS_VERSION_MANIFESTS) {
		const path = join(sourceRoot, relativeManifest);
		const manifest = readJson(path, `harness manifest ${relativeManifest}`);
		if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
			throw new Error(`harness manifest ${relativeManifest} must be a JSON object`);
		}
		if (check) {
			if (manifest.version !== version) {
				throw new Error(`${relativeManifest} version ${JSON.stringify(manifest.version)} does not match root version ${version}`);
			}
			results.push({ path: relativeManifest, changed: false });
			continue;
		}
		if (manifest.version !== version) {
			manifest.version = version;
			writeFileSync(path, `${JSON.stringify(manifest, null, "\t")}\n`, "utf8");
			results.push({ path: relativeManifest, changed: true });
		} else {
			results.push({ path: relativeManifest, changed: false });
		}
	}
	return { version, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = new Set(process.argv.slice(2));
	if ([...args].some((arg) => arg !== "--check")) {
		console.error("usage: node bin/sync-harness-versions.js [--check]");
		process.exitCode = 1;
	} else {
		try {
			const { version, results } = syncHarnessVersions(root, { check: args.has("--check") });
			for (const result of results) {
				console.log(`${args.has("--check") ? "checked" : result.changed ? "stamped" : "unchanged"}: ${result.path} → ${version}`);
			}
		} catch (error) {
			console.error(`harness-version-sync: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 1;
		}
	}
}
