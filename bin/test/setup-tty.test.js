// Real-terminal coverage: Python's stdlib pty creates a pseudo-terminal for the
// real CLI, unlike the pipe-backed tests where stdin.isTTY is false.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = join(root, "bin", "cli.js");
const workspace = () => mkdtempSync(join(tmpdir(), "af-setup-tty-"));
const PTY_DRIVER = String.raw`
import json, os, pty, select, sys, time
node, cli, workspace, answers = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3], json.loads(sys.argv[4])
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, cli, "setup", "--workspace", workspace])
needles = [b"Preset [", b"Features:", b"Apply this exact"]
output, index, deadline = b"", 0, time.time() + 25
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
        if index < len(answers) and needles[index] in output:
            os.write(fd, answers[index].encode())
            index += 1
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited:
        print(output.decode(errors="replace"), end="")
        sys.exit(os.waitstatus_to_exitcode(status))
os.kill(pid, 15)
_, status = os.waitpid(pid, 0)
print(output.decode(errors="replace"), end="")
sys.exit(os.waitstatus_to_exitcode(status))
`;

function interactiveSetup(ws, answers) {
  return spawnSync("python3", ["-c", PTY_DRIVER, JSON.stringify(process.execPath), cli, ws, JSON.stringify(answers)], { encoding: "utf8", timeout: 30000 });
}

function writeLegacyState(ws) {
  const content = "legacy\n";
  const legacyPath = join(ws, ".pi", "skills", "legacy", "SKILL.md");
  mkdirSync(dirname(legacyPath), { recursive: true });
  writeFileSync(legacyPath, content);
  mkdirSync(join(ws, ".ai"), { recursive: true });
  writeFileSync(join(ws, ".ai", "agent-fleet-state.json"), JSON.stringify({
    schemaVersion: 1, agent: "pi", method: "copy", packageVersion: "0.0.1", sourceRoot: root,
    profiles: [], installedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    externalPackages: [], events: [], items: {
      "skill:legacy": { kind: "skill", files: [{ path: ".pi/skills/legacy/SKILL.md", mode: "copy", sha256: createHash("sha256").update(content).digest("hex") }] },
    },
  }));
  return legacyPath;
}

test("real TTY setup reaches one final confirmation for Default, feature, and Full", { timeout: 90000 }, () => {
  for (const answers of [["1\n", "\n", "y\n"], ["1\n", "voice\n", "y\n"], ["2\n", "\n", "y\n"]]) {
    const ws = workspace();
    try {
      const result = interactiveSetup(ws, answers);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal((result.stdout.match(/Apply this exact setup plan\?/g) ?? []).length, 1, result.stdout);
      assert.ok(existsSync(join(ws, ".ai", "agent-fleet.json")), result.stdout);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
});

test("real TTY setup preserves an existing desired selection when its inputs are blank", { timeout: 30000 }, () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws, ".ai"), { recursive: true });
    const desiredPath = join(ws, ".ai", "agent-fleet.json");
    const desired = { schemaVersion: 1, preset: "full", features: { voice: true } };
    writeFileSync(desiredPath, JSON.stringify(desired, null, 2) + "\n");
    const result = interactiveSetup(ws, ["\n", "\n", "y\n"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Preset \[full\]/);
    assert.match(result.stdout, /blank keeps voice/);
    assert.match(result.stdout, /Planned actions/);
    assert.equal(readFileSync(desiredPath, "utf8"), JSON.stringify(desired, null, 2) + "\n");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("real TTY first migration is authorized only by the exact preview and final confirmation", { timeout: 60000 }, () => {
  const accepted = workspace();
  try {
    const legacyPath = writeLegacyState(accepted);
    const result = interactiveSetup(accepted, ["1\n", "\n", "y\n"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /first-migration setup plan/);
    assert.match(result.stdout, /state-owned deletion: \.pi\/skills\/legacy\/SKILL\.md/);
    assert.equal(existsSync(legacyPath), false, "confirmed migration removes only recorded legacy content");
    assert.ok(existsSync(join(accepted, ".ai", "agent-fleet.json")));
  } finally {
    rmSync(accepted, { recursive: true, force: true });
  }

  for (const answer of ["n\n", "\x04"]) {
    const rejected = workspace();
    try {
      const legacyPath = writeLegacyState(rejected);
      const result = interactiveSetup(rejected, ["1\n", "\n", answer]);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /Aborted — nothing was written/);
      assert.ok(existsSync(legacyPath), "rejected migration preserves legacy content");
      assert.equal(existsSync(join(rejected, ".ai", "agent-fleet.json")), false, "rejected migration creates no desired state");
    } finally {
      rmSync(rejected, { recursive: true, force: true });
    }
  }
});

test("real TTY cancellation and EOF do not write", { timeout: 30000 }, () => {
  for (const answers of [["cancel\n"], ["1\n", "\x04"]]) {
    const ws = workspace();
    try {
      const result = interactiveSetup(ws, answers);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stdout, /Aborted — nothing was written/);
      assert.equal(existsSync(join(ws, ".ai", "agent-fleet.json")), false, result.stdout);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
});
