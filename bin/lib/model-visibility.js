import { spawnSync } from "node:child_process";

let listingCache;

export function checkChildVisibility(models) {
  const listing = loadListing();
  if (listing.diagnostic) {
    return {
      diagnostic: listing.diagnostic,
      models: models.map((model) => ({
        model,
        ok: false,
        failed: [],
        reasons: [`${model}: child-visible check not performed — ${listing.diagnostic}`],
      })),
    };
  }
  const visible = new Set(listing.models ?? []);
  return {
    models: models.map((model) => visible.has(model)
      ? { model, ok: true, failed: [], reasons: [] }
      : {
          model,
          ok: false,
          failed: ["child-visible"],
          reasons: [`${model}: child-visible check failed — not listed by pi --no-extensions --list-models`],
        }),
  };
}

function loadListing() {
  if (listingCache) return listingCache;
  try { listingCache = listModels(); }
  catch (error) { listingCache = { diagnostic: error instanceof Error ? error.message : String(error) }; }
  return listingCache;
}

function listModels() {
  const result = spawnSync("pi", ["--no-extensions", "--list-models"], {
    encoding: "utf8",
    timeout: 15_000,
  });
  if (result.error) {
    return { diagnostic: `pi --no-extensions --list-models failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return { diagnostic: `pi --no-extensions --list-models failed: ${detail}` };
  }
  return { models: parseListModelsOutput(result.stdout) };
}

function parseListModelsOutput(text) {
  const cleaned = text.replace(/\u001B\[[0-9;]*m/g, "");
  const lines = cleaned.split(/\r?\n/).map((line) => line.trimEnd()).filter((line) => line.trim());
  if (lines.length === 0) return [];
  const models = new Set();
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || (parts[0] === "provider" && parts[1] === "model")) continue;
    models.add(`${parts[0]}/${parts[1]}`);
  }
  return [...models];
}
