/**
 * node --test exits 0 when one named path is missing and another resolves.
 * Callers that name a deliverable must fail before that silent pass.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function missingNamedTests(paths) {
  return paths.filter((path) => !existsSync(path));
}

export function runNamedTests(paths, extraArgs = [], options = {}) {
  const missing = missingNamedTests(paths);
  if (missing.length > 0) {
    console.error(`named tests missing:\n${missing.join("\n")}`);
    return 2;
  }
  const env = { ...(options.env ?? process.env) };
  for (const key of Object.keys(env)) if (key.startsWith("NODE_TEST")) delete env[key];
  const result = spawnSync(process.execPath, [...extraArgs, "--test", ...paths], {
    stdio: options.stdio ?? "inherit",
    cwd: options.cwd,
    env,
  });
  return result.status ?? 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const status = runNamedTests(process.argv.slice(2));
  process.exit(status);
}
