"""Alert content, dedupe state and historical suppression; never contacts Pushover."""
import tempfile
import unittest
from pathlib import Path
from app.services.ai_displacement_fvg_sweep import build_displacement_fvg_sweep
from app.workers.fvg_sweep_alert_worker import observed_alerts, _load_seen, _save_seen
import test_ai_displacement_fvg_sweep as fixtures

class PhoneAlertsTests(unittest.TestCase):
    def test_current_confirmed_reclaim_phone_event_has_known_target(self):
        b=fixtures.FVGReclaimTests().bars()
        b.append({'time':b[-1]['time']+300000,'open':1.31,'high':1.38,'low':1.22,'close':1.36,'volume':1000})
        now=b[-1]['time']+320000
        report=build_displacement_fvg_sweep(b,now_ms=now)
        e=observed_alerts('TEST',report,None,now)
        self.assertEqual(len(e),1)
        self.assertEqual(e[0]['stage'],'reclaimed')
        self.assertIn('bearish FVG',e[0]['message'])
        self.assertNotIn('BUY',e[0]['message'].upper())

    def test_persisted_state_de_dupes_across_restart(self):
        with tempfile.TemporaryDirectory() as folder:
            file=Path(folder)/'state.json'
            self.assertIsNone(_load_seen(file))
            _save_seen(file,{'AB:reclaimed:123':int(__import__('time').time()*1000)})
            state=_load_seen(file)
            self.assertIn('AB:reclaimed:123',state)

    def test_no_historical_alert(self):
        b=fixtures.FVGReclaimTests().bars()
        b.append({'time':b[-1]['time']+300000,'open':1.31,'high':1.38,'low':1.22,'close':1.36,'volume':1000})
        now=b[-1]['time']+3600000
        r=build_displacement_fvg_sweep(b,now_ms=now)
        self.assertEqual(observed_alerts('TEST',r,None,now),[])

if __name__=='__main__':unittest.main()
