import unittest
from fastapi import HTTPException
from plugin_api import validate_task_request

class PluginApiValidationTest(unittest.TestCase):
    def test_accepts_identical_bounded_task_contract(self):
        validate_task_request("task-1:gen.2", 1, 0)
        validate_task_request("x" * 128, 2, 1_000_000_000)
    def test_rejects_invalid_task_generation_and_cursor(self):
        for args in [("",1,0),("bad/path",1,0),("x"*129,1,0),("task",0,0),("task",True,0),("task",1,True),("task",1,-1),("task",1,1_000_000_001)]: 
            with self.assertRaises(HTTPException): validate_task_request(*args)
if __name__ == "__main__": unittest.main()
