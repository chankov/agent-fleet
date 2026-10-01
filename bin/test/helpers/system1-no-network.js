// Test-only preload: never ship this in the installed System 1 runtime.
// Fail the process even if production error handling catches the blocked request.
import https from "node:https";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

let attempted = false;
/** @returns {never} */
function denyNetwork() {
  attempted = true;
  throw new Error("System 1 offline tests forbid network requests");
}
https.request = denyNetwork;
https.get = denyNetwork;
http.request = denyNetwork;
http.get = denyNetwork;
tls.connect = denyNetwork;
/** @param {any[]} args */
const unixSocket = (args) =>
  (typeof args[0] === "string" && !/^\w+:\/\//.test(args[0]) && !/^\d+$/.test(args[0])) ||
  (args[0] && typeof args[0] === "object" && typeof args[0].path === "string" && args[0].port == null);
/** @type {Record<string, (...args: any[]) => any>} */
const connections = /** @type {any} */ (net);
for (const name of ["connect", "createConnection"]) {
  const original = connections[name];
  connections[name] = function (...args) {
    if (!unixSocket(args)) denyNetwork();
    return original.apply(this, args);
  };
}
globalThis.fetch = denyNetwork;
syncBuiltinESMExports();
process.on("exit", () => {
  if (attempted) process.exitCode = 1;
});
