from abc import ABC, abstractmethod
from typing import Any, Dict, List

from app.services.polygon_service import PolygonService
from app.services.scanner_snapshot_store import ScannerSnapshotStore


class ScannerBase(ABC):
    id: str
    name: str
    description: str

    @abstractmethod
    async def run(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        raise NotImplementedError

    async def save_afterhours_snapshot(
        self,
        polygon: PolygonService,
        snapshot_store: ScannerSnapshotStore,
        **kwargs: Any,
    ) -> Dict[str, Any]:
        raise NotImplementedError(f"{self.id} does not support afterhours snapshots")

    def list_saved_snapshot_dates(self, snapshot_store: ScannerSnapshotStore) -> List[str]:
        return snapshot_store.list_snapshot_dates(self.id, "ah")
