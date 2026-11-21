"""Opt-in read-only Pushover notifications for the displacement/FVG sweep setup.

Independent process, no importing execution or auto-trade modules. Uses completed
1m and 5m market-data candles only. Does not emit historical alerts on first start.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import quote

import httpx
import requests

from app.services.ai_pattern_engine import closed_bars
from app.services.ai_displacement_fvg_sweep import build_displacement_fvg_sweep, early_one_minute_hint
from app.services.alpaca_market_service import AlpacaMarketService
from app.services.daily_watchlist_store import DailyWatchlistStore

log = logging.getLogger("fvg-sweep-alert")
STATE_FILE = Path(__file__).resolve().parents[1] / "data" / "app_state" / "fvg_sweep_alerts.json"
SYM_RE = re.compile(r"^[A-Z][A-Z0-9.\-]{0,9}$")


def symbols_to_monitor() -> List[str]:
    """Explicit symbols first, then today's existing manual/scanner watchlist."""
    raw = os.getenv("TT_FVG_SWEEP_SYMBOLS", "")
    supplied = [s.strip().upper() for s in raw.split(",")]
    if os.getenv("TT_FVG_SWEEP_USE_WATCHLIST", "1") != "0":
        from datetime import datetime
        from zoneinfo import ZoneInfo
        day = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
        today = DailyWatchlistStore().load(day) or {}
        manual = today.get("manual") or {}
        supplied.extend(manual.get("symbols") or [])
        supplied.extend(today.get("scannerSymbols") or [])
    limit = max(1, min(15, int(os.getenv("TT_FVG_SWEEP_MAX_SYMBOLS", "10"))))
    return list(dict.fromkeys(s for value in supplied if (s := str(value).strip().upper()) and SYM_RE.fullmatch(s)))[:limit]


def observed_alerts(symbol: str, report: dict, hint: Optional[dict], now_ms: int) -> List[dict]:
    """Stable stage events eligible ONLY while last closed candle is recent."""
    events = []
    if hint:
        stamp = int(hint['time_ms'])
        if 0 <= now_ms - (stamp + 60_000) <= 6*60_000:
            stage = hint['status']
            events.append({'key': f'{symbol}:1m:{stage}:{stamp}', 'symbol': symbol,
                           'stage': stage, 'stamp': stamp,
                           'message': (f"{symbol} 1m {'closed above range low' if stage == 'early_reclaim' else 'swept range low'} "
                                       f"${hint['support']:.3f}. Watch closed 5m reclaim. "
                                       f"Pre-existing bearish FVG ${hint['gap_low']:.3f}-${hint['gap_high']:.3f}. "
                                       "EARLY, not a confirmed setup.")})
    setup = report.get('setup')
    if not setup or report.get('historical_only'):
        return events
    stamp = int(setup['stage_time_ms'])
    # Only send notifications for a very recent 5-minute stage; not old chart patterns.
    if not (0 <= now_ms-(stamp+300_000) <= 10*60_000):
        return events
    stage = report['status']
    gap = setup['gap']; zone = setup['zone']
    desc = {
        'swept_waiting_reclaim': 'Sweep below consolidation; RECLAIM NOT CONFIRMED',
        'reclaimed': f"Closed 5m reclaim ({setup['reclaim_quality']})",
        'target_touched': 'Price traded into bearish FVG: potential target reached',
        'invalidated': 'Closed beneath sweep low: setup invalidated',
        'inverted': '5m close above bearish FVG: possible inversion, watch retest',
        'inversion_held': '5m retest held above inverted FVG: continuation watch',
        'inversion_failed': 'Inverted FVG support failed',
    }.get(stage)
    if desc:
        events.append({'key': f"{symbol}:{setup['id']}:{stage}", 'symbol': symbol,
                       'stage': stage, 'stamp': stamp,
                       'message': (f"{symbol} {desc}. Range low ${zone['low']:.3f} "
                                   f"({zone['touches']} tests / {zone['candles']} closed 5m bars). "
                                   f"Prior bearish FVG ${gap['low']:.3f}-${gap['high']:.3f}; "
                                   f"invalidation watch ${setup['invalidation']:.3f}. "
                                   "Research alert, not a trade instruction.")})
    return events


def _load_seen(path: Path) -> Optional[Dict[str, int]]:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text('utf-8'))
        return {str(k): int(v) for k,v in data.items()} if isinstance(data, dict) else None
    except (ValueError, OSError, TypeError):
        # Fail closed rather than flooding phones after state corruption.
        log.error('Alert state invalid; no notifications until corrected: %s', path)
        raise RuntimeError('Invalid alert state')


def _save_seen(path: Path, seen: Dict[str, int]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cutoff = int(time.time()*1000) - 7*86400_000
    limited = {k:v for k,v in seen.items() if v >= cutoff}
    tmp = path.with_name(path.name + '.tmp')
    tmp.write_text(json.dumps(limited, separators=(',', ':')), encoding='utf8')
    tmp.replace(path)


def _pushover(event: dict) -> None:
    user = os.getenv('PUSHOVER_USER_KEY','').strip()
    token = os.getenv('PUSHOVER_APP_TOKEN','').strip()
    if not user or not token:
        raise RuntimeError('Pushover keys are not configured in the server environment')
    chart_url = os.getenv('TT_FVG_SWEEP_CHART_URL','https://165.22.145.148/chart')
    response = requests.post('https://api.pushover.net/1/messages.json', data={
        'user': user, 'token': token, 'title': f"{event['symbol']} · FVG sweep {event['stage'].replace('_',' ')}",
        'message': event['message'], 'priority': 0, 'url': chart_url,
        'url_title': 'Open Trading Terminal chart',
    }, timeout=12)
    response.raise_for_status()
    if response.json().get('status') != 1:
        raise RuntimeError('Pushover declined message')


async def _fetch(symbol: str, client: httpx.AsyncClient) -> tuple[list, list]:
    service = AlpacaMarketService()
    service._client = lambda _timeout: client
    a, b = await asyncio.gather(
        service.get_bars(symbol,'1m','extended',lookback='2d',limit=260),
        service.get_bars(symbol,'5m','extended',lookback='5d',limit=180),
    )
    return closed_bars(a,1), closed_bars(b,5)


async def tick(seen: Dict[str,int], *, initial: bool, path: Path, sender=_pushover) -> None:
    symbols = symbols_to_monitor()
    if not symbols:
        log.info('No symbols in explicit config or today\'s watchlist')
        return
    now_ms = int(time.time()*1000)
    limits = httpx.Limits(max_keepalive_connections=4,max_connections=6)
    timeout = httpx.Timeout(connect=10,read=35,write=20,pool=15)
    async with httpx.AsyncClient(timeout=timeout,limits=limits,follow_redirects=True) as client:
        for symbol in symbols:
            try:
                one,five = await _fetch(symbol,client)
                report = build_displacement_fvg_sweep(five,now_ms=now_ms)
                hint = early_one_minute_hint(one,report,now_ms=now_ms)
                events = observed_alerts(symbol,report,hint,now_ms)
                for event in events:
                    if event['key'] in seen:
                        continue
                    if initial:
                        # Startup primes only observed recent events. Do not spam
                        # already-existing setups when a worker is first enabled.
                        seen[event['key']] = now_ms
                        continue
                    await asyncio.to_thread(sender,event)
                    seen[event['key']] = now_ms  # only after success
                    log.info('Pushover sent %s stage=%s',symbol,event['stage'])
                _save_seen(path,seen)
            except Exception as exc:
                log.warning('Read-only scan failed %s: %s',symbol,str(exc)[:220])


async def run() -> None:
    if os.getenv('TT_FVG_SWEEP_ALERTS_ENABLED','0') != '1':
        raise SystemExit('FVG sweep alerts disabled. Set TT_FVG_SWEEP_ALERTS_ENABLED=1 after validation.')
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(levelname)s %(message)s')
    seen = _load_seen(STATE_FILE)
    initial = seen is None
    if seen is None: seen = {}
    log.info('Starting alert-only FVG sweep watcher (initial_run=%s)', initial)
    while True:
        await tick(seen,initial=initial,path=STATE_FILE)
        initial = False
        await asyncio.sleep(max(30,min(300,int(os.getenv('TT_FVG_SWEEP_POLL_SECONDS','60')))))


if __name__ == '__main__':
    asyncio.run(run())
