// Offline-safe, bounded diagnostic projection: never retain RPC payloads or UI decision values.
const MAX_STDERR = 8192, MAX_EVENTS = 80;
export const BENIGN_UI_METHODS = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);

export function redactDiagnostic(text) {
  return String(text)
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/https?:\/\/[^\s]+/gi, "[redacted-url]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s]+/gi, "[redacted-auth]")
    .replace(/\b[A-Za-z0-9_-]*(?:api[_-]?key|token|secret|password|authorization|credential|cookie)[A-Za-z0-9_-]*["']?\s*[:=]\s*(?:"[^"\r\n]*(?:"|$)|'[^'\r\n]*(?:'|$)|[^\s,;"'}]+)/gi, "[redacted-secret]")
    .replace(/\b(?:sk|ghp|github_pat|AIza)[-_][A-Za-z0-9_-]{8,}\b/g, "[redacted-token]")
    .replace(/\b[A-Za-z0-9_+/=-]{40,}\b/g, "[redacted-long-value]");
}

export function createReviewDiagnostics(outcome, save) {
  const diagnostics = outcome.diagnostics = { stderr: "", stderrTruncated: false, rpc: [], kills: [], spawnError: null, exit: null, firstFailure: null };
  let stderr = "", pendingLine = "", oversizedLine = false;
  const persist = () => save();
  const retainLine = line => {
    const safe = redactDiagnostic(line);
    if (Buffer.byteLength(safe) > MAX_STDERR) {
      diagnostics.stderrTruncated = true;
      return;
    }
    stderr += safe;
    while (Buffer.byteLength(stderr) > MAX_STDERR) {
      stderr = stderr.slice(stderr.indexOf("\n") + 1);
      diagnostics.stderrTruncated = true;
    }
  };
  const failure = reason => {
    if (!diagnostics.firstFailure) diagnostics.firstFailure = { reason: redactDiagnostic(reason), at: new Date().toISOString() };
    persist();
  };
  const safe = value => typeof value === "string" ? redactDiagnostic(value).slice(0, 240) : undefined;
  const rpc = ev => {
    const item = { at: new Date().toISOString(), type: ev.type };
    if (ev.type === "extension_ui_request") {
      item.method = [...BENIGN_UI_METHODS, "select", "confirm", "input", "editor"].includes(ev.method) ? ev.method : "unknown";
    } else if (ev.type === "message_end" || ev.type === "tool_execution_start" || ev.type === "tool_execution_end") {
      const message = ev.message, result = ev.result ?? (message?.role === "toolResult" ? message : undefined);
      const details = result?.details;
      item.role = safe(message?.role ?? ev.role);
      item.provider = safe(message?.role === "assistant" ? message.provider : undefined);
      item.model = safe(message?.role === "assistant" ? message.model : undefined);
      item.toolCallId = safe(ev.toolCallId ?? result?.toolCallId);
      item.toolName = safe(ev.toolName ?? result?.toolName);
      if (typeof result?.isError === "boolean" || typeof ev.isError === "boolean")
        item.isError = result?.isError === true || ev.isError === true;
      item.status = safe(result?.status ?? details?.status ?? ev.status);
      // Tool payloads are not evidence: retain only a bounded sanitized error/refusal reason.
      const text = result?.content;
      const resultText = typeof text === "string" ? text : Array.isArray(text) ? text.find(part => typeof part?.text === "string")?.text : undefined;
      const reason = result?.reason ?? details?.reason ?? ev.reason ??
        ((item.isError || /\b(?:refus(?:ed|al)|denied|blocked|not authorized)\b/i.test(resultText ?? "")) ? resultText : undefined);
      item.reason = safe(reason);
    } else if (ev.type === "response") {
      item.command = ev.command === "prompt" ? "prompt" : "other";
      item.success = ev.success === true;
      if (ev.success === false && ev.error) item.error = redactDiagnostic(ev.error).slice(0, 240);
    } else if (ev.type === "error") {
      item.error = redactDiagnostic(ev.error ?? "RPC error").slice(0, 240);
    }
    diagnostics.rpc.push(item);
    if (diagnostics.rpc.length > MAX_EVENTS) diagnostics.rpc.shift();
    persist();
  };
  return {
    failure, rpc,
    stderr(chunk) {
      const text = String(chunk);
      let start = 0, end;
      while ((end = text.indexOf("\n", start)) !== -1) {
        if (!oversizedLine && end + 1 - start <= MAX_STDERR) {
          const part = text.slice(start, end + 1);
          if (Buffer.byteLength(pendingLine) + Buffer.byteLength(part) <= MAX_STDERR)
            retainLine(pendingLine + part);
          else diagnostics.stderrTruncated = true;
        } else diagnostics.stderrTruncated = true;
        pendingLine = "";
        oversizedLine = false;
        start = end + 1;
      }
      if (start < text.length && !oversizedLine) {
        if (text.length - start <= MAX_STDERR) {
          const part = text.slice(start);
          if (Buffer.byteLength(pendingLine) + Buffer.byteLength(part) <= MAX_STDERR) pendingLine += part;
          else oversizedLine = true;
        } else oversizedLine = true;
        if (oversizedLine) {
          pendingLine = "";
          diagnostics.stderrTruncated = true;
        }
      }
      // Never persist an incomplete line: its key or value may be split across chunks.
    },
    flushStderr() {
      if (pendingLine || oversizedLine) diagnostics.stderrTruncated = true;
      pendingLine = "";
      oversizedLine = false;
      diagnostics.stderr = stderr;
      persist();
    },
    spawnError(error) { diagnostics.spawnError = { at: new Date().toISOString(), code: error.code ?? null, message: redactDiagnostic(error.message).slice(0, 240) }; failure(`Pi spawn error: ${error.message}`); },
    exit(code, signal) { diagnostics.exit = { at: new Date().toISOString(), code, signal }; persist(); },
    kill(reason, signal, send) {
      diagnostics.kills.push({ at: new Date().toISOString(), reason, signal });
      failure(reason); // Record intent durably before sending a signal.
      send();
    },
  };
}
