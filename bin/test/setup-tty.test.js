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
needles = [s.encode() for s in json.loads(sys.argv[5])]
cols = int(sys.argv[6])
os.environ["COLUMNS"], os.environ["LINES"] = str(cols), "24"
pid, fd = pty.fork()
if pid == 0:
    os.execv(node, [node, cli, "setup", "--workspace", workspace])
def rendered(raw):
    # Minimal VT screen model: cursor motion, CR/LF, erase, wrapping and scroll.
    import re
    rows = 24; screen = [[" "] * cols for _ in range(rows)]; row = col = 0
    def scroll():
        nonlocal row
        if row >= rows: screen.pop(0); screen.append([" "] * cols); row = rows - 1
    text = raw.decode(errors="replace"); i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\x1b" and i + 1 < len(text) and text[i + 1] == "[":
            match = re.match(r"\x1b\[([0-9;?]*)([A-Za-z])", text[i:])
            if match:
                args = [int(x) if x else 0 for x in match.group(1).replace("?", "").split(";")]; cmd = match.group(2); n = args[0] or 1
                if cmd == "A": row = max(0, row - n)
                elif cmd == "B": row = min(rows - 1, row + n)
                elif cmd == "C": col = min(cols - 1, col + n)
                elif cmd == "D": col = max(0, col - n)
                elif cmd == "G": col = max(0, min(cols - 1, n - 1))
                elif cmd in ("H", "f"):  row = max(0, min(rows - 1, (args[0] or 1) - 1)); col = max(0, min(cols - 1, ((args[1] if len(args)>1 else 1) or 1) - 1))
                elif cmd == "K":
                    mode = args[0] if args else 0
                    if mode == 0: screen[row][col:] = [" "] * (cols - col)
                    elif mode == 1: screen[row][:col+1] = [" "] * (col + 1)
                    elif mode == 2: screen[row] = [" "] * cols
                elif cmd == "J" and (args[0] if args else 0) == 2: screen = [[" "] * cols for _ in range(rows)]; row = col = 0
                i += len(match.group(0)); continue
        if ch == "\r": col = 0
        elif ch == "\n": row += 1; scroll()
        elif ch == "\b": col = max(0, col - 1)
        elif ch >= " ":
            screen[row][col] = ch; col += 1
            if col >= cols: col = 0; row += 1; scroll()
        i += 1
    lines = ["".join(line).rstrip() for line in screen]
    return "\n".join(lines), next((line for line in reversed(lines) if line), "")
output, screens, index, input_start, deadline = b"", [], 0, 0, time.time() + 25
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], .1)
    if ready:
        try: chunk = os.read(fd, 65536)
        except OSError: break
        if not chunk: break
        output += chunk
        if index < len(answers) and needles[index] in output[input_start:]:
            screens.append(rendered(output))
            os.write(fd, answers[index].encode())
            index += 1; input_start = len(output)
    waited, status = os.waitpid(pid, os.WNOHANG)
    if waited:
        print(output.decode(errors="replace"), end="")
        for i, screen in enumerate(screens): print(f"\n[[RENDERED-BEFORE-INPUT-{i}]]\n{screen[0]}\n[[LAST-NONEMPTY-{i}]]{screen[1]}[[END-LAST]]\n[[END-RENDERED]]")
        sys.exit(os.waitstatus_to_exitcode(status))
os.kill(pid, 15)
_, status = os.waitpid(pid, 0)
print(output.decode(errors="replace"), end="")
for i, screen in enumerate(screens): print(f"\n[[RENDERED-BEFORE-INPUT-{i}]]\n{screen[0]}\n[[LAST-NONEMPTY-{i}]]{screen[1]}[[END-LAST]]\n[[END-RENDERED]]")
sys.exit(os.waitstatus_to_exitcode(status))
`;

function interactiveSetup(ws, answers, needles = ["Choose: 1 | 2 | 3 | cancel; Enter =", "| none | cancel; Enter = keep", "Enter = no (cancel without applying) >"]) {
  return spawnSync("python3", ["-c", PTY_DRIVER, JSON.stringify(process.execPath), cli, ws, JSON.stringify(answers), JSON.stringify(needles), "52"], { encoding: "utf8", timeout: 30000 });
}
function renderedScreen(result, index) {
  return result.stdout.match(new RegExp(`\\[\\[RENDERED-BEFORE-INPUT-${index}\\]\\]\\n([\\s\\S]*?)\\n\\[\\[LAST-NONEMPTY-${index}\\]\\]`))?.[1] ?? "";
}
function lastVisibleInputLine(result, index) {
  return result.stdout.match(new RegExp(`\\[\\[LAST-NONEMPTY-${index}\\]\\]([^\\n]*)\\[\\[END-LAST\\]\\]`))?.[1] ?? "";
}
const compactScreen = (result, index) => renderedScreen(result, index).replace(/\n/g, "");

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
  for (const answers of [["1\n", "\n", "y\n"], ["1\n", "voice\n", "groq\n", "y\n"], ["2\n", "\n", "y\n"], ["3\n", "none\n", "y\n"]]) {
    const ws = workspace();
    try {
      const needles = answers.length === 4 ? ["Choose: 1 | 2 | 3 | cancel; Enter =", "| none | cancel; Enter = keep", "Enter = cancel (no secret values requested) >", "Enter = no (cancel without applying) >"] : undefined;
      const result = interactiveSetup(ws, answers, needles);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.equal((result.stdout.match(/Apply this setup plan\?/g) ?? []).length >= 1, true, result.stdout);
      assert.match(compactScreen(result, 0), /Choose: 1 \| 2 \| 3 \| cancel; Enter =/);
      assert.match(lastVisibleInputLine(result, 0), /^Choose: .*Enter = .* >$/);
      assert.match(compactScreen(result, 1), /Features: <name>\[,<name>\.\.\.\] \| none \| cancel; Enter\s*=\s*keep/);
      assert.match(lastVisibleInputLine(result, 1), />$/);
      if (answers.length === 4) {
        assert.match(compactScreen(result, 2), /STT provider: openai \| groq \| azure \| cancel; Enter\s*=\s*cancel/);
        assert.match(lastVisibleInputLine(result, 2), /cancel \(no secret values requested\) >$/);
      }
      const approvalIndex = answers.length === 4 ? 3 : 2;
      assert.match(compactScreen(result, approvalIndex), /Preset: .*Selected features: .*Dependency features: .*Apply this setup plan\? yes\/y \| no\/n; Enter = no/);
      assert.match(lastVisibleInputLine(result, approvalIndex), /without applying\) >$/);
      assert.ok(existsSync(join(ws, ".ai", "agent-fleet.json")), result.stdout);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }
});

test("real TTY Full + all persists an explicit feature snapshot", { timeout: 30000 }, () => {
  const ws = workspace();
  try {
    const result = interactiveSetup(ws, ["3\n", "\n", "groq\n", "y\n"], ["Choose: 1 | 2 | 3 | cancel; Enter =", "| none | cancel; Enter = keep", "Enter = cancel (no secret values requested) >", "Enter = no (cancel without applying) >"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const desired = JSON.parse(readFileSync(join(ws, ".ai/agent-fleet.json"), "utf8"));
    assert.equal(desired.preset, "full");
    assert.ok(Object.values(desired.features).every(Boolean), "snapshot stores each currently available feature explicitly");
    assert.match(result.stdout, /Selected features:.*chatgpt-client \(experimental\)/);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("real TTY setup preserves an existing desired selection when its inputs are blank", { timeout: 30000 }, () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws, ".ai"), { recursive: true });
    const desiredPath = join(ws, ".ai", "agent-fleet.json");
    const desired = { schemaVersion: 1, preset: "full", features: { voice: true } };
    writeFileSync(desiredPath, JSON.stringify(desired, null, 2) + "\n");
    const result = interactiveSetup(ws, ["\n", "\n", "groq\n", "y\n"], ["Choose: 1 | 2 | 3 | cancel; Enter =", "| none | cancel; Enter = keep", "Enter = cancel (no secret values requested) >", "Enter = no (cancel without applying) >"]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /Enter = Full/);
    assert.match(result.stdout, /Enter = keep \[voice\]/);
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

test("real TTY retries invalid preset and approval answers on a narrow rendered screen", { timeout: 30000 }, () => {
  const ws = workspace();
  try {
    const result = interactiveSetup(ws, ["wat\n", "1\n", "bogus\n", "none\n", "maybe\n", "n\n"],
      ["Choose: 1 | 2 | 3 | cancel; Enter =", "Choose: 1 | 2 | 3 | cancel; Enter =", "| none | cancel; Enter = keep", "| none | cancel; Enter = keep", "Enter = no (cancel without applying) >", "Enter = no (cancel without applying) >"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(renderedScreen(result, 1), /Invalid preset/); assert.match(lastVisibleInputLine(result, 1), /^Choose: .* >$/);
    assert.match(renderedScreen(result, 3), /Unknown feature/); assert.match(lastVisibleInputLine(result, 3), />$/);
    assert.match(renderedScreen(result, 5), /Invalid answer/); assert.match(lastVisibleInputLine(result, 5), /without applying\) >$/);
    assert.equal(existsSync(join(ws, ".ai/agent-fleet.json")), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
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


test("real TTY Ctrl+C is reported separately and writes nothing", { timeout: 30000 }, () => {
  const ws = workspace();
  try {
    const result = interactiveSetup(ws, ["\x03"], ["Choose: 1 | 2 | 3 | cancel; Enter ="]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Ctrl\+C/);
    assert.equal(existsSync(join(ws, ".ai/agent-fleet.json")), false);
  } finally { rmSync(ws, { recursive: true, force: true }); }
});

test("real TTY config repair requires separate consent and survives later setup cancellation", { timeout: 90000 }, () => {
  for (const approve of [false, true]) {
    const ws = workspace();
    try {
      mkdirSync(join(ws, ".ai"));
      const path = join(ws, ".ai/agent-fleet.json");
      const original = JSON.stringify({ schemaVersion: 1, preset: "default", features: { "codex-remote": false } });
      writeFileSync(path, original);
      const result = interactiveSetup(ws,
        approve ? ["y\n", "\n", "\n", "n\n"] : ["n\n"],
        ["backup is created only after yes) >", "Choose: 1 | 2 | 3 | cancel; Enter =", "| none | cancel; Enter = keep", "Enter = no (cancel without applying) >"]);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(compactScreen(result, 0), /Apply this config repair now\? yes\/y \| no\/n; Enter\s*=\s*no \(cancel; backup is created only after yes\) >/);
      assert.match(lastVisibleInputLine(result, 0), /no \(cancel; backup is created only after yes\) >$/);
      assert.match(result.stdout, /"codex-remote": false/);
      if (approve) {
        assert.equal("codex-remote" in JSON.parse(readFileSync(path, "utf8")).features, false);
        assert.match(result.stdout, /approved config repair and its backup remain/);
      } else {
        assert.equal(readFileSync(path, "utf8"), original);
        assert.doesNotMatch(result.stdout, /Preset \[/);
      }
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
});
