import { copyToClipboard, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { FULLSCREEN_OVERLAY, fitToHeight } from "../../lib/fleet-overlay.ts";
import type { CommunicationStore } from "../system1-communication-store.ts";

/** Human-only diagnostic overlay; never feeds payloads back into model context. */
export async function openSystem1Communication(ctx: Pick<ExtensionContext, "ui">, store: CommunicationStore, copy: (text: string) => Promise<void> = copyToClipboard): Promise<void> {
 let selected = 0, detail: string | null = null, offset = 0, action = 0, disposed = false, listOffset = 0, selectedKey = "";
 await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
  const unsubscribe = store.subscribe(() => tui.requestRender());
  const rows = () => store.snapshot().flatMap(p => [{ pair: p, direction: "request" }, ...(p.ended === undefined ? [] : [{ pair: p, direction: "response" }])]);
  return {
   render(width: number) {
    const height = Math.max(1, tui.terminal.rows), body = Math.max(0, height - 3);
    const header = `System 1 communication · ${store.enabled ? "capture ON" : "capture OFF"} · evicted ${store.evicted}`;
    let content: string[];
    if (detail) {
     const p = store.snapshot().find(p => p.id === detail);
     content = p ? [`${p.consumer} · ${p.provider}/${p.model} · ${p.status} · ${p.id}`, ...(p.consumer === "task-triage" ? ["Provider result only; task acceptance and obligations are separate"] : p.consumer === 'agenticAsk' ? ['Advisory metadata only; no execution evidence, permission or gate closure'] : []), "Request", p.request ?? p.requestOmitted ?? "unavailable", "Response", p.response ?? p.responseOmitted ?? "pending", `${action === 0 ? "❯" : " "} Copy request    ${action === 1 ? "❯" : " "} Copy response`].flatMap(x => x.split("\n")) : ["Pair evicted or capture cleared. Esc back."];
    } else {
     const entries = rows(); const retained = entries.findIndex(r => `${r.pair.id}:${r.direction}` === selectedKey); if (retained >= 0) selected = retained; selected = Math.max(0, Math.min(selected, entries.length - 1));
     selectedKey = entries[selected] ? `${entries[selected].pair.id}:${entries[selected].direction}` : "";
     content = entries.map((r,i) => `${i === selected ? "❯" : " "} ${new Date(r.direction === "request" ? r.pair.started : r.pair.ended!).toISOString()} ${r.direction} ${r.pair.consumer} ${r.pair.owner} ${r.pair.provider}/${r.pair.model} ${r.pair.id.slice(0,8)} ${r.pair.status}`);
     if (!content.length) content = [store.enabled ? "No messages captured in this runtime. Previous payloads are not restored." : "Capture is off. Press e to explicitly enable session-only capture."];
     offset = Math.max(0, Math.min(offset, selected)); if (selected >= offset + body) offset = selected - body + 1;
    }
    if (detail) content = content.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
    offset = Math.max(0, Math.min(offset, Math.max(0, content.length - body)));
    const footer = detail ? `↑↓ scroll · ←→ ${action === 0 ? "[Copy request] / Copy response" : "Copy request / [Copy response]"} · Enter copy · Esc back` : "↑↓/jk select · Enter request/response · e enable · d disable/clear · Esc Fleet";
    // Overlay dimensions are upper bounds, not an opaque canvas. Paint every cell
    // so a short/empty list cannot reveal the Fleet overlay underneath.
    const lines = fitToHeight([header, "Sanitized logical payload · memory only · clipboard may retain copied data", ...fitToHeight(content.slice(offset, offset + body), body), footer], height);
    return lines.map(line => { const clipped = truncateToWidth(line, width); return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped))); });
   },
   async handleInput(data: string) {
    if (matchesKey(data, Key.escape)) { if (detail) { detail = null; offset = listOffset; } else done(); }
    else if (!detail && data === "e") store.setEnabled(true);
    else if (!detail && data === "d") store.setEnabled(false);
    else if (matchesKey(data, Key.up) || data === "k") { if (detail) offset = Math.max(0, offset - 1); else { selected = Math.max(0, selected - 1); selectedKey = ""; } }
    else if (matchesKey(data, Key.down) || data === "j") { if (detail) offset++; else { selected = Math.min(rows().length - 1, selected + 1); selectedKey = ""; } }
    else if (detail && matchesKey(data, Key.pageDown)) offset += Math.max(1, tui.terminal.rows - 4);
    else if (detail && matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - Math.max(1, tui.terminal.rows - 4));
    else if (detail && matchesKey(data, Key.home)) offset = 0;
    else if (detail && matchesKey(data, Key.end)) offset = Number.MAX_SAFE_INTEGER;
    else if (detail && (matchesKey(data, Key.left) || matchesKey(data, Key.right))) action = action === 0 ? 1 : 0;
    else if (matchesKey(data, Key.enter)) {
     if (!detail) { listOffset = offset; const row = rows()[selected]; detail = row?.pair.id ?? null; action = row?.direction === "response" ? 1 : 0; offset = 0; }
     else {
      const pair = store.snapshot().find(p => p.id === detail); const text = action === 0 ? pair?.request : pair?.response;
      if (!text) ctx.ui.notify("Payload unavailable; nothing copied", "warning");
      else { try { await copy(text); if (!disposed) ctx.ui.notify("Copied sanitized payload; clipboard may retain it", "info"); } catch { if (!disposed) ctx.ui.notify("Clipboard unavailable", "error"); } }
     }
    }
    if (!disposed) tui.requestRender();
   },
   invalidate() {}, dispose() { disposed = true; unsubscribe(); },
  };
 }, FULLSCREEN_OVERLAY);
}
