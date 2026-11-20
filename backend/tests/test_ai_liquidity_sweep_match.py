"""Pure deterministic behavior: no market, broker, OpenAI or trade calls."""
import unittest
from app.services.ai_liquidity_sweep_match import match_saved_liquidity_sweep

T0 = 1800000000000
REF = {"name": "Bullish Liquidity Sweep + Reclaim", "timeframe": "5m", "note": "retest hold"}


def bars():
    b = [{"time": T0+i*300000, "open": 10.15, "high": 10.20,
          "low": 10.0, "close": 10.14, "volume": 100} for i in range(26)]
    b.extend([
        {"time": T0+26*300000, "open": 10.05, "high": 10.08, "low": 9.7, "close": 9.9, "volume": 200},
        {"time": T0+27*300000, "open": 9.91, "high": 10.18, "low": 9.88, "close": 10.14, "volume": 250},
        {"time": T0+28*300000, "open": 10.0, "high": 10.11, "low": 9.99, "close": 10.06, "volume": 120},
        {"time": T0+29*300000, "open": 10.12, "high": 10.35, "low": 10.05, "close": 10.30, "volume": 290},
    ])
    return b


class SweepMatcherTests(unittest.TestCase):
    def match(self, candles, **kwargs):
        return match_saved_liquidity_sweep(candles, REF, now_ms=candles[-1]["time"]+300000, **kwargs)

    def test_stage_sequence_only_after_observation(self):
        b = bars()
        a = [self.match(b[:i]) for i in (26, 27, 28, 29, 30)]
        self.assertEqual([r["status"] for r in a], [
            "not_found", "not_found", "reclaimed_waiting_retest", "retest_held", "continuation_observed"])
        for i, result in zip((26, 27, 28, 29, 30), a):
            self.assertTrue(all(s["time_ms"] <= b[i-1]["time"] for s in result["stages"]))
        self.assertEqual([x["stage"] for x in a[-1]["stages"]],
                         ["liquidity", "sweep", "reclaim", "hold", "breakout"])
        self.assertTrue(a[-1]["matched"])

    def test_no_claim_from_simple_continuation(self):
        self.assertFalse(self.match(bars()[:26])["matched"])

    def test_invalidated_after_close_below_sweep(self):
        b = bars()
        b.append({"time": T0+30*300000, "open": 9.9, "high": 10, "low": 9.61,
                  "close": 9.65, "volume": 250})
        r = self.match(b)
        self.assertEqual(r["status"], "invalidated")
        self.assertFalse(r["matched"])

    def test_unsupported_patterns_do_not_fabricate_matches(self):
        p = {"name": "Breakout squeeze", "timeframe": "5m"}
        r = match_saved_liquidity_sweep(bars(), p)
        self.assertEqual(r["status"], "unsupported")
        self.assertFalse(r["stages"])

    def test_stale_is_historical_only(self):
        b = bars()
        r = match_saved_liquidity_sweep(b, REF, now_ms=b[-1]["time"]+5*86400_000)
        self.assertTrue(r["historical_only"])
        self.assertTrue(r["matched"])  # observed history, not a live signal

    def test_overnight_is_not_a_quick_reclaim(self):
        b = bars()[:27]
        b.append({**bars()[27], "time": b[-1]["time"] + 12*3600_000,
                  "open": 10.01, "low": 10.00, "close": 10.14})
        r = self.match(b)
        self.assertEqual(r["status"], "not_found")

    def test_duplicate_and_invalid_bars_ignored(self):
        b = bars()
        bad = {"time": T0 + 30*300000, "open": -1, "high": 10, "low": 1, "close": 8}
        r = self.match(b + [bad, dict(b[3])])
        self.assertTrue(r["matched"])


if __name__=='__main__': unittest.main()
