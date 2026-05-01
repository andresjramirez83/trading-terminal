from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional


class ScannerSnapshotStore:
    def __init__(self, base_dir: Optional[Path] = None) -> None:
        if base_dir is None:
            base_dir = Path(__file__).resolve().parents[1] / "data" / "scanner_snapshots"
        self.base_dir = base_dir
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _file_path(self, scanner_id: str, session: str, trade_date: str) -> Path:
        return self.base_dir / f"{scanner_id}_{session}_{trade_date}.json"

    def save_snapshot(self, scanner_id: str, session: str, trade_date: str, payload: Dict[str, Any]) -> str:
        path = self._file_path(scanner_id, session, trade_date)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return str(path)

    def load_snapshot(self, scanner_id: str, session: str, trade_date: str) -> Optional[Dict[str, Any]]:
        path = self._file_path(scanner_id, session, trade_date)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def list_snapshot_dates(self, scanner_id: str, session: str) -> List[str]:
        prefix = f"{scanner_id}_{session}_"
        dates: List[str] = []
        for path in self.base_dir.glob(f"{prefix}*.json"):
            name = path.stem
            if name.startswith(prefix):
                dates.append(name[len(prefix):])
        return sorted(set(dates), reverse=True)

    def load_latest_snapshot(self, scanner_id: str, session: str) -> Optional[Dict[str, Any]]:
        dates = self.list_snapshot_dates(scanner_id, session)
        if not dates:
            return None
        return self.load_snapshot(scanner_id, session, dates[0])
