from app.scanners.overnight_runner import OvernightRunnerScanner
from app.scanners.ifvg_htf_scanner import IFVGHTFScanner
from app.scanners.gap_atr_runner import GapAtrRunnerScanner
from app.scanners.hourly_sweep_runner import HourlySweepRunnerScanner
from app.scanners.liquidity_reclaim_scanner import LiquidityReclaimScanner
from app.scanners.vwap3_target_scanner import VWAP3TargetScanner
from app.scanners.momentum_volume_runner import MomentumVolumeRunnerScanner


import json
from pathlib import Path
from app.scanners.base import ScannerBase

class FibHLScanner(ScannerBase):
    id = "fib_hl_liquidity"
    name = "Fibonacci HL Liquidity Sweeps"
    description = "Automatically discovered 1m, 5m, and 15m Fibonacci HL sweeps and reclaims."

    async def run(self, market, snapshot_store, **kwargs):
        path = Path(__file__).resolve().parents[1] / "data" / "app_state" / "fib_hl_scanner_signals.json"
        try:
            events = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            events = []
        rows = []
        for event in events if isinstance(events, list) else []:
            if not isinstance(event, dict) or not event.get("symbol"):
                continue
            stage = str(event.get("stage") or "")
            row = dict(event)
            row.update(scanner_id=self.id, scanner_name=self.name, source=self.id, setup_stage="SWEEPING" if stage == "SWEEP" else "RECLAIMED", runner_score=45 if stage == "SWEEP" else 65, score=45 if stage == "SWEEP" else 65, liquidity_level=event.get("hl_price"), support_level=event.get("hl_price"), sweep_price=event.get("sweep_low"), notes=["Historical signal", stage])
            rows.append(row)
        rows.sort(key=lambda row: str(row.get("detected_at") or ""), reverse=True)
        rows = rows[:max(1, min(250, int(kwargs.get("max_symbols") or 100)))]
        return {"scanner_id": self.id, "scanner_name": self.name, "description": self.description, "workflow": "fib_hl_liquidity", "timeframe": "multi", "count": len(rows), "rows": rows, "meta": {"checked": 0, "passed": len(rows), "source": "existing Fibonacci worker"}}

class ScannerRegistry:
    def __init__(self):
        scanners = [
            OvernightRunnerScanner(),
            IFVGHTFScanner(),
            GapAtrRunnerScanner(),
            HourlySweepRunnerScanner(),
            LiquidityReclaimScanner(),
            VWAP3TargetScanner(),
            MomentumVolumeRunnerScanner(),
            FibHLScanner(),
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
