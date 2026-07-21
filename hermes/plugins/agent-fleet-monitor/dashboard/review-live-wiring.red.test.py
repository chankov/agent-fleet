import pathlib
import unittest
from adapter import MonitorAdapter, MonitorUnavailable

ROOT = pathlib.Path(__file__).resolve().parents[4]

class ReviewLiveWiringRedTest(unittest.TestCase):
    def test_explicit_human_profile_id_has_the_shared_canonical_namespace_contract(self):
        # lifecycle accepts this documented human id; adapter must canonicalize it identically.
        self.assertEqual(MonitorAdapter.canonical_profile_id("profile-a"), "104c4491498717b382d124bbe81ae4e87648fbab08ecba7e24135ead5fc97554")

    def test_plugin_uses_fastapi_query_parameter_names_end_to_end(self):
        source=(ROOT/"hermes/desktop-plugins/agent-fleet-monitor/plugin.js").read_text()
        self.assertIn("task_id", source)
        self.assertIn("after_sequence", source)
        self.assertNotIn("afterSequence", source)

    def test_cancel_response_has_an_explicit_bounded_wire_contract(self):
        source=(ROOT/"scripts/lib/hermes-monitor-socket.ts").read_text()
        self.assertRegex(source, r"MAX_CANCEL_RESPONSE_BYTES|cap.*cancel|cancel.*MAX_", "cancel response must be capped")

if __name__ == "__main__": unittest.main()
