from app.scanners.overnight_runner import OvernightRunnerScanner
from app.scanners.ifvg_htf_scanner import IFVGHTFScanner
from app.scanners.gap_atr_runner import GapAtrRunnerScanner
from app.scanners.hourly_sweep_runner import HourlySweepRunnerScanner


class ScannerRegistry:
    def __init__(self):
        scanners = [
            OvernightRunnerScanner(),
            IFVGHTFScanner(),
            GapAtrRunnerScanner(),
            HourlySweepRunnerScanner(),
        ]
        self.scanners = {scanner.id: scanner for scanner in scanners}

    def get(self, scanner_id: str):
        return self.scanners.get(scanner_id)

    def list(self):
        return [
            {
                "id": s.id,
                "name": s.name,
                "description": s.description,
            }
            for s in self.scanners.values()
        ]
