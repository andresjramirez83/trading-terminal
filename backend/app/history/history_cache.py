from __future__ import annotations

import time
from dataclasses import dataclass
from threading import RLock
from typing import Dict, List, Optional

from app.history.history_types import HistoryBar


@dataclass(slots=True)
class HistoryCacheEntry:
    expires_at: float
    bars: List[HistoryBar]


class HistoryCache:
    def __init__(self, max_items: int = 500) -> None:
        self.max_items = max_items
        self._items: Dict[str, HistoryCacheEntry] = {}
        self._lock = RLock()

    def make_key(
        self,
        *,
        provider: str,
        symbol: str,
        timeframe: str,
        session: str,
        lookback_key: str,
    ) -> str:
        return "::".join(
            [
                provider.lower().strip(),
                symbol.upper().strip(),
                timeframe.strip(),
                session.lower().strip(),
                lookback_key.strip(),
            ]
        )

    def get(self, key: str) -> Optional[List[HistoryBar]]:
        now = time.time()

        with self._lock:
            entry = self._items.get(key)

            if entry is None:
                return None

            if entry.expires_at <= now:
                self._items.pop(key, None)
                return None

            return [bar for bar in entry.bars]

    def set(self, key: str, bars: List[HistoryBar], ttl_seconds: int) -> None:
        with self._lock:
            self._prune_if_needed()

            self._items[key] = HistoryCacheEntry(
                expires_at=time.time() + max(1, int(ttl_seconds)),
                bars=[bar for bar in bars],
            )

    def clear(self) -> None:
        with self._lock:
            self._items.clear()

    def delete(self, key: str) -> None:
        with self._lock:
            self._items.pop(key, None)

    def stats(self) -> dict:
        now = time.time()

        with self._lock:
            active = 0
            expired = 0

            for entry in self._items.values():
                if entry.expires_at > now:
                    active += 1
                else:
                    expired += 1

            return {
                "max_items": self.max_items,
                "total_items": len(self._items),
                "active_items": active,
                "expired_items": expired,
            }

    def _prune_if_needed(self) -> None:
        now = time.time()

        expired_keys = [
            key
            for key, entry in self._items.items()
            if entry.expires_at <= now
        ]

        for key in expired_keys:
            self._items.pop(key, None)

        if len(self._items) < self.max_items:
            return

        oldest_key = min(
            self._items,
            key=lambda key: self._items[key].expires_at,
        )

        self._items.pop(oldest_key, None)