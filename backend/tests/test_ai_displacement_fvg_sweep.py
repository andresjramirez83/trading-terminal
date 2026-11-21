"""Synthetic causal replay tests; no market-data/network dependencies."""
from __future__ import annotations
import unittest
from app.services.ai_displacement_fvg_sweep import build_displacement_fvg_sweep, early_one_minute_hint, _target_at, _range_at
from app.workers.fvg_sweep_alert_worker import observed_alerts


class FVGReclaimTests(unittest.TestCase):
    def bars(self):
        t=1_795_000_000_000
        bars=[]
        def add(o,h,l,c):
            nonlocal t
            bars.append({'time':t,'open':o,'high':h,'low':l,'close':c,'volume':1000})
            t+=300_000
        price=1.25
        for _ in range(14):
            close=price+.07
            add(price,close+.015,price-.015,close);price=close
        for _ in range(5):
            close=price-.15
            add(price,price+.01,close-.02,close);price=close
        add(1.48,1.52,1.42,1.43)
        add(1.42,1.435,1.30,1.32)
        add(1.31,1.35,1.26,1.28)
        for i in range(26):
            low=1.28 if i%4==0 else 1.30 if i%4==1 else 1.31
            add(1.33,1.39,low,1.35)
        return bars

    def result(self,b):
        return build_displacement_fvg_sweep(b,now_ms=b[-1]['time']+330_000)

    def test_range_watch_has_preexisting_target_and_not_matched(self):
        b=self.bars()
        report=self.result(b)
        self.assertEqual(report['status'],'watching_range')
        self.assertFalse(report['matched'])
        self.assertLess(report['watch']['gap']['formed_time_ms'],b[-1]['time'])
        self.assertGreaterEqual(report['watch']['zone']['touches'],3)

    def test_rapid_wick_reclaim(self):
        b=self.bars()
        b.append({'time':b[-1]['time']+300_000,'open':1.31,'high':1.38,'low':1.22,'close':1.36,'volume':1500})
        report=self.result(b)
        self.assertEqual(report['status'],'reclaimed')
        setup=report['setup']
        self.assertEqual(setup['reclaim_quality'],'fast_wick')
        self.assertLess(setup['gap']['formed_time_ms'],setup['sweep_time_ms'])
        self.assertEqual(len(setup['stages']),2)

    def test_sweep_not_quickly_reclaimed_is_not_a_fast_wick(self):
        b=self.bars()
        b.append({'time':b[-1]['time']+300_000,'open':1.31,'high':1.33,'low':1.22,'close':1.23,'volume':1300})
        report=self.result(b)
        self.assertEqual(report['status'],'swept_waiting_reclaim')
        self.assertFalse(report['matched'])

    def test_fast_reclaim_then_target_and_inversion(self):
        b=self.bars()
        def append(o,h,l,c):
            b.append({'time':b[-1]['time']+300_000,'open':o,'high':h,'low':l,'close':c,'volume':1000})
        append(1.31,1.38,1.22,1.36)
        found=self.result(b)['setup']; lower=found['gap']['low']; upper=found['gap']['high']
        append(1.36,lower+.002,1.32,lower-.005)
        self.assertEqual(self.result(b)['status'],'target_touched')
        append(lower-.005,upper+.06,lower-.02,upper+.02)
        self.assertEqual(self.result(b)['status'],'inverted')
        append(upper+.02,upper+.07,upper-.02,upper+.03)
        self.assertEqual(self.result(b)['status'],'inversion_held')

    def test_future_gap_cannot_replace_pre_sweep_target(self):
        b=self.bars()
        index=len(b)
        zone=_range_at(b,index)
        before=_target_at(b,index,zone['low'],zone['atr'])
        self.assertIsNotNone(before)
        # Add price action that would create a newer gap AFTER the candidate
        # sweep; _target_at must remain identical at original candle cutoff.
        t=b[-1]['time']
        for j,(o,h,l,c) in enumerate(((1.8,1.9,1.7,1.72),(1.7,1.71,1.52,1.54),(1.52,1.54,1.41,1.43))):
            b.append(dict(time=t+(j+1)*300_000,open=o,high=h,low=l,close=c,volume=1000))
        after=_target_at(b,index,zone['low'],zone['atr'])
        self.assertEqual(before,after)

    def test_historical_only_avoids_phone_alert(self):
        b=self.bars(); b.append({'time':b[-1]['time']+300_000,'open':1.31,'high':1.38,'low':1.22,'close':1.36,'volume':1200})
        report=build_displacement_fvg_sweep(b,now_ms=b[-1]['time']+60*60*1000)
        self.assertTrue(report['historical_only'])
        self.assertEqual(observed_alerts('TEST',report,None,b[-1]['time']+60*60*1000),[])

    def test_closed_one_minute_only_is_labeled_early(self):
        b=self.bars(); report=self.result(b)
        last5=b[-1]['time']+300_000
        one=[{'time':last5+i*60_000,'open':1.3,'high':1.35,'low':1.2 if i==1 else 1.28,'close':1.34,'volume':100} for i in range(3)]
        report['historical_only']=False
        hint=early_one_minute_hint(one,report,now_ms=last5+180_000)
        self.assertIsNotNone(hint)
        self.assertEqual(hint['status'],'early_reclaim')
        self.assertFalse(hint['confirmed'])

    def test_unqualified_no_liquidity_no_signal(self):
        b=self.bars()[:22]
        b.extend([dict(time=b[-1]['time']+300_000+i*300_000,open=1.2,high=1.3,low=1.1,close=1.21,volume=100) for i in range(15)])
        r=self.result(b)
        self.assertNotIn(r['status'],('reclaimed','target_touched'))


if __name__=='__main__': unittest.main()
