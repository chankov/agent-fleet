#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { runHermesCommand } from "./lib/set-hermes-telegram.js";
import { setHermesWatchdog } from "./lib/set-hermes-watchdog.js";

const argv = process.argv.slice(2);
const profileIndex = argv.indexOf("--profile");
const profile = profileIndex < 0 ? undefined : argv[profileIndex + 1];
const positionals = argv.filter((value, index) => !value.startsWith("--") && (profileIndex < 0 || index !== profileIndex + 1));
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

try {
  const result = await setHermesWatchdog({
    positionals,
    profile,
    force: argv.includes("--force"),
    dryRun: argv.includes("--dry-run"),
    packageRoot,
    hermes: runHermesCommand,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
