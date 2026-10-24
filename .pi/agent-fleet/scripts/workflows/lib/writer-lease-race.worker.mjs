import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
const [cwd, name] = process.argv.slice(2);
const original = fs.readFileSync;
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let signalled = false;
fs.readFileSync = function(file, ...args) {
  const contents = original.call(fs, file, ...args);
  if (!signalled && String(file).includes(path.join(".pi", "writer-leases")) && String(file).endsWith(".lock")) {
    signalled = true;
    fs.writeFileSync(path.join(cwd, "read-" + name), "yes");
    const deadline = Date.now() + 300;
    while (!fs.existsSync(path.join(cwd, "read-A")) || !fs.existsSync(path.join(cwd, "read-B"))) {
      if (Date.now() >= deadline) break;
      sleep(10);
    }
    if (name === "B") sleep(160);
  }
  return contents;
};
syncBuiltinESMExports();
const { acquireWriterLease, WriterLeaseHeldError } = await import("./writer-lease.ts");
fs.writeFileSync(path.join(cwd, "ready-" + name), "ready");
const deadline = Date.now() + 3000;
while (!fs.existsSync(path.join(cwd, "ready-A")) || !fs.existsSync(path.join(cwd, "ready-B"))) {
  if (Date.now() >= deadline) { console.error("startup barrier timed out"); process.exit(2); }
  sleep(10);
}
try {
  acquireWriterLease({ cwd, owner: "owner-" + name, command: "native deterministic race", pid: process.ppid });
  console.log("CLAIMED");
} catch (error) {
  if (error instanceof WriterLeaseHeldError) console.log("LEASE_HELD");
  else { console.error(error); process.exitCode = 3; }
}
