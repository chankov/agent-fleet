// Opt-in C4 guard. Not used by production startup.
// Blocks inference transports even if a caller catches the thrown error.
import http from "node:http";
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
http.request = denyNetwork;
http.get = denyNetwork;
syncBuiltinESMExports();
globalThis.fetch = async () => denyNetwork();
process.on("exit", () => {
	if (attempted) process.exitCode = 1;
});
