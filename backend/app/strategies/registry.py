from __future__ import annotations

from typing import Any, Dict, List, Optional, Type


def _load_class(module_name: str, class_names: List[str]) -> Optional[Type[Any]]:
    try:
        module = __import__(module_name, fromlist=class_names)
    except Exception:
        return None
    for name in class_names:
        obj = getattr(module, name, None)
        if obj is not None:
            return obj
    return None


class StrategyRegistry:
    def __init__(self) -> None:
        self._strategies: Dict[str, Any] = {}
        self._register_defaults()

    def _register_defaults(self) -> None:
        six_cls = _load_class(
            "app.strategies.six_seven_sweep",
            ["SixSevenSweepStrategy", "SixSevenStrategy", "Strategy"],
        )
        if six_cls is not None:
            self.register("six_seven_sweep", six_cls())

        five_cls = _load_class(
            "app.strategies.five_am_sweep",
            ["FiveAmSweepStrategy", "FiveAMSweepStrategy", "Strategy"],
        )
        if five_cls is not None:
            self.register("five_am_sweep", five_cls())

    def register(self, strategy_id: str, strategy: Any) -> None:
        self._strategies[str(strategy_id).strip()] = strategy

    def get(self, strategy_id: str) -> Optional[Any]:
        return self._strategies.get(str(strategy_id).strip())

    def list(self) -> List[Dict[str, Any]]:
        rows: List[Dict[str, Any]] = []
        for strategy_id, strategy in self._strategies.items():
            rows.append({
                "id": strategy_id,
                "label": getattr(strategy, "label", strategy_id),
            })
        return rows
