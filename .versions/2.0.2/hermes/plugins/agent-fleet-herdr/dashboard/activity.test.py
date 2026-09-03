"""Slice 5 — the activity tail. A temp tree stands in for `~/.pi/agent/sessions`.

No pi, no herdr, no `~/.pi`: every transcript here is written by the test, which
is also the only way to exercise the cases that matter — a file that grows
between two reads, a tail that starts mid-record, a transcript in the right
folder belonging to somebody else.

Run: python3 hermes/plugins/agent-fleet-herdr/dashboard/activity.test.py
"""

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import activity  # noqa: E402

CWD = "/home/x/repo"
SLUG = "--home-x-repo--"
SESSION = "01KYCQR3VF4674CF0MPQV2DJYS"


def boot(session_id=SESSION, name="orchestrator", project="alpha") -> dict:
    return {
        "type": "custom",
        "customType": "coms-log",
        "data": {"event": "boot", "session_id": session_id, "name": name, "project": project},
        "timestamp": "2026-07-27T09:00:00.000Z",
    }


def assistant(content, stop="toolUse", at="2026-07-27T09:00:10.000Z") -> dict:
    return {
        "type": "message",
        "timestamp": at,
        "message": {"role": "assistant", "content": content, "stopReason": stop, "timestamp": 1785096382009},
    }


def tool_call(name, arguments) -> dict:
    return {"type": "toolCall", "id": "call_1", "name": name, "arguments": arguments}


def write(path: Path, records) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record) + "\n")
    return path


class TempTree(unittest.TestCase):
    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)
        # The module caches on (path, size, mtime); a temp path could in
        # principle repeat across tests, so start every test with an empty one.
        activity._boot_cache.clear()
        activity._tail_cache.clear()

    def transcript(self, filename, records) -> Path:
        return write(self.root / SLUG / filename, records)

    def entry(self, session_id=SESSION, cwd=CWD) -> dict:
        return {"name": "orchestrator", "session_id": session_id, "cwd": cwd}

    def activity_for(self, **kwargs) -> dict:
        return activity.activity_for_entry(self.entry(), root=self.root, **kwargs)


class SlugTest(unittest.TestCase):
    def test_matches_the_encoding_pi_writes_with(self):
        # migrations.js:101 — strip the leading separator, flatten the rest,
        # wrap in `--`. Dots survive, which is what keeps a worktree like
        # `agent-fleet.hermes-plugin` distinct from `agent-fleet`.
        self.assertEqual(activity.slug_for_cwd("/home/nchankov"), "--home-nchankov--")
        self.assertEqual(activity.slug_for_cwd("/home/x/repo"), "--home-x-repo--")
        self.assertEqual(
            activity.slug_for_cwd("/home/n/repos/agent-fleet.hermes-plugin"),
            "--home-n-repos-agent-fleet.hermes-plugin--",
        )
        # Both the `:` and the `\` become a `-`, so a Windows root doubles it.
        # Quirk, not a bug: this has to be pi's encoding character for
        # character, because it is a folder name we have to hit exactly.
        self.assertEqual(activity.slug_for_cwd("C:\\src\\app"), "--C--src-app--")

    def test_an_unusable_cwd_is_the_empty_string_not_a_wildcard(self):
        for value in ("", None, 7):
            self.assertEqual(activity.slug_for_cwd(value), "")


class MatchTest(TempTree):
    def test_the_transcript_is_found_through_boot_not_the_slug(self):
        path = self.transcript("a.jsonl", [boot(), assistant([tool_call("bash", {"command": "ls"})])])
        self.assertEqual(activity.find_transcript(CWD, SESSION, self.root), path)

    def test_a_same_cwd_transcript_belonging_to_someone_else_is_not_used(self):
        """The reason `boot` is authoritative. A cwd routinely holds a dozen
        transcripts and a pi and a Claude Code pane can share it exactly —
        picking the newest would report a stranger's work as this agent's."""
        self.transcript("newer.jsonl", [boot("01OTHERSESSION0000000000"), assistant([tool_call("bash", {"command": "rm -rf /"})])])
        mine = self.transcript("mine.jsonl", [boot(), assistant([tool_call("read", {"path": "/etc/hosts"})])])

        self.assertEqual(activity.find_transcript(CWD, SESSION, self.root), mine)
        steps = activity.activity_for_entry(self.entry(), root=self.root)["steps"]
        self.assertEqual([step["label"] for step in steps], ["read"])

    def test_a_transcript_that_never_joined_coms_is_skipped_silently(self):
        self.transcript("plain.jsonl", [assistant([tool_call("bash", {"command": "ls"})])])
        self.assertIsNone(activity.find_transcript(CWD, SESSION, self.root))

    def test_no_transcript_is_available_false_with_a_reason_never_an_error(self):
        answer = self.activity_for()
        self.assertIs(answer["available"], False)
        self.assertIn("no pi transcript", answer["reason"])
        self.assertEqual(answer["steps"], [])
        self.assertIsNone(answer["current"])

    def test_an_entry_without_a_session_id_says_so_rather_than_guessing(self):
        answer = activity.activity_for_entry({"cwd": CWD}, root=self.root)
        self.assertIs(answer["available"], False)
        answer = activity.activity_for_entry({"session_id": SESSION}, root=self.root)
        self.assertIs(answer["available"], False)

    def test_a_missing_sessions_folder_is_an_empty_candidate_list(self):
        self.assertEqual(activity.candidate_paths(CWD, self.root / "nope"), [])


class ProjectionTest(TempTree):
    def test_a_tool_call_shows_only_what_its_allowlist_permits(self):
        self.transcript(
            "a.jsonl",
            [
                boot(),
                assistant([tool_call("bash", {"command": "git rev-list --count HEAD", "workdir": "/secret/place"})]),
            ],
        )
        step = self.activity_for()["steps"][-1]
        self.assertEqual((step["kind"], step["label"]), ("tool", "bash"))
        self.assertEqual(step["detail"], "git rev-list --count HEAD")

    def test_an_unlisted_tool_gives_its_name_and_nothing_else(self):
        """The default has to fail closed: new tools appear constantly, and the
        argument nobody listed is exactly the one holding a token."""
        self.transcript(
            "a.jsonl",
            [boot(), assistant([tool_call("some_new_tool", {"api_key": "sk-live-do-not-print", "body": "x" * 500})])],
        )
        answer = self.activity_for()
        step = answer["steps"][-1]
        self.assertEqual(step["label"], "some_new_tool")
        self.assertEqual(step["detail"], "")
        self.assertNotIn("sk-live", json.dumps(answer))

    def test_an_allowlisted_tools_other_arguments_still_do_not_travel(self):
        self.transcript(
            "a.jsonl",
            [boot(), assistant([tool_call("read", {"path": "/etc/hosts", "content": "SECRET-CONTENTS"})])],
        )
        answer = self.activity_for()
        self.assertEqual(answer["steps"][-1]["detail"], "/etc/hosts")
        self.assertNotIn("SECRET-CONTENTS", json.dumps(answer))

    def test_a_nested_argument_renders_as_nothing_rather_than_being_stringified(self):
        # `str()` on a dict would paste the whole structure into the payload —
        # the exact thing the allowlist exists to prevent.
        self.transcript("a.jsonl", [boot(), assistant([tool_call("bash", {"command": {"secret": "nested"}})])])
        answer = self.activity_for()
        self.assertEqual(answer["steps"][-1]["detail"], "")
        self.assertNotIn("nested", json.dumps(answer))

    def test_dispatching_and_blocking_are_their_own_kinds(self):
        self.transcript(
            "a.jsonl",
            [
                boot(),
                assistant([tool_call("dispatch_agent", {"agent": "builder", "task": "a very long task brief"})]),
                assistant([tool_call("ask_user", {"question": "Which branch?"})]),
            ],
        )
        steps = self.activity_for()["steps"]
        self.assertEqual([(s["kind"], s["detail"]) for s in steps], [("dispatch", "builder"), ("blocked", "Which branch?")])

    def test_a_finished_turn_is_a_step_so_an_idle_agent_reads_as_idle(self):
        self.transcript(
            "a.jsonl",
            [boot(), assistant([{"type": "text", "text": "There are 25 pending changes."}], stop="stop")],
        )
        steps = self.activity_for()["steps"]
        self.assertEqual([s["kind"] for s in steps], ["assistant", "done"])
        self.assertEqual(self.activity_for()["current"]["kind"], "done")

    def test_a_continuing_turn_is_never_reported_as_finished(self):
        self.transcript("a.jsonl", [boot(), assistant([tool_call("bash", {"command": "sleep 60"})], stop="toolUse")])
        self.assertNotIn("done", [s["kind"] for s in self.activity_for()["steps"]])

    def test_thinking_and_tool_results_and_user_text_never_travel(self):
        self.transcript(
            "a.jsonl",
            [
                boot(),
                {"type": "message", "timestamp": "2026-07-27T09:00:01Z", "message": {"role": "user", "content": "USER-PASTED-SECRET"}},
                assistant([{"type": "thinking", "thinking": "PRIVATE-REASONING"}, tool_call("ls", {"path": "/tmp"})]),
                {
                    "type": "message",
                    "timestamp": "2026-07-27T09:00:02Z",
                    "message": {"role": "toolResult", "toolName": "ls", "content": "TOOL-OUTPUT-DUMP"},
                },
            ],
        )
        body = json.dumps(self.activity_for())
        for forbidden in ("USER-PASTED-SECRET", "PRIVATE-REASONING", "TOOL-OUTPUT-DUMP"):
            self.assertNotIn(forbidden, body)
        self.assertEqual([s["label"] for s in self.activity_for()["steps"]], ["ls"])

    def test_a_coms_log_event_shows_the_target_but_never_a_session_id(self):
        self.transcript(
            "a.jsonl",
            [
                boot(),
                {
                    "type": "custom",
                    "customType": "coms-log",
                    "timestamp": "2026-07-27T09:00:05Z",
                    "data": {"event": "outbound_prompt", "target": "code-reviewer", "msg_id": "01MSGID000000000000000000"},
                },
                {
                    "type": "custom",
                    "customType": "coms-log",
                    "timestamp": "2026-07-27T09:00:06Z",
                    "data": {"event": "inbound_prompt", "sender": "01SENDERSESSION0000000000", "msg_id": "01X"},
                },
            ],
        )
        answer = self.activity_for()
        self.assertEqual(
            [(s["kind"], s["label"], s["detail"]) for s in answer["steps"]],
            [("dispatch", "prompt sent", "code-reviewer"), ("dispatch", "prompt received", "")],
        )
        body = json.dumps(answer)
        self.assertNotIn("01SENDERSESSION0000000000", body)
        self.assertNotIn("01MSGID000000000000000000", body)

    def test_a_long_detail_is_clipped_to_one_bounded_line(self):
        self.transcript("a.jsonl", [boot(), assistant([tool_call("bash", {"command": "echo " + "y" * 500})])])
        detail = self.activity_for()["steps"][-1]["detail"]
        self.assertLessEqual(len(detail), activity.DETAIL_CHARS)
        self.assertTrue(detail.endswith("…"))

    def test_newlines_are_collapsed_so_a_step_stays_one_step(self):
        self.transcript("a.jsonl", [boot(), assistant([tool_call("bash", {"command": "a\n  b\tc"})])])
        self.assertEqual(self.activity_for()["steps"][-1]["detail"], "a b c")

    def test_the_record_timestamp_wins_over_the_messages_epoch_number(self):
        self.transcript("a.jsonl", [boot(), assistant([tool_call("ls", {"path": "/tmp"})], at="2026-07-27T09:00:10.000Z")])
        # now = 09:00:40Z
        answer = activity.activity_for_entry(
            self.entry(), root=self.root, now_ms=1785142840000.0
        )
        self.assertEqual(answer["steps"][-1]["at"], "2026-07-27T09:00:10.000Z")
        self.assertIsInstance(answer["current"]["since_s"], int)


class TailTest(TempTree):
    def test_a_tail_that_starts_mid_record_drops_the_half_record(self):
        """A byte budget lands in the middle of a JSON object, and half an
        object is not a smaller object."""
        path = self.transcript(
            "a.jsonl",
            [boot()] + [assistant([tool_call("bash", {"command": f"step {i}"})]) for i in range(20)],
        )
        rows = activity.read_tail(path, budget=400)
        self.assertTrue(rows, "a 400-byte budget still covers several records")
        for _offset, line in rows:
            json.loads(line)  # every returned line is whole, or this raises

    def test_a_record_still_being_written_is_not_parsed(self):
        path = self.transcript("a.jsonl", [boot(), assistant([tool_call("ls", {"path": "/tmp"})])])
        with open(path, "a", encoding="utf-8") as handle:
            handle.write('{"type": "message", "message": {"role": "assist')  # no newline: mid-append
        self.assertEqual([s["label"] for s in activity.steps_for_path(path)], ["ls"])

    def test_offsets_are_file_positions_so_a_grown_file_resumes_exactly(self):
        path = self.transcript("a.jsonl", [boot(), assistant([tool_call("ls", {"path": "/tmp"})])])
        first = self.activity_for()
        self.assertEqual([s["label"] for s in first["steps"]], ["ls"])
        self.assertEqual(first["seq"], path.stat().st_size)

        write(path, [assistant([tool_call("grep", {"pattern": "TODO"})])])
        second = self.activity_for(after=first["seq"])
        self.assertEqual([s["label"] for s in second["steps"]], ["grep"], "only what is new")
        self.assertEqual(self.activity_for(after=second["seq"])["steps"], [], "and never twice")

    def test_current_is_the_end_of_the_file_not_the_end_of_the_cursor(self):
        """'What is it doing' is a property of the agent, not of how much this
        particular client has already been shown."""
        self.transcript(
            "a.jsonl",
            [boot(), assistant([tool_call("ls", {"path": "/tmp"})]), assistant([tool_call("grep", {"pattern": "x"})])],
        )
        caught_up = self.activity_for(after=10**9)
        self.assertEqual(caught_up["steps"], [])
        self.assertEqual(caught_up["current"]["label"], "grep")

    def test_the_cache_notices_a_file_that_changed(self):
        path = self.transcript("a.jsonl", [boot(), assistant([tool_call("ls", {"path": "/tmp"})])])
        self.assertEqual(len(activity.steps_for_path(path)), 1)
        write(path, [assistant([tool_call("grep", {"pattern": "x"})])])
        self.assertEqual(len(activity.steps_for_path(path)), 2)

    def test_the_limit_never_returns_half_a_line(self):
        """Three tool calls in one assistant turn share one byte offset, so a
        cursor cannot point between them. The limit is a soft budget: it
        overshoots to keep the line whole rather than returning a part of it
        that the next cursor could never complete."""
        self.transcript(
            "a.jsonl",
            [
                boot(),
                assistant([tool_call("ls", {"path": "/a"})]),
                assistant([tool_call("read", {"path": "/1"}), tool_call("read", {"path": "/2"}), tool_call("read", {"path": "/3"})]),
            ],
        )
        answer = self.activity_for(limit=2)
        self.assertEqual([s["detail"] for s in answer["steps"]], ["/1", "/2", "/3"])
        self.assertEqual(len({step["seq"] for step in answer["steps"]}), 1)

    def test_a_limit_that_falls_on_a_line_boundary_keeps_the_whole_line(self):
        self.transcript(
            "a.jsonl",
            [
                boot(),
                assistant([tool_call("ls", {"path": "/a"})]),
                assistant([tool_call("read", {"path": "/1"}), tool_call("read", {"path": "/2"})]),
            ],
        )
        self.assertEqual([s["detail"] for s in self.activity_for(limit=2)["steps"]], ["/1", "/2"])

    def test_an_absurd_limit_is_clamped_rather_than_obeyed(self):
        self.transcript("a.jsonl", [boot(), assistant([tool_call("ls", {"path": "/a"})])])
        self.assertEqual(len(self.activity_for(limit=10**6)["steps"]), 1)
        self.assertEqual(len(self.activity_for(limit=0)["steps"]), 1)


CLAUDE_SESSION = "8bf1dbbb-1a3b-4914-b0aa-19e06db5af9c"


def claude_assistant(content, stop="tool_use", at="2026-07-27T09:00:10.000Z") -> dict:
    """The other dialect: the Anthropic message shape, role at the top level."""
    return {
        "type": "assistant",
        "timestamp": at,
        "sessionId": CLAUDE_SESSION,
        "message": {"role": "assistant", "content": content, "stop_reason": stop},
    }


def use(name, arguments) -> dict:
    return {"type": "tool_use", "id": "toolu_1", "name": name, "input": arguments}


class ClaudeCodeTest(unittest.TestCase):
    """A bridged Claude Code peer. Everything here exists because the bridge
    mints its own coms session id and Claude Code has never heard of it — the
    Stop hook's `transcript_path` is the only link on disk."""

    def setUp(self):
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.addCleanup(self._dir.cleanup)
        activity._boot_cache.clear()
        activity._tail_cache.clear()
        self.hooks = self.root / "claude-bridge"
        self.projects = self.root / "claude-projects"

    def hook(self, pane="w1X:p3", **record) -> Path:
        path = self.hooks / pane.replace(":", "_") / activity.BRIDGE_HOOK_BASENAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"text": "done", "written_at": "2026-07-27T09:00:00Z", **record}), encoding="utf-8")
        return path

    def transcript(self, records, folder="-home-x-repo", session=CLAUDE_SESSION) -> Path:
        return write(self.projects / folder / f"{session}.jsonl", records)

    def test_the_pane_directory_matches_what_the_bridge_writes(self):
        # `hookWatchDir` in coms-claude-bridge.ts: every character outside
        # [A-Za-z0-9_-] becomes an underscore.
        self.assertEqual(activity.bridge_hook_path("w1X:p3", self.hooks).parent.name, "w1X_p3")
        self.assertEqual(activity.bridge_hook_path("../etc", self.hooks).parent.name, "___etc")
        for empty in ("", None, "///"):
            self.assertIsNone(activity.bridge_hook_path(empty, self.hooks))

    def test_the_hooks_transcript_path_is_the_link(self):
        path = self.transcript([claude_assistant([use("Bash", {"command": "npm test"})])])
        self.hook(transcript_path=str(path), session_id=CLAUDE_SESSION)
        self.assertEqual(activity.claude_transcript("w1X:p3", self.hooks, self.projects), path)

    def test_a_transcript_path_pointing_outside_the_root_is_refused(self):
        """It arrives from a file another process writes — an input, not a fact."""
        escape = self.root / "elsewhere" / "secrets.jsonl"
        write(escape, [claude_assistant([use("Bash", {"command": "cat /etc/shadow"})])])
        self.hook(transcript_path=str(escape))
        self.assertIsNone(activity.claude_transcript("w1X:p3", self.hooks, self.projects))

    def test_an_older_hook_without_the_path_still_matches_by_session_id(self):
        path = self.transcript([claude_assistant([use("Read", {"file_path": "/etc/hosts"})])])
        self.hook(session_id=CLAUDE_SESSION)
        self.assertEqual(activity.claude_transcript("w1X:p3", self.hooks, self.projects), path)

    def test_a_session_id_that_could_climb_out_of_the_root_is_refused(self):
        self.transcript([claude_assistant([use("Bash", {"command": "ls"})])])
        for hostile in ("../../etc/passwd", "a/b", "", "x" * 200, None, 7):
            self.hook(session_id=hostile)
            self.assertIsNone(activity.claude_transcript("w1X:p3", self.hooks, self.projects))

    def rooted(self):
        """Point the module's two roots at the temp tree for a whole-path test."""
        return (
            patch.object(activity, "bridge_hook_root", return_value=self.hooks),
            patch.object(activity, "claude_projects_root", return_value=self.projects),
        )

    def test_a_peer_whose_hook_never_fired_says_so_instead_of_guessing(self):
        self.transcript([claude_assistant([use("Bash", {"command": "ls"})])])
        entry = {"name": "code-reviewer", "model": activity.CLAUDE_MODEL, "cwd": CWD}
        hooks, projects = self.rooted()
        with hooks, projects:
            answer = activity.activity_for_entry(entry, pane_id="w1X:p3")
        self.assertIs(answer["available"], False)
        self.assertIn("Stop hook", answer["reason"])

    def test_a_linked_peer_reads_end_to_end_from_the_pane_id_alone(self):
        path = self.transcript([claude_assistant([use("Bash", {"command": "npm test"})])])
        self.hook(transcript_path=str(path))
        entry = {"name": "code-reviewer", "model": activity.CLAUDE_MODEL, "cwd": CWD}
        hooks, projects = self.rooted()
        with hooks, projects:
            answer = activity.activity_for_entry(entry, pane_id="w1X:p3")
        self.assertIs(answer["available"], True)
        self.assertEqual(answer["current"]["label"], "Bash")
        self.assertEqual(answer["current"]["detail"], "npm test")

    def test_a_detached_bridged_peer_is_honest_about_why_it_cannot_be_found(self):
        # The opposite of the pi case, and worth its own sentence: this chain
        # runs through the pane, so no pane means no link.
        entry = {"name": "code-reviewer", "model": activity.CLAUDE_MODEL, "cwd": CWD, "session_id": "01X"}
        answer = activity.activity_for_entry(entry, pane_id=None)
        self.assertIs(answer["available"], False)
        self.assertIn("no herdr pane", answer["reason"])

    def test_the_claude_dialect_projects_into_the_same_steps(self):
        rows = activity.read_tail(
            self.transcript(
                [
                    claude_assistant([use("Bash", {"command": "git status"})]),
                    claude_assistant([use("Task", {"subagent_type": "Explore", "description": "find the join"})]),
                    claude_assistant([use("AskUserQuestion", {"questions": [{"question": "Which branch?"}]})]),
                    claude_assistant([{"type": "text", "text": "All tests pass."}], stop="end_turn"),
                ]
            )
        )
        steps = activity.project_steps(rows)
        self.assertEqual(
            [(s["kind"], s["label"], s["detail"]) for s in steps],
            [
                ("tool", "Bash", "git status"),
                ("dispatch", "Task", "Explore find the join"),
                ("blocked", "AskUserQuestion", ""),
                ("assistant", "said", "All tests pass."),
                ("done", "finished the turn", ""),
            ],
        )

    def test_the_claude_allowlist_is_separate_from_pis(self):
        """`Read` and `read` are different tools in different dialects; merging
        the maps would let one inherit the other's fields."""
        rows = activity.read_tail(
            self.transcript(
                [claude_assistant([use("Write", {"file_path": "/tmp/x", "content": "SECRET-FILE-BODY"})])]
            )
        )
        steps = activity.project_steps(rows)
        self.assertEqual(steps[0]["detail"], "/tmp/x")
        self.assertNotIn("SECRET-FILE-BODY", json.dumps(steps))
        # A pi tool name carries nothing in a Claude transcript and vice versa.
        self.assertEqual(activity.tool_detail("bash", {"command": "x"}, activity._CLAUDE_TOOL_DETAIL), "")
        self.assertEqual(activity.tool_detail("Bash", {"command": "x"}), "")

    def test_thinking_and_user_turns_are_dropped_in_this_dialect_too(self):
        rows = activity.read_tail(
            self.transcript(
                [
                    {"type": "user", "timestamp": "2026-07-27T09:00:00Z", "message": {"role": "user", "content": "USER-PASTED-SECRET"}},
                    claude_assistant([{"type": "thinking", "thinking": "PRIVATE-REASONING"}, use("Glob", {"pattern": "*.py"})]),
                ]
            )
        )
        body = json.dumps(activity.project_steps(rows))
        self.assertNotIn("USER-PASTED-SECRET", body)
        self.assertNotIn("PRIVATE-REASONING", body)
        self.assertIn("*.py", body)

    def test_a_continuing_claude_turn_is_not_reported_as_finished(self):
        rows = activity.read_tail(self.transcript([claude_assistant([use("Bash", {"command": "sleep 1"})], stop="tool_use")]))
        self.assertNotIn("done", [s["kind"] for s in activity.project_steps(rows)])


class EntryLookupTest(unittest.TestCase):
    def test_finds_the_named_peer_in_the_named_project_only(self):
        projects = {"alpha": [{"name": "orchestrator"}], "beta": [{"name": "orchestrator"}, {"name": "builder"}]}
        self.assertIs(activity.find_entry(projects, "beta", "builder"), projects["beta"][1])
        self.assertIsNone(activity.find_entry(projects, "alpha", "builder"))
        self.assertIsNone(activity.find_entry(projects, "gamma", "orchestrator"))


if __name__ == "__main__":
    unittest.main()
