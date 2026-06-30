# pi-voice-stt

Push-to-talk voice dictation for pi's terminal UI. Press a hotkey, speak, and the
transcript is inserted into the prompt — or transcribed and sent in one step.

A simplified, self-contained port of [`cgarrot/pi-voice-stt`](https://github.com/cgarrot/pi-voice-stt),
trimmed to **two** transcription backends and adapted to this repo's pi runtime.

## How it works

The mic is recorded to a temporary 16 kHz mono PCM WAV via `ffmpeg`, the WAV is sent to
the configured provider, and the returned text goes into the editor. There is no native
dependency and no build step — pi loads the TypeScript directly.

## Controls

| Key / command | Action |
| --- | --- |
| **Alt+S** | Start recording; press again to **transcribe and insert** into the prompt |
| **Enter** (while recording) | Transcribe and **send** immediately |
| **Esc** (while recording) | Cancel — discard the recording |
| `/stt status` | Show config + current state |
| `/stt doctor` | Check `ffmpeg`, provider, and API key |
| `/stt start` · `stop` · `send` · `cancel` | Drive the state machine without the hotkey |

While recording, a `● REC m:ss` indicator animates in the status bar; during transcription
it shows a moving `transcribing…` dot.

> The hotkey is bound **only when a provider is configured**. Until then the extension is a
> silent no-op — `/stt doctor` still works to guide setup.

## Requirements

- `ffmpeg` on `PATH` (or set `capture.ffmpegPath`).
- A configured provider (below).

## Configuration

Config is resolved in this order (first hit wins):

1. `PI_STT_CONFIG` — inline JSON (starts with `{`) or a path to a JSON file
2. `<cwd>/.ai/stt.json` — project-local config (what guided setup writes)
3. `~/.pi/agent/stt.json` — global config
4. built-in defaults

Secrets are **never** stored in the file: the config names an environment variable and the
key is read from the process environment — a gitignored `.env` at the repo root, auto-loaded by
the `justfile`'s `dotenv-load`. See [`examples/stt.json`](examples/stt.json).

> **Guided setup** can write the `.ai/stt.json` + `.env` for you — pick `pi-voice-stt` in
> `/setup-agent-skills` and answer the provider prompts. See
> [docs/agent-skills-setup.md](../../../docs/agent-skills-setup.md).

### Option 1 — Generic OpenAI-compatible endpoint

Works with OpenAI Whisper, Groq, and local servers (`whisper.cpp`, `faster-whisper`) that
expose `POST /v1/audio/transcriptions`.

```json
{
  "language": "en-US",
  "provider": {
    "type": "openai",
    "baseUrl": "https://api.openai.com/v1",
    "model": "whisper-1",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

Point `baseUrl` at `http://127.0.0.1:8080/v1` for a local server — plain HTTP is allowed for
loopback hosts only; everything else must be HTTPS.

### Option 2 — Azure Speech (speech-to-text)

Uses the Azure [REST API for short audio](https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short)
(≤ 60 s per utterance, final result only). The recorder already produces the required
16 kHz mono PCM WAV.

```json
{
  "language": "en-US",
  "provider": {
    "type": "azure",
    "endpoint": "https://<resource>.cognitiveservices.azure.com",
    "apiKeyEnv": "AZURE_SPEECH_KEY",
    "format": "detailed"
  }
}
```

Then set the secrets in your environment:

```sh
export AZURE_SPEECH_ENDPOINT="https://<resource>.cognitiveservices.azure.com"  # used if `endpoint` is omitted
export AZURE_SPEECH_KEY="<your-resource-key>"
```

The request posts the WAV to
`{endpoint}/stt/speech/recognition/conversation/cognitiveservices/v1?language=<lang>&format=<format>`
with the `Ocp-Apim-Subscription-Key` header. `format: "detailed"` returns the best
`NBest[0].Display`; `"simple"` returns `DisplayText`.

#### Azure language identification (mixed languages)

To let Azure auto-detect the language, add `locales` (candidate locales). The provider then
switches to the **Fast Transcription API** (`/speechtotext/transcriptions:transcribe`), which
runs per-phrase language identification:

```json
{
  "provider": {
    "type": "azure",
    "apiKeyEnv": "AZURE_SPEECH_KEY",
    "locales": ["bg-BG", "en-US"],
    "apiVersion": "2024-11-15"
  }
}
```

Identification is **phrase-level, not word-level** — a single English word inside a Bulgarian
sentence may still be transliterated. For true intra-sentence code-switching with English in
Latin script, use a Whisper backend (Option 1 or Option 3) instead. Omit `locales` to keep the
single-language short-audio behaviour.

### Option 3 — Azure OpenAI Whisper (Azure AI Foundry)

Whisper hosted on Azure OpenAI / Azure AI Foundry. Same Whisper model as Option 1 (so it keeps
mixed Bulgarian + English in the right scripts), but served from your Azure resource — and a
multi-service Azure AI Services resource can reuse the **same key** as Azure Speech.

```json
{
  "language": "bg-BG",
  "provider": {
    "type": "azure-openai",
    "endpoint": "https://<resource>.openai.azure.com",
    "deployment": "gpt-4o-transcribe",
    "apiVersion": "2025-03-01-preview",
    "apiKeyEnv": "AZURE_SPEECH_KEY"
  }
}
```

The request posts the WAV (multipart) to
`{endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version={apiVersion}` with
the **`api-key`** header. `deployment` is the deployment name from Azure AI Foundry → Deployments.

**Model choice.** Both `whisper` and the newer `gpt-4o-transcribe` work via this provider:
- `gpt-4o-transcribe` (GlobalStandard) — recommended; higher capacity/quota and good mixed
  Bulgarian + English (English terms stay in Latin). Needs a recent `apiVersion`
  (e.g. `2025-03-01-preview`).
- `whisper` — works with `apiVersion: "2024-10-21"`, but low-capacity deployments can be flaky
  (intermittent `404 DeploymentNotFound`); the provider retries those automatically.

> **Use the legacy data-plane host, not the Foundry endpoint.** Audio transcription is **not**
> served by the Foundry `https://<resource>.services.ai.azure.com` (`/openai/v1`) endpoint — that
> returns `404 DeploymentNotFound`. Use `https://<resource>.openai.azure.com` (or
> `…cognitiveservices.azure.com`). The `apiVersion` also matters: a recent GA version like
> `2024-10-21` works; older ones (e.g. `2024-06-01`) can 404. If omitted, `endpoint` falls back to
> `AZURE_OPENAI_ENDPOINT`.

Whisper accepts longer audio than the short-audio REST (up to ~25 MB), so `capture.maxSeconds`
can be raised.

### All options

| Key | Default | Notes |
| --- | --- | --- |
| `keybind` | `alt+s` | Any pi key id; override per-run with `PI_STT_KEYBIND` |
| `language` | `en-US` | BCP-47 locale (OpenAI receives the language part only) |
| `capture.ffmpegPath` | `ffmpeg` | Path to the ffmpeg binary |
| `capture.inputFormat` / `capture.input` | per-platform | ffmpeg `-f` / `-i` (avfoundation/pulse/dshow defaults) |
| `capture.sampleRate` / `capture.channels` | `16000` / `1` | Keep at 16 kHz mono for Azure |
| `capture.maxSeconds` | `60` | Hard cap; Azure short-audio rejects longer clips |
| `capture.minBytes` | `2048` | Reject empty/too-short captures |
| `provider.apiKeyEnv` | `OPENAI_API_KEY` / `AZURE_SPEECH_KEY` / `AZURE_OPENAI_API_KEY` | Env var holding the key |

## Troubleshooting

- **`/stt doctor` says ffmpeg not found** — install ffmpeg or set `capture.ffmpegPath`.
- **Linux: no audio** — ensure PulseAudio/PipeWire is running; try `capture.input` of a
  specific source name from `pactl list sources short`.
- **Azure `NoMatch`** — the spoken language doesn't match `language`; fix the locale.
- **Azure OpenAI `404 DeploymentNotFound`** — usually **not** the deployment name: check that
  `endpoint` is the legacy `*.openai.azure.com` / `*.cognitiveservices.azure.com` host (not the
  Foundry `*.services.ai.azure.com`), and that `apiVersion` is recent (`2024-10-21`, not
  `2024-06-01`). Only after those, verify the `deployment` name in Azure AI Foundry → Deployments.
- **Intermittent `404 DeploymentNotFound` (some requests succeed, most fail)** — the deployment is
  still propagating (freshly created) or has near-zero capacity. The extension already retries
  transient 404/429/5xx up to 3×, but if it stays flaky for long, wait for provisioning to settle,
  raise the deployment's capacity/quota (its **Requests-per-Minute** limit may be very low), or
  delete and recreate the deployment.
- **Recording too short** — speak before the indicator clears, or lower `capture.minBytes`.

## Attribution

Ported and simplified from [`cgarrot/pi-voice-stt`](https://github.com/cgarrot/pi-voice-stt).
Only the OpenAI-compatible, Azure Speech, and Azure OpenAI Whisper backends are included; the
other upstream providers, macOS Keychain lookup, and streaming/interim results are out of scope
here.
