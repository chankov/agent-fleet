import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).parents[1]/'skills/hub-watchdog/scripts'))
from watchdog_delivery import delivery_state
class Delivery(unittest.TestCase):
 def test_no_artifact_is_journal_only(self): self.assertEqual(delivery_state(None)['originDelivery'],False)
