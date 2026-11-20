"""End-to-end output-schema and no-lookahead rules for the conditional path feature."""
import importlib.util
import math
import unittest
from pathlib import Path

MODULE = Path(__file__).resolve().parents[1] / 'app' / 'services' / 'ai_chart_projections.py'
spec = importlib.util.spec_from_file_location('ai_chart_projections_test', MODULE)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def bars(timeframe_ms=60_000, count=32, end_ms=1_800_000_000_000):
    out = []
    for index in range(count):
        start = end_ms - (count - index) * timeframe_ms
        close = 1.00 + index * .002 + (.003 if index % 4 == 0 else -.002)
        op = close - (.007 if index % 2 else -.001)
        out.append({'time':start,'open':op,'high':max(op,close)+.009,
                    'low':min(op,close)-.008,'close':close,'volume':1500 if index % 3 else 500})
    return out


class TestConditionalProjections(unittest.TestCase):
    def test_three_branches_both_timeframes_and_schema(self):
        one = bars(60_000)
        five = bars(300_000)
        now = 1_800_000_000_000
        report = mod.build_ai_projections(one, five, now_ms=now)
        self.assertFalse(report['probability_calibrated'])
        self.assertEqual(set(report['timeframes']), {'1m', '5m'})
        self.assertEqual(len([m for m in report['marks'] if m['kind']=='projection']), 6)
        for frame in report['timeframes'].values():
            self.assertIn(frame['bias'], ('bullish','bearish','range'))
            self.assertGreater(frame['resistance'], frame['support'])
            self.assertLess(frame['support'], frame['upside_trigger'])
            self.assertGreater(frame['downside_trigger'], 0)
            self.assertLessEqual(frame['evidence_score'], 80)
            for key in ('bullish_path','bearish_path','base_path'):
                path=frame[key]
                self.assertEqual(path[0], {'step':0, 'price':frame['anchor_price']})
                self.assertGreater(path[-1]['step'], 0)
                self.assertTrue(all(math.isfinite(p['price']) and p['price'] > 0 for p in path))
            self.assertEqual(frame['anchor_time_ms'], max(b['time'] for b in (one if frame['timeframe']=='1m' else five)))

    def test_staleness_label_and_no_live_confidence(self):
        one=bars()
        output=mod.build_ai_projections(one, [], now_ms=one[-1]['time'] + 3_600_000)
        self.assertTrue(output['timeframes']['1m']['stale'])
        self.assertIn('historical', output['timeframes']['1m']['evidence_strength'])
        self.assertTrue(all(mark['stale'] for mark in output['marks'] if mark['kind']=='projection'))

    def test_insufficient_history_no_invented_scenarios(self):
        result=mod.build_ai_projections(bars(count=9), [])
        self.assertEqual(result['timeframes'], {})
        self.assertEqual(result['marks'], [])

    def test_future_bar_changes_do_not_affect_earlier_snapshot(self):
        one=bars(count=31)
        a=mod.build_ai_projections(one[:30], [], now_ms=one[-2]['time']+60_000)
        extended=one[:30] + [{'time':one[-1]['time']+60_000,'open':1,'high':9,'low':.01,'close':1,'volume':99999999}]
        b=mod.build_ai_projections(extended[:30], [], now_ms=one[-2]['time']+60_000)
        self.assertEqual(a,b)
        self.assertFalse(any('time_ms' in p for item in a['timeframes'].values() for p in item['bullish_path']))

    def test_invalid_bar_rejected(self):
        orig=bars()
        poisoned={'time':orig[-1]['time']+60_000,'open':1,'high':float('nan'),'low':.5,'close':2,'volume':3}
        a=mod.build_ai_projections(orig, [], now_ms=1_800_000_000_000)
        b=mod.build_ai_projections(orig+[poisoned], [], now_ms=1_800_000_000_000)
        self.assertEqual(a,b)

if __name__ == '__main__':
    unittest.main()
