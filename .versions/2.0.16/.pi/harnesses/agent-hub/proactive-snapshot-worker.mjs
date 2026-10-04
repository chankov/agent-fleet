// Disposable local capture process; it never receives a model credential or transport.
import { beginTurnCore, finishTurnCore } from "./proactive-snapshot.ts";
process.once("message", message => {
 try {
  const result = message?.phase === "begin" ? beginTurnCore(message.payload)
   : message?.phase === "finish" ? finishTurnCore(message.payload.baseline, message.payload.input)
   : null;
  process.send?.({ ok: true, result });
 } catch (error) {
  process.send?.({ ok: false, code: error?.message === "capture_timeout" ? "capture_timeout" : "capture_unavailable" });
 }
});
