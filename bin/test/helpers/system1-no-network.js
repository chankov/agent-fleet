// Test-only preload: never ship this in the installed System 1 runtime.
// Fail the process even if production error handling catches the blocked request.
import https from "node:https";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";
import { isAbsolute } from "node:path";

let attempted = false;
/** @returns {never} */
function denyNetwork() {
  attempted = true;
  throw new Error("System 1 offline tests forbid network requests");
}
https.request = denyNetwork;
https.get = denyNetwork;
// HTTP framing over an explicit Unix socket (e.g. WS Upgrade) is IPC, not TCP.
// URL-only/host/port requests remain denied, as do all TLS and fetch paths.
/** @type {Record<string, (...args: any[]) => any>} */
const httpRequests = /** @type {any} */ (http);
for (const name of ["request", "get"]) {
  const original = httpRequests[name];
  httpRequests[name] = function (...args) {
    const options = args[0];
    if (!options || typeof options !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) denyNetwork();
    const socketPath = Object.getOwnPropertyDescriptor(options, "socketPath")?.value;
    if (typeof socketPath !== "string" || !isAbsolute(socketPath)) denyNetwork();
    return original.apply(this, args);
  };
}
tls.connect = denyNetwork;
/** @param {any[]} args */
const unixSocket = (args) =>
  (typeof args[0] === "string" && !/^\w+:\/\//.test(args[0]) && !/^\d+$/.test(args[0])) ||
  (args[0] && typeof args[0] === "object" && typeof args[0].path === "string" && (args[0].port == null || args[0].path === args[0].socketPath && isAbsolute(args[0].socketPath)));
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
