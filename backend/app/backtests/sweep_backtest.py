from collections import defaultdict
from datetime import datetime, time
from typing import Dict, List, Optional, Set

from .market_cache import (
    clear_backtest_run,
    get_candles,
    get_scanner_picks,
    save_backtest_trade,
)


def _parse_et_time(dt_et: str) -> datetime:
    return datetime.fromisoformat(str(dt_et).replace("Z", "+00:00"))


def _group_by_date(candles: List[Dict]) -> Dict[str, List[Dict]]:
    grouped = defaultdict(list)
    for c in candles:
        grouped[str(c["trade_date"])].append(c)
    return dict(grouped)


def _is_rth(candle: Dict) -> bool:
    dt = _parse_et_time(candle["dt_et"])
    t = dt.time()
    return time(9, 30) <= t < time(16, 0)


def _prev_day_levels(prev_candles: List[Dict], regular_only: bool = True) -> Optional[Dict]:
    rows = [c for c in prev_candles if _is_rth(c)] if regular_only else prev_candles
    if not rows:
        rows = prev_candles
    if not rows:
        return None
    return {"high": max(float(c["high"]) for c in rows), "low": min(float(c["low"]) for c in rows)}


def _hour_window_levels(day_candles: List[Dict], start_hour_et: int) -> Optional[Dict]:
    rows = []
    for c in day_candles:
        dt = _parse_et_time(c["dt_et"])
        if dt.hour == start_hour_et:
            rows.append(c)
    if not rows:
        return None
    return {"high": max(float(c["high"]) for c in rows), "low": min(float(c["low"]) for c in rows)}


def _trade_window(day_candles: List[Dict], start_time_et: time = time(4, 0), end_time_et: time = time(20, 0)) -> List[Dict]:
    rows = []
    for c in day_candles:
        t = _parse_et_time(c["dt_et"]).time()
        if start_time_et <= t < end_time_et:
            rows.append(c)
    return rows


def _passes_basic_filters(
    day_candles: List[Dict],
    *,
    min_day_volume: Optional[float] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
) -> bool:
    if not day_candles:
        return False

    last_price = float(day_candles[-1]["close"])
    day_volume = sum(float(c.get("volume") or 0) for c in day_candles)

    if min_day_volume is not None and day_volume < min_day_volume:
        return False
    if min_price is not None and last_price < min_price:
        return False
    if max_price is not None and max_price > 0 and last_price > max_price:
        return False

    return True


def _simulate_sweep(
    candles: List[Dict],
    symbol: str,
    trade_date: str,
    setup: str,
    high_level: float,
    low_level: float,
    target_r: float,
    run_name: str,
    allowed_setups: Optional[Set[str]] = None,
) -> List[Dict]:
    if allowed_setups is not None and setup not in allowed_setups:
        return []

    trades: List[Dict] = []
    swept_high = False
    swept_low = False

    for i, c in enumerate(candles):
        remaining = candles[i + 1:]

        # Bearish high sweep: takes high, closes back below level.
        if not swept_high and float(c["high"]) > high_level and float(c["close"]) < high_level:
            swept_high = True
            entry = float(c["close"])
            stop = float(c["high"])
            risk = stop - entry

            if risk > 0:
                target = entry - (risk * target_r)
                result = "no_exit"
                exit_price = None
                exit_time = None
                r_multiple = 0.0

                for f in remaining:
                    hit_stop = float(f["high"]) >= stop
                    hit_target = float(f["low"]) <= target

                    # Conservative same-candle rule: if both hit in same candle, count loss.
                    if hit_stop:
                        result = "loss"
                        exit_price = stop
                        exit_time = f["dt_et"]
                        r_multiple = -1.0
                        break
                    if hit_target:
                        result = "win"
                        exit_price = target
                        exit_time = f["dt_et"]
                        r_multiple = float(target_r)
                        break

                trade = {
                    "run_name": run_name,
                    "symbol": symbol,
                    "trade_date": trade_date,
                    "setup": setup,
                    "direction": "short",
                    "sweep_level": high_level,
                    "entry_time": c["dt_et"],
                    "entry_price": entry,
                    "stop_price": stop,
                    "target_price": target,
                    "exit_time": exit_time,
                    "exit_price": exit_price,
                    "result": result,
                    "r_multiple": r_multiple,
                    "notes": "High swept and closed back below level",
                }
                save_backtest_trade(trade)
                trades.append(trade)

        # Bullish low sweep: takes low, closes back above level.
        if not swept_low and float(c["low"]) < low_level and float(c["close"]) > low_level:
            swept_low = True
            entry = float(c["close"])
            stop = float(c["low"])
            risk = entry - stop

            if risk > 0:
                target = entry + (risk * target_r)
                result = "no_exit"
                exit_price = None
                exit_time = None
                r_multiple = 0.0

                for f in remaining:
                    hit_stop = float(f["low"]) <= stop
                    hit_target = float(f["high"]) >= target

                    # Conservative same-candle rule: if both hit in same candle, count loss.
                    if hit_stop:
                        result = "loss"
                        exit_price = stop
                        exit_time = f["dt_et"]
                        r_multiple = -1.0
                        break
                    if hit_target:
                        result = "win"
                        exit_price = target
                        exit_time = f["dt_et"]
                        r_multiple = float(target_r)
                        break

                trade = {
                    "run_name": run_name,
                    "symbol": symbol,
                    "trade_date": trade_date,
                    "setup": setup,
                    "direction": "long",
                    "sweep_level": low_level,
                    "entry_time": c["dt_et"],
                    "entry_price": entry,
                    "stop_price": stop,
                    "target_price": target,
                    "exit_time": exit_time,
                    "exit_price": exit_price,
                    "result": result,
                    "r_multiple": r_multiple,
                    "notes": "Low swept and closed back above level",
                }
                save_backtest_trade(trade)
                trades.append(trade)

    return trades


def summarize_trades(trades: List[Dict]) -> Dict:
    total = len(trades)
    wins = len([t for t in trades if t["result"] == "win"])
    losses = len([t for t in trades if t["result"] == "loss"])
    no_exit = len([t for t in trades if t["result"] == "no_exit"])
    avg_r = sum(float(t.get("r_multiple") or 0) for t in trades) / total if total else 0.0

    return {
        "trades": total,
        "wins": wins,
        "losses": losses,
        "no_exit": no_exit,
        "win_rate": round((wins / total) * 100, 2) if total else 0,
        "avg_r": round(avg_r, 3),
        "net_r": round(sum(float(t.get("r_multiple") or 0) for t in trades), 3),
    }


def _run_sweep_for_symbol_dates(
    *,
    symbol: str,
    dates_to_test: Optional[Set[str]],
    timeframe: str,
    target_r: float,
    run_name: str,
    allowed_setups: Optional[Set[str]] = None,
    min_day_volume: Optional[float] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
) -> Dict[str, List[Dict]]:
    all_trades: List[Dict] = []
    by_setup = defaultdict(list)

    candles = get_candles(symbol, timeframe)
    if not candles:
        return {"all": [], "by_setup": by_setup}

    grouped = _group_by_date(candles)
    dates = sorted(grouped.keys())

    for idx, trade_date in enumerate(dates):
        if idx == 0:
            continue
        if dates_to_test is not None and trade_date not in dates_to_test:
            continue

        day_candles = _trade_window(grouped[trade_date])
        prev_day_candles = grouped[dates[idx - 1]]

        if not _passes_basic_filters(
            day_candles,
            min_day_volume=min_day_volume,
            min_price=min_price,
            max_price=max_price,
        ):
            continue

        prev_levels = _prev_day_levels(prev_day_candles, regular_only=True)
        if prev_levels:
            trades = _simulate_sweep(
                candles=day_candles,
                symbol=symbol,
                trade_date=trade_date,
                setup="previous_day_rth_sweep",
                high_level=prev_levels["high"],
                low_level=prev_levels["low"],
                target_r=target_r,
                run_name=run_name,
                allowed_setups=allowed_setups,
            )
            all_trades.extend(trades)
            by_setup["previous_day_rth_sweep"].extend(trades)

        # Pacific 5 AM = Eastern 8 AM. Pacific 6 AM = Eastern 9 AM.
        for hour_et, setup_name in [
            (8, "5am_pacific_hour_sweep"),
            (9, "6am_pacific_hour_sweep"),
        ]:
            levels = _hour_window_levels(day_candles, hour_et)
            if not levels:
                continue

            trades = _simulate_sweep(
                candles=day_candles,
                symbol=symbol,
                trade_date=trade_date,
                setup=setup_name,
                high_level=levels["high"],
                low_level=levels["low"],
                target_r=target_r,
                run_name=run_name,
                allowed_setups=allowed_setups,
            )
            all_trades.extend(trades)
            by_setup[setup_name].extend(trades)

    return {"all": all_trades, "by_setup": by_setup}


def run_sweep_backtest(
    symbols: List[str],
    timeframe: str = "15m",
    target_r: float = 2.0,
    run_name: str = "sweep_backtest",
    clear_existing: bool = True,
    setup: Optional[str] = None,
    min_day_volume: Optional[float] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
) -> Dict:
    if clear_existing:
        clear_backtest_run(run_name)

    all_trades: List[Dict] = []
    by_setup = defaultdict(list)
    symbols_used: List[str] = []
    allowed_setups = {setup} if setup else None

    for raw_symbol in symbols:
        symbol = "".join(ch for ch in str(raw_symbol).upper().strip() if ch.isalpha() or ch == ".")
        if not symbol:
            continue

        result = _run_sweep_for_symbol_dates(
            symbol=symbol,
            dates_to_test=None,
            timeframe=timeframe,
            target_r=target_r,
            run_name=run_name,
            allowed_setups=allowed_setups,
            min_day_volume=min_day_volume,
            min_price=min_price,
            max_price=max_price,
        )

        if result["all"]:
            symbols_used.append(symbol)

        all_trades.extend(result["all"])
        for setup_name, trades in result["by_setup"].items():
            by_setup[setup_name].extend(trades)

    return {
        "ok": True,
        "mode": "symbols",
        "run_name": run_name,
        "timeframe": timeframe,
        "target_r": target_r,
        "setup_filter": setup,
        "symbols_requested": symbols,
        "symbols_used": symbols_used,
        "summary": summarize_trades(all_trades),
        "by_setup": {setup_name: summarize_trades(trades) for setup_name, trades in by_setup.items()},
        "sample_trades": all_trades[:100],
    }


def run_scanner_sweep_backtest(
    scanner: str,
    timeframe: str = "15m",
    target_r: float = 2.0,
    run_name: str = "scanner_sweep_backtest",
    clear_existing: bool = True,
    setup: Optional[str] = "5am_pacific_hour_sweep",
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    min_score: Optional[float] = None,
    limit_per_day: Optional[int] = None,
    min_day_volume: Optional[float] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
) -> Dict:
    if clear_existing:
        clear_backtest_run(run_name)

    picks = get_scanner_picks(
        scanner=scanner,
        start_date=start_date,
        end_date=end_date,
        min_score=min_score,
        limit_per_day=limit_per_day,
    )

    by_symbol_dates: Dict[str, Set[str]] = defaultdict(set)
    for pick in picks:
        symbol = "".join(ch for ch in str(pick.get("symbol", "")).upper().strip() if ch.isalpha() or ch == ".")
        pick_date = str(pick.get("pick_date") or "")
        if symbol and pick_date:
            by_symbol_dates[symbol].add(pick_date)

    all_trades: List[Dict] = []
    by_setup = defaultdict(list)
    symbols_used: List[str] = []
    allowed_setups = {setup} if setup else None

    for symbol, dates_to_test in by_symbol_dates.items():
        result = _run_sweep_for_symbol_dates(
            symbol=symbol,
            dates_to_test=dates_to_test,
            timeframe=timeframe,
            target_r=target_r,
            run_name=run_name,
            allowed_setups=allowed_setups,
            min_day_volume=min_day_volume,
            min_price=min_price,
            max_price=max_price,
        )

        if result["all"]:
            symbols_used.append(symbol)

        all_trades.extend(result["all"])
        for setup_name, trades in result["by_setup"].items():
            by_setup[setup_name].extend(trades)

    return {
        "ok": True,
        "mode": "scanner_picks",
        "scanner": scanner,
        "run_name": run_name,
        "timeframe": timeframe,
        "target_r": target_r,
        "setup_filter": setup,
        "pick_count": len(picks),
        "scanner_symbol_count": len(by_symbol_dates),
        "symbols_used": symbols_used,
        "filters": {
            "start_date": start_date,
            "end_date": end_date,
            "min_score": min_score,
            "limit_per_day": limit_per_day,
            "min_day_volume": min_day_volume,
            "min_price": min_price,
            "max_price": max_price,
        },
        "summary": summarize_trades(all_trades),
        "by_setup": {setup_name: summarize_trades(trades) for setup_name, trades in by_setup.items()},
        "sample_trades": all_trades[:100],
    }
