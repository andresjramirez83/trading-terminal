"""Read-only chart mark and cookie validation tests for the AI upgrade."""
import ast
import hashlib
import hmac
import importlib.util
import os
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("test_ai_chart_annotations", ROOT / "app" / "services" / "ai_chart_annotations.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class TestAIMarks(unittest.TestCase):
    def test_measured_levels_and_area(self):
        bars = [{"time": 1700000000000 + i*300000, "open": .70, "high": .76, "low": .68, "close": .73} for i in range(20)]
        marks = mod.build_ai_annotations([], bars, {"available": True, "rally_low": .50, "rally_high": 1.0, "pullback_low": .65})
        prices = {m["id"]: m["price"] for m in marks if m["kind"] == "level"}
        self.assertAlmostEqual(prices["fib-50%"], .75)
        self.assertAlmostEqual(prices["fib-61.8%"], .691)
        self.assertAlmostEqual(prices["fib-78.6%"], .607)
        self.assertAlmostEqual(prices["pullback-low"], .65)
        self.assertTrue(any(m["kind"] == "zone" for m in marks))
        self.assertTrue(all(m["source"] == "closed_bars" for m in marks))

    def test_mark_only_supplied_closed_bars(self):
        red = {"time": 1700000000000, "open": .73, "close": .70, "high": .75, "low": .69}
        green = {"time": 1700000060000, "open": .69, "close": .75, "high": .76, "low": .68}
        marks = mod.build_ai_annotations([red, green], [], {"available": False})
        markers = [m for m in marks if m["kind"] == "marker"]
        self.assertEqual(len(markers), 1)
        self.assertEqual(markers[0]["time_ms"], green["time"])
        self.assertEqual(markers[0]["price"], green["high"])
        self.assertFalse(any(m["kind"] == "zone" for m in marks))

    def test_no_marks_from_invalid_structure(self):
        self.assertEqual(mod.build_ai_annotations([], [], {"available": False}), [])
        self.assertEqual(mod.build_ai_annotations([], [], {"available": True, "rally_low": 0, "rally_high": 1, "pullback_low": .5}), [])


class TestSessionSignature(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Evaluate precisely the repository's validator with isolated builtin dependencies.
        tree = ast.parse((ROOT / "app" / "routes" / "ai_analysis.py").read_text())
        method = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "_session_valid")
        isolated = ast.Module(body=[method], type_ignores=[])
        context = {"hmac": hmac, "hashlib": hashlib, "time": time, "SESSION_DAYS": 30}
        exec(compile(ast.fix_missing_locations(isolated), "validator", "exec"), context)
        cls.validate = staticmethod(context["_session_valid"])

    def test_valid_cookie_and_revocation(self):
        expiry = int(time.time()) + 1000
        secret = "only-on-server-long-secret"
        value = hmac.new(secret.encode(), f"trading-terminal-ai-session:v1:{expiry}".encode(), hashlib.sha256).hexdigest()
        cookie = f"v1.{expiry}.{value}"
        self.assertTrue(self.validate(cookie, secret))
        self.assertFalse(self.validate(cookie, secret + "-rotated"))
        self.assertFalse(self.validate(cookie[:-1] + ("0" if cookie[-1] != "0" else "1"), secret))
        self.assertFalse(self.validate("bad-cookie", secret))

    def test_expired_cookie(self):
        expiry = int(time.time()) - 1
        secret = "secure"
        value = hmac.new(secret.encode(), f"trading-terminal-ai-session:v1:{expiry}".encode(), hashlib.sha256).hexdigest()
        self.assertFalse(self.validate(f"v1.{expiry}.{value}", secret))


if __name__ == "__main__":
    unittest.main()
