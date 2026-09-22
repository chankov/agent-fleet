// Test-only preload: never ship this in the installed System 1 runtime.
// Fail the process even if production error handling catches the blocked request.
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";

let attempted = false;
/** @returns {never} */
function denyNetwork() {
  attempted = true;
  throw new Error("System 1 offline tests forbid HTTPS requests");
}
https.request = denyNetwork;
https.get = denyNetwork;
syncBuiltinESMExports();
process.on("exit", () => {
  if (attempted) process.exitCode = 1;
});
