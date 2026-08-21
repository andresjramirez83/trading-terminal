from __future__ import annotations

import json
import os
import re
import threading
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote

import requests


ALPACA_DATA_BASE_URL = os.getenv("ALPACA_DATA_BASE_URL", "https://data.alpaca.markets").rstrip("/")
NASDAQ_HALTS_URL = os.getenv(
    "NASDAQ_HALTS_URL",
    "https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts",
).strip()
SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SEC_SUBMISSIONS_BASE = "https://data.sec.gov/submissions"
NASDAQ_EARNINGS_URL = "https://api.nasdaq.com/api/calendar/earnings"

HALTS_TTL_SECONDS = 60.0
NEWS_TTL_SECONDS = 20.0
FILINGS_TTL_SECONDS = 300.0
EARNINGS_TTL_SECONDS = 900.0
SEC_TICKERS_TTL_SECONDS = 86400.0


HALT_CODE_LABELS: Dict[str, str] = {
    "T1": "News Pending",
    "T2": "News Released",
    "T3": "News and Resumption Times",
    "T5": "Single Stock Trading Pause",
    "T6": "Extraordinary Market Activity",
    "T7": "Quotation-Only Period",
    "LUDP": "Volatility Trading Pause",
    "LUDS": "Volatility Pause - Straddle Condition",
    "M": "Volatility Trading Pause",
    "M1": "Corporate Action",
    "M2": "Quotation Not Available",
    "O1": "Operations Halt",
    "IPO1": "IPO Issue Not Yet Trading",
    "IPOQ": "IPO Released for Quotation",
    "IPOE": "IPO Positioning Window Extension",
    "R1": "New Issue Available",
    "R2": "Issue Available",
    "R4": "Qualifications Resolved - Resume",
    "R9": "Filing Requirements Resolved - Resume",
    "C3": "Issuer News Not Forthcoming - Resume",
    "C4": "Qualifications Halt Ended - Resume",
    "C9": "Filings Met - Resume",
    "C11": "Regulatory Halt Concluded - Resume",
}

OFFERING_FORMS = {
    "S-1",
    "S-1/A",
    "S-3",
    "S-3/A",
    "F-1",
    "F-1/A",
    "F-3",
    "F-3/A",
    "424B1",
    "424B2",
    "424B3",
    "424B4",
    "424B5",
    "424B7",
    "424B8",
    "EFFECT",
}
EARNINGS_FORMS = {"10-Q", "10-Q/A", "10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}


class _TimedCache:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._values: Dict[str, Tuple[float, Any]] = {}

    def get(self, key: str) -> Any:
        now = time.monotonic()
        with self._lock:
            hit = self._values.get(key)
            if hit is None:
                return None
            expires_at, value = hit
            if expires_at <= now:
                self._values.pop(key, None)
                return None
            return value

    def put(self, key: str, value: Any, ttl_seconds: float) -> Any:
        with self._lock:
            self._values[key] = (time.monotonic() + max(1.0, ttl_seconds), value)
        return value


_cache = _TimedCache()
_session = requests.Session()
_session.headers.update(
    {
        "Accept": "application/json, application/xml, text/xml, */*",
        "Connection": "keep-alive",
        "User-Agent": "TradingTerminal/1.0",
    }
)


def _normalize_symbol(symbol: str) -> str:
    value = re.sub(r"[^A-Z0-9.\-]", "", str(symbol or "").strip().upper())
    if not value:
        raise ValueError("symbol is required")
    return value[:24]


def _alpaca_credentials() -> Tuple[str, str]:
    # Explicit news credentials win, then live, then paper, then common legacy names.
    key = (
        os.getenv("ALPACA_NEWS_KEY_ID", "").strip()
        or os.getenv("APCA_API_KEY_ID_LIVE", "").strip()
        or os.getenv("APCA_API_KEY_ID_PAPER", "").strip()
        or os.getenv("APCA_API_KEY_ID", "").strip()
    )
    secret = (
        os.getenv("ALPACA_NEWS_SECRET_KEY", "").strip()
        or os.getenv("APCA_API_SECRET_KEY_LIVE", "").strip()
        or os.getenv("APCA_API_SECRET_KEY_PAPER", "").strip()
        or os.getenv("APCA_API_SECRET_KEY", "").strip()
    )
    return key, secret


def _keyword_category(headline: str, summary: str = "") -> str:
    text = f"{headline} {summary}".lower()
    if any(
        word in text
        for word in (
            "public offering",
            "registered offering",
            "direct offering",
            "at-the-market",
            "at the market offering",
            "shelf registration",
            "dilution",
            "prices offering",
            "priced offering",
            "424b",
        )
    ):
        return "offering"
    if any(
        word in text
        for word in (
            "earnings",
            "financial results",
            "quarter results",
            "quarterly results",
            "reports q1",
            "reports q2",
            "reports q3",
            "reports q4",
            "eps",
            "revenue guidance",
        )
    ):
        return "earnings"
    if any(word in text for word in ("fda", "phase 1", "phase 2", "phase 3", "clinical trial", "patent")):
        return "catalyst"
    if any(word in text for word in ("upgrade", "downgrade", "price target", "initiates coverage", "rating")):
        return "analyst"
    if any(word in text for word in ("merger", "acquisition", "acquire", "strategic agreement", "partnership", "contract award")):
        return "corporate"
    return "company"


def _impact_for_category(category: str) -> str:
    if category in {"halt", "offering"}:
        return "critical"
    if category in {"earnings", "catalyst"}:
        return "high"
    if category in {"corporate", "analyst"}:
        return "medium"
    return "info"


def _fetch_alpaca_news(symbol: str, limit: int = 20) -> Dict[str, Any]:
    cache_key = f"news:{symbol}:{limit}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    key, secret = _alpaca_credentials()
    if not key or not secret:
        return _cache.put(
            cache_key,
            {
                "ok": False,
                "error": "Alpaca news credentials are not configured",
                "items": [],
            },
            NEWS_TTL_SECONDS,
        )

    start = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat().replace("+00:00", "Z")
    try:
        response = _session.get(
            f"{ALPACA_DATA_BASE_URL}/v1beta1/news",
            headers={
                "APCA-API-KEY-ID": key,
                "APCA-API-SECRET-KEY": secret,
                "Accept": "application/json",
            },
            params={
                "symbols": symbol,
                "limit": max(1, min(50, int(limit))),
                "sort": "desc",
                "start": start,
                "include_content": "false",
            },
            timeout=(4, 10),
        )
        response.raise_for_status()
        payload = response.json()
        raw_items = payload.get("news") if isinstance(payload, dict) else []
        items: List[Dict[str, Any]] = []
        for raw in raw_items or []:
            if not isinstance(raw, dict):
                continue
            headline = str(raw.get("headline") or "").strip()
            summary = str(raw.get("summary") or "").strip()
            category = _keyword_category(headline, summary)
            items.append(
                {
                    "id": str(raw.get("id") or ""),
                    "headline": headline,
                    "summary": summary,
                    "author": raw.get("author"),
                    "source": raw.get("source") or "Alpaca News",
                    "created_at": raw.get("created_at"),
                    "updated_at": raw.get("updated_at"),
                    "url": raw.get("url"),
                    "symbols": raw.get("symbols") if isinstance(raw.get("symbols"), list) else [symbol],
                    "category": category,
                    "impact": _impact_for_category(category),
                }
            )
        return _cache.put(cache_key, {"ok": True, "error": None, "items": items}, NEWS_TTL_SECONDS)
    except Exception as exc:
        return _cache.put(
            cache_key,
            {"ok": False, "error": f"Alpaca news unavailable: {exc}", "items": []},
            NEWS_TTL_SECONDS,
        )


def _xml_local_name(tag: str) -> str:
    if "}" in tag:
        tag = tag.rsplit("}", 1)[-1]
    if ":" in tag:
        tag = tag.rsplit(":", 1)[-1]
    if tag.startswith("ndaq_"):
        tag = tag[5:]
    return tag


def _parse_nasdaq_halts(xml_text: str) -> List[Dict[str, Any]]:
    # Some Nasdaq RSS responses historically used the ndaq: prefix without
    # declaring the namespace. Sanitizing the prefix keeps ElementTree robust
    # across both forms of the feed.
    sanitized = xml_text.replace("<ndaq:", "<ndaq_").replace("</ndaq:", "</ndaq_")
    root = ET.fromstring(sanitized)
    rows: List[Dict[str, Any]] = []
    for item in root.findall(".//item"):
        values: Dict[str, str] = {}
        for child in list(item):
            values[_xml_local_name(child.tag)] = (child.text or "").strip()
        symbol = (values.get("IssueSymbol") or values.get("title") or "").strip().upper()
        if not symbol:
            continue
        reason_code = values.get("ReasonCode", "")
        rows.append(
            {
                "symbol": symbol,
                "company": values.get("IssueName") or None,
                "market": values.get("Market") or None,
                "halt_date": values.get("HaltDate") or None,
                "halt_time": values.get("HaltTime") or None,
                "reason_code": reason_code or None,
                "reason": HALT_CODE_LABELS.get(reason_code, reason_code or "Trading Halt"),
                "pause_threshold_price": values.get("PauseThresholdPrice") or None,
                "resumption_date": values.get("ResumptionDate") or None,
                "resumption_quote_time": values.get("ResumptionQuoteTime") or None,
                "resumption_trade_time": values.get("ResumptionTradeTime") or None,
            }
        )
    return rows


def _fetch_nasdaq_halts() -> Dict[str, Any]:
    cache_key = "nasdaq:halts"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached
    try:
        response = _session.get(
            NASDAQ_HALTS_URL,
            headers={"Accept": "application/rss+xml, application/xml, text/xml, */*"},
            timeout=(4, 10),
        )
        response.raise_for_status()
        rows = _parse_nasdaq_halts(response.text)
        return _cache.put(cache_key, {"ok": True, "error": None, "items": rows}, HALTS_TTL_SECONDS)
    except Exception as exc:
        return _cache.put(
            cache_key,
            {"ok": False, "error": f"Nasdaq halt feed unavailable: {exc}", "items": []},
            HALTS_TTL_SECONDS,
        )



def _fetch_nasdaq_earnings_today() -> Dict[str, Any]:
    try:
        today_et = datetime.now(ZoneInfo("America/New_York")).date().isoformat()
    except Exception:
        today_et = datetime.now(timezone.utc).date().isoformat()

    cache_key = f"nasdaq:earnings:{today_et}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    try:
        response = _session.get(
            NASDAQ_EARNINGS_URL,
            headers={
                "Accept": "application/json, text/plain, */*",
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36"
                ),
                "Referer": "https://www.nasdaq.com/market-activity/earnings",
                "Accept-Language": "en-US,en;q=0.9",
            },
            params={"date": today_et},
            timeout=(4, 10),
        )
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        rows: List[Dict[str, Any]] = []
        if isinstance(data, dict):
            raw_rows = data.get("rows")
            if not isinstance(raw_rows, list):
                calendar = data.get("calendar")
                raw_rows = calendar.get("rows") if isinstance(calendar, dict) else []
            for raw in raw_rows or []:
                if not isinstance(raw, dict):
                    continue
                symbol = str(raw.get("symbol") or "").strip().upper()
                if not symbol:
                    continue
                rows.append(
                    {
                        "symbol": symbol,
                        "name": raw.get("name"),
                        "date": today_et,
                        "time": raw.get("time"),
                        "eps_forecast": raw.get("epsForecast"),
                        "fiscal_quarter_ending": raw.get("fiscalQuarterEnding"),
                        "estimate_count": raw.get("noOfEsts"),
                        "market_cap": raw.get("marketCap"),
                        "last_year_report_date": raw.get("lastYearRptDt"),
                        "last_year_eps": raw.get("lastYearEPS"),
                    }
                )
        return _cache.put(
            cache_key,
            {"ok": True, "error": None, "date": today_et, "items": rows},
            EARNINGS_TTL_SECONDS,
        )
    except Exception as exc:
        return _cache.put(
            cache_key,
            {
                "ok": False,
                "error": f"Nasdaq earnings calendar unavailable: {exc}",
                "date": today_et,
                "items": [],
            },
            EARNINGS_TTL_SECONDS,
        )

def _sec_user_agent() -> str:
    return os.getenv("SEC_USER_AGENT", "").strip()


def _fetch_sec_ticker_map() -> Dict[str, Dict[str, Any]]:
    cached = _cache.get("sec:ticker-map")
    if cached is not None:
        return cached
    user_agent = _sec_user_agent()
    if not user_agent:
        return {}
    try:
        response = _session.get(
            SEC_TICKERS_URL,
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            timeout=(4, 12),
        )
        response.raise_for_status()
        payload = response.json()
        out: Dict[str, Dict[str, Any]] = {}
        if isinstance(payload, dict):
            for row in payload.values():
                if not isinstance(row, dict):
                    continue
                ticker = str(row.get("ticker") or "").strip().upper()
                cik = row.get("cik_str")
                if ticker and cik is not None:
                    out[ticker] = {
                        "cik": str(int(cik)).zfill(10),
                        "title": row.get("title"),
                    }
        return _cache.put("sec:ticker-map", out, SEC_TICKERS_TTL_SECONDS)
    except Exception:
        return {}


def _sec_filing_category(form: str) -> str:
    if form in OFFERING_FORMS or form.startswith("424B"):
        return "offering"
    if form in EARNINGS_FORMS:
        return "earnings"
    if form == "8-K" or form == "6-K":
        return "material_event"
    if form in {"DEF 14A", "PRE 14A"}:
        return "proxy"
    if form in {"3", "4", "5"}:
        return "insider"
    return "filing"


def _fetch_sec_filings(symbol: str, limit: int = 12) -> Dict[str, Any]:
    cache_key = f"sec:filings:{symbol}:{limit}"
    cached = _cache.get(cache_key)
    if cached is not None:
        return cached

    user_agent = _sec_user_agent()
    if not user_agent:
        return _cache.put(
            cache_key,
            {
                "ok": False,
                "error": "Set SEC_USER_AGENT in the backend .env to enable SEC filings",
                "items": [],
            },
            FILINGS_TTL_SECONDS,
        )

    ticker_map = _fetch_sec_ticker_map()
    company = ticker_map.get(symbol)
    if not company:
        return _cache.put(
            cache_key,
            {"ok": False, "error": f"No SEC CIK mapping found for {symbol}", "items": []},
            FILINGS_TTL_SECONDS,
        )

    cik = company["cik"]
    try:
        response = _session.get(
            f"{SEC_SUBMISSIONS_BASE}/CIK{cik}.json",
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            timeout=(4, 12),
        )
        response.raise_for_status()
        payload = response.json()
        recent = ((payload.get("filings") or {}).get("recent") or {}) if isinstance(payload, dict) else {}
        forms = recent.get("form") or []
        filing_dates = recent.get("filingDate") or []
        report_dates = recent.get("reportDate") or []
        accessions = recent.get("accessionNumber") or []
        primary_docs = recent.get("primaryDocument") or []
        descriptions = recent.get("primaryDocDescription") or []

        items: List[Dict[str, Any]] = []
        count = min(len(forms), len(filing_dates), len(accessions), max(1, int(limit)))
        cik_unpadded = str(int(cik))
        for index in range(count):
            form = str(forms[index] or "")
            accession = str(accessions[index] or "")
            accession_compact = accession.replace("-", "")
            primary_doc = str(primary_docs[index] or "") if index < len(primary_docs) else ""
            filing_url = None
            if accession_compact and primary_doc:
                filing_url = (
                    f"https://www.sec.gov/Archives/edgar/data/{cik_unpadded}/"
                    f"{accession_compact}/{quote(primary_doc)}"
                )
            category = _sec_filing_category(form)
            items.append(
                {
                    "form": form,
                    "filing_date": filing_dates[index] if index < len(filing_dates) else None,
                    "report_date": report_dates[index] if index < len(report_dates) else None,
                    "accession_number": accession,
                    "description": descriptions[index] if index < len(descriptions) else None,
                    "url": filing_url,
                    "category": category,
                    "impact": "critical" if category == "offering" else "high" if category in {"earnings", "material_event"} else "info",
                }
            )
        return _cache.put(
            cache_key,
            {
                "ok": True,
                "error": None,
                "company": payload.get("name") if isinstance(payload, dict) else company.get("title"),
                "cik": cik,
                "items": items,
            },
            FILINGS_TTL_SECONDS,
        )
    except Exception as exc:
        return _cache.put(
            cache_key,
            {"ok": False, "error": f"SEC filings unavailable: {exc}", "items": []},
            FILINGS_TTL_SECONDS,
        )


def get_symbol_intelligence(symbol: str, news_limit: int = 20, filings_limit: int = 12) -> Dict[str, Any]:
    normalized = _normalize_symbol(symbol)
    news = _fetch_alpaca_news(normalized, limit=news_limit)
    halts_feed = _fetch_nasdaq_halts()
    earnings_feed = _fetch_nasdaq_earnings_today()
    filings = _fetch_sec_filings(normalized, limit=filings_limit)

    halts = [
        row for row in halts_feed.get("items", [])
        if str(row.get("symbol") or "").strip().upper() == normalized
    ]
    active_halt = None
    if halts:
        # Current RSS is already limited to current halts. If a resume trade time
        # appears, retain the row for context but do not mark it actively halted.
        unresolved = [row for row in halts if not row.get("resumption_trade_time")]
        active_halt = unresolved[0] if unresolved else None

    earnings_today = next(
        (row for row in earnings_feed.get("items", []) if str(row.get("symbol") or "").upper() == normalized),
        None,
    )
    earnings_news = [item for item in news.get("items", []) if item.get("category") == "earnings"]
    offering_news = [item for item in news.get("items", []) if item.get("category") == "offering"]
    offering_filings = [item for item in filings.get("items", []) if item.get("category") == "offering"]
    earnings_filings = [item for item in filings.get("items", []) if item.get("category") == "earnings"]

    alerts: List[Dict[str, Any]] = []
    if active_halt:
        alerts.append(
            {
                "type": "halt",
                "severity": "critical",
                "title": f"HALTED - {active_halt.get('reason_code') or 'Trading Halt'}",
                "detail": active_halt.get("reason"),
            }
        )
    if offering_news or offering_filings:
        alerts.append(
            {
                "type": "offering",
                "severity": "critical",
                "title": "Offering / dilution signal detected",
                "detail": "Review the latest headline or SEC filing before entering.",
            }
        )
    if earnings_today:
        alerts.append(
            {
                "type": "earnings_today",
                "severity": "high",
                "title": "EARNINGS TODAY",
                "detail": str(earnings_today.get("time") or "Time not supplied"),
            }
        )
    elif earnings_news:
        alerts.append(
            {
                "type": "earnings",
                "severity": "high",
                "title": "Earnings-related news detected",
                "detail": earnings_news[0].get("headline"),
            }
        )

    return {
        "symbol": normalized,
        "as_of": datetime.now(timezone.utc).isoformat(),
        "active_halt": active_halt,
        "halts": halts,
        "alerts": alerts,
        "news": news.get("items", []),
        "filings": filings.get("items", []),
        "earnings": {
            "today": earnings_today,
            "calendar_date": earnings_feed.get("date"),
            "latest_news": earnings_news[0] if earnings_news else None,
            "latest_periodic_filing": earnings_filings[0] if earnings_filings else None,
        },
        "sources": {
            "alpaca_news": {"ok": bool(news.get("ok")), "error": news.get("error")},
            "nasdaq_halts": {"ok": bool(halts_feed.get("ok")), "error": halts_feed.get("error")},
            "nasdaq_earnings": {"ok": bool(earnings_feed.get("ok")), "error": earnings_feed.get("error")},
            "sec_filings": {"ok": bool(filings.get("ok")), "error": filings.get("error")},
        },
        "cache_policy": {
            "news_seconds": int(NEWS_TTL_SECONDS),
            "halts_seconds": int(HALTS_TTL_SECONDS),
            "earnings_seconds": int(EARNINGS_TTL_SECONDS),
            "filings_seconds": int(FILINGS_TTL_SECONDS),
        },
    }
