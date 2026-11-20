"""Deterministic closed-candle tests. No network/broker/API requests."""
import unittest
from app.services.ai_mtf_fvg_respect import _bars, _fvg_inventory, _reaction_evidence, build_mtf_fvg_respect

BASE = 1795000000000

def bar(i, o=100, h=101, l=99, c=100, minutes=5):
    return {"time": BASE+i*minutes*60_000, "open":o,"high":h,"low":l,"close":c,"volume":100}

def gap_series():
    b=[bar(i) for i in range(8)]
    b.extend([
        bar(8,100,101,99,100),
        bar(9,101,103,100,102),
        bar(10,105,106,104,105),
        bar(11,104,106,102.5,105),
        bar(12,102,103,100.5,102),
        bar(13,100,101,98,99),
    ])
    return b

def bullish_gap(gaps):
    return next(x for x in gaps if x['formed_time_ms']==BASE+10*300_000 and x['direction']=='bullish')

class TestFVGInventory(unittest.TestCase):
    def test_candle_formation_and_no_future_lookahead(self):
        b=gap_series()
        self.assertEqual(bullish_gap(_fvg_inventory('5m',_bars(b[:11])))['status'],'untouched')
        gap=bullish_gap(_fvg_inventory('5m',_bars(b[:12])))
        self.assertEqual(gap['status'],'partially_filled')
        self.assertAlmostEqual(gap['remaining_low'],101)
        self.assertAlmostEqual(gap['remaining_high'],102.5)
        self.assertAlmostEqual(gap['remaining_fraction'], 0.5)
        gap=bullish_gap(_fvg_inventory('5m',_bars(b[:13])))
        self.assertEqual(gap['status'],'filled')
        self.assertAlmostEqual(gap['remaining_fraction'],0)
        gap=bullish_gap(_fvg_inventory('5m',_bars(b)))
        self.assertEqual(gap['status'],'invalidated')

    def test_invalid_bars_rejected_and_deduplicated(self):
        b=gap_series()
        b.extend([dict(b[2]),{'time':BASE+14*300_000,'open':-1,'high':1,'low':0,'close':1},
                  {'time':BASE+15*300_000,'open':float('nan'),'high':1,'low':1,'close':1}])
        self.assertEqual(len(_bars(b)),14)

    def test_no_forced_respected_timeframe(self):
        b=gap_series()
        r=build_mtf_fvg_respect({'5m':b},now_ms=b[-1]['time']+300000)
        self.assertIsNone(r['dominant_timeframe'])
        self.assertEqual(r['timeframes']['1h']['closed_candles'],0)
        self.assertFalse(any(g['status'] in ('filled','invalidated') for g in r['ranked_open_gaps']))

    def test_stale_data_does_not_create_live_recommendation(self):
        b=gap_series()
        r=build_mtf_fvg_respect({'5m':b},now_ms=b[-1]['time']+100*86400000)
        self.assertTrue(r['timeframes']['5m']['stale'])
        self.assertIsNone(r['dominant_timeframe'])
        self.assertIsNone(r['selected_gap'])
        self.assertTrue(all(g['data_stale'] for g in r['ranked_open_gaps']))

    def test_respect_insufficient_when_no_confirmed_retests(self):
        b=[bar(i,o=100,h=101,l=99,c=100) for i in range(40)]
        e=_reaction_evidence('5m',_bars(b),[])
        self.assertEqual(e['quality'],'insufficient')
        self.assertEqual(e['positive_reactions'],0)
        self.assertIsNone(e['respect_ratio'])

if __name__=='__main__':
    unittest.main()
