import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  STT_PROVIDERS,
  appendEnvPlaceholders,
  planStt,
  readSttConfig,
  renderSttConfig,
  validateSttConfig,
} from "../lib/stt-wizard.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(repoRoot, "bin/cli.js");

const workspace = () => mkdtempSync(join(tmpdir(), "af-stt-"));
const azureOpenAiFixture = `{
  "language": "bg-BG",
  "capture": {
    "inputFormat": "pulse",
    "input": "alsa_input.usb-0c76_Razer_Seiren_Mini-00.mono-fallback",
    "maxSeconds": 300
  },
  "provider": {
    "type": "azure-openai",
    "endpoint": "https://fd-ai-credits.openai.azure.com",
    "deployment": "gpt-4o-transcribe",
    "apiVersion": "2025-03-01-preview",
    "apiKeyEnv": "AZURE_SPEECH_KEY"
  }
}`;

function writeConfig(root, text) {
  mkdirSync(join(root, ".ai"), { recursive: true });
  writeFileSync(join(root, ".ai/stt.json"), text);
}

test("canonical Azure OpenAI config is extracted without mutation and planned byte-for-byte", () => {
  const root = workspace();
  writeConfig(root, azureOpenAiFixture);
  const read = readSttConfig(root);
  assert.equal(read.text, azureOpenAiFixture);
  assert.equal(read.providerType, "azure-openai");
  assert.equal(read.providerAlias, "azure-openai");
  assert.notEqual(read.config.provider, JSON.parse(azureOpenAiFixture).provider);

  const plan = planStt(root);
  assert.equal(plan.write, false);
  assert.equal(plan.preserved, true);
  assert.equal(plan.provider, "azure-openai");
  assert.equal(readFileSync(join(root, ".ai/stt.json"), "utf8"), azureOpenAiFixture);
  assert.deepEqual(plan.env.missing, ["AZURE_SPEECH_KEY"]);
});

test("supported legacy configs are classified and preserved without automatic migration", () => {
  for (const [provider, fields] of Object.entries({
    openai: { apiKeyEnv: "TEAM_OPENAI_KEY" },
    groq: { apiKeyEnv: "TEAM_GROQ_KEY" },
    azure: { apiKeyEnv: "TEAM_AZURE_KEY", endpointEnv: "TEAM_AZURE_ENDPOINT" },
  })) {
    const root = workspace();
    const original = JSON.stringify({ provider, ...fields, custom: { keep: true } }, null, 4) + "\n";
    writeConfig(root, original);
    const read = readSttConfig(root);
    assert.equal(read.format, "legacy");
    assert.equal(read.providerAlias, provider);
    assert.match(read.warning, /legacy/i);
    const plan = planStt(root, provider);
    assert.equal(plan.write, false);
    assert.equal(readFileSync(join(root, ".ai/stt.json"), "utf8"), original);
  }
});

test("all runtime provider types validate with defaults while aliases remain distinct", () => {
  for (const provider of [
    { type: "openai" },
    { type: "openai-compatible", baseUrl: "http://127.0.0.1:8080/v1", model: "whisper" },
    { type: "azure" },
    { type: "azure-openai", deployment: "whisper-prod" },
  ]) assert.deepEqual(validateSttConfig({ provider }).provider, provider);

  assert.deepEqual(Object.keys(STT_PROVIDERS), ["openai", "groq", "azure", "azure-openai"]);
  assert.equal(STT_PROVIDERS.groq.runtimeType, undefined);
  assert.throws(() => validateSttConfig({ provider: { type: "groq" } }), /provider\.type/);
  assert.throws(() => validateSttConfig({ provider: { type: "azure-openai" } }), /provider\.deployment/);
});

test("known fields, JSON shape, and environment names are validated with field-specific errors", () => {
  assert.throws(() => validateSttConfig(null), /STT config must be an object/);
  assert.throws(() => validateSttConfig([]), /STT config must be an object/);
  assert.throws(() => validateSttConfig({ provider: null }), /provider must be an object or supported legacy provider/);
  assert.throws(() => validateSttConfig({ provider: { type: "SYNTHETIC_PRIVATE_TYPE" } }), (error) => {
    assert.match(error.message, /provider\.type/);
    assert.doesNotMatch(error.message, /SYNTHETIC_PRIVATE_TYPE/);
    return true;
  });
  assert.throws(() => validateSttConfig({ provider: { type: "openai", apiKeyEnv: "bad-name" } }), /provider\.apiKeyEnv/);
  assert.throws(() => validateSttConfig({ provider: { type: "azure", endpoint: 42 } }), /provider\.endpoint must be a string/);
  assert.throws(() => validateSttConfig({ provider: { type: "azure", format: "verbose" } }), /provider\.format/);
  assert.throws(() => validateSttConfig({ provider: { type: "azure", locales: ["bg-BG", 4] } }), /provider\.locales/);
  assert.throws(() => validateSttConfig({ provider: { type: "openai" }, capture: [] }), /capture must be an object/);

  const root = workspace();
  writeConfig(root, "{ definitely not json");
  assert.throws(() => readSttConfig(root), /invalid \.ai\/stt\.json: invalid JSON; repair it manually/);
});

test("safe unknown fields and keybind pass while nested secrets are rejected without disclosure", () => {
  const valid = { keybind: "alt+s", provider: { type: "openai" }, _docs: { apiKeyEnv: "DOC_KEY" }, unknown: true };
  assert.deepEqual(validateSttConfig(valid), valid);

  const marker = "sk-SYNTHETIC_DO_NOT_PRINT";
  for (const invalid of [
    { provider: { type: "openai", apiKey: marker } },
    { provider: { type: "openai" }, nested: { password: marker } },
    { provider: { type: "openai" }, nested: { harmless: marker } },
    { provider: { type: "openai" }, nested: { [`password-${marker}`]: "hidden" } },
  ]) {
    assert.throws(() => validateSttConfig(invalid), (error) => {
      assert.match(error.message, /must not store/);
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    });
  }
});

test("OpenAI generation is nested and other first-time aliases require prepared JSON", () => {
  const root = workspace();
  const plan = planStt(root, "openai");
  assert.deepEqual(JSON.parse(plan.text), { provider: { type: "openai" } });
  assert.equal(plan.provider, "openai");
  assert.deepEqual(plan.env.missing, ["OPENAI_API_KEY"]);
  assert.equal(existsSync(join(root, ".env")), false);

  for (const provider of ["groq", "azure", "azure-openai"]) {
    assert.throws(() => planStt(root, provider), new RegExp(`${provider}.*prepared.*\\.ai/stt\\.json`, "i"));
  }
});

test("approved provider replacement preserves safe root fields and never mixes providers", () => {
  const root = workspace();
  writeConfig(root, JSON.stringify({
    language: "bg-BG",
    capture: { maxSeconds: 300 },
    provider: { type: "azure-openai", endpoint: "https://example.test", deployment: "old", apiKeyEnv: "OLD_KEY" },
    notes: { human: true },
  }, null, 2));
  assert.throws(() => planStt(root, "openai"), /requires explicit approval/);
  const plan = planStt(root, "openai", { replacementApproved: true });
  assert.deepEqual(JSON.parse(plan.text), {
    language: "bg-BG",
    capture: { maxSeconds: 300 },
    provider: { type: "openai" },
    notes: { human: true },
  });
  assert.equal(plan.replacing, "azure-openai");
  assert.deepEqual(plan.env.missing, ["OPENAI_API_KEY"]);
});

test("env planning honors runtime defaults, direct endpoints, exports, values, and repeat planning", () => {
  const root = workspace();
  writeFileSync(join(root, ".env"), "export OPENAI_API_KEY=keep\nAZURE_SPEECH_KEY=also-keep\n");
  const config = { provider: { type: "azure-openai", endpoint: "https://example.test", deployment: "whisper", apiKeyEnv: "AZURE_SPEECH_KEY" } };
  const first = appendEnvPlaceholders(root, config);
  assert.equal(first.text, "export OPENAI_API_KEY=keep\nAZURE_SPEECH_KEY=also-keep\n");
  assert.deepEqual(first.missing, []);
  assert.doesNotMatch(first.text, /AZURE_OPENAI_ENDPOINT/);
  assert.deepEqual(appendEnvPlaceholders(root, { provider: { type: "azure" } }).missing, ["AZURE_SPEECH_ENDPOINT"]);

  const openAi = appendEnvPlaceholders(root, { provider: { type: "openai-compatible" } });
  assert.deepEqual(openAi.missing, []);

  const azureRoot = workspace();
  const azure = { provider: { type: "azure-openai", deployment: "whisper" } };
  const planned = appendEnvPlaceholders(azureRoot, azure);
  assert.deepEqual(planned.missing, ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]);
  writeFileSync(join(azureRoot, ".env"), planned.text);
  const repeated = appendEnvPlaceholders(azureRoot, azure);
  assert.deepEqual(repeated.missing, []);
  assert.equal((repeated.text.match(/AZURE_OPENAI_API_KEY=/g) ?? []).length, 1);
  assert.equal((repeated.text.match(/AZURE_OPENAI_ENDPOINT=/g) ?? []).length, 1);
});

test("rendered STT config contains env names but never secret values", () => {
  const text = renderSttConfig({ provider: { type: "openai", apiKeyEnv: "OPENAI_API_KEY" } });
  assert.match(text, /OPENAI_API_KEY/);
  assert.doesNotMatch(text, /sk-/);
});

function isolatedHome() {
  return mkdtempSync(join(tmpdir(), "af-stt-home-"));
}

function loadRuntimeConfig(workspaceRoot) {
  const configUrl = pathToFileURL(join(workspaceRoot, ".pi/extensions/pi-voice-stt/config.ts")).href;
  const childEnv = { ...process.env, HOME: isolatedHome() };
  delete childEnv.PI_STT_CONFIG;
  delete childEnv.PI_STT_KEYBIND;
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--input-type=module",
    "--eval",
    `const mod = await import(${JSON.stringify(configUrl)});
     const loaded = mod.loadConfig();
     const provider = loaded.config.provider;
     const payload = {
       source: loaded.source,
       language: loaded.config.language,
       capture: loaded.config.capture,
       provider,
       apiKeyEnv: provider ? mod.apiKeyEnvName(provider) : null,
       azureEndpoint: provider && (provider.type === "azure" || provider.type === "azure-openai")
         ? mod.resolveAzureEndpoint(provider)
         : null,
     };
     process.stdout.write(JSON.stringify(payload));`,
  ], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: childEnv,
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test("generated OpenAI and Azure OpenAI fixture pass real runtime loadConfig", () => {
  const openaiWs = workspace();
  const generated = spawnSync(process.execPath, [
    cli, "setup", "--preset", "default", "--features", "voice", "--stt-provider", "openai", "--yes",
    "--workspace", openaiWs,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  const openaiJson = JSON.parse(readFileSync(join(openaiWs, ".ai/stt.json"), "utf8"));
  assert.deepEqual(openaiJson.provider, { type: "openai" });
  const openaiLoaded = loadRuntimeConfig(openaiWs);
  assert.equal(openaiLoaded.provider.type, "openai");
  assert.equal(openaiLoaded.language, "en-US");
  assert.equal(openaiLoaded.capture.maxSeconds, 60);
  assert.equal(openaiLoaded.capture.sampleRate, 16000);
  assert.equal(openaiLoaded.apiKeyEnv, "OPENAI_API_KEY");
  assert.match(openaiLoaded.source, /stt\.json/);

  const azureWs = workspace();
  writeConfig(azureWs, azureOpenAiFixture);
  const preserved = spawnSync(process.execPath, [
    cli, "setup", "--preset", "default", "--features", "voice", "--yes",
    "--workspace", azureWs,
  ], { encoding: "utf8" });
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(readFileSync(join(azureWs, ".ai/stt.json"), "utf8"), azureOpenAiFixture);
  const azureLoaded = loadRuntimeConfig(azureWs);
  assert.equal(azureLoaded.provider.type, "azure-openai");
  assert.equal(azureLoaded.provider.endpoint, "https://fd-ai-credits.openai.azure.com");
  assert.equal(azureLoaded.provider.deployment, "gpt-4o-transcribe");
  assert.equal(azureLoaded.provider.apiVersion, "2025-03-01-preview");
  assert.equal(azureLoaded.apiKeyEnv, "AZURE_SPEECH_KEY");
  assert.equal(azureLoaded.azureEndpoint, "https://fd-ai-credits.openai.azure.com");
  assert.equal(azureLoaded.language, "bg-BG");
  assert.equal(azureLoaded.capture.inputFormat, "pulse");
  assert.equal(azureLoaded.capture.input, "alsa_input.usb-0c76_Razer_Seiren_Mini-00.mono-fallback");
  assert.equal(azureLoaded.capture.maxSeconds, 300);
});
