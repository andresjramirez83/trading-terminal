from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv

# Force-load backend/.env using an absolute path
# backend/app/services/alpaca_service.py -> backend/.env
ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(dotenv_path=ENV_PATH, override=True)

AlpacaMode = Literal["paper", "live"]

_SHARED_SESSIONS: Dict[str, requests.Session] = {}


def get_shared_session(mode: AlpacaMode) -> requests.Session:
    session = _SHARED_SESSIONS.get(mode)
    if session is not None:
        return session

    retry = Retry(
        total=2,
        connect=2,
        read=2,
        status=2,
        backoff_factor=0.35,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset(["GET", "POST", "PATCH", "DELETE"]),
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry, pool_connections=10, pool_maxsize=20)
    session = requests.Session()
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    _SHARED_SESSIONS[mode] = session
    return session


class AlpacaService:
    def __init__(self, mode: AlpacaMode = "paper") -> None:
        self.mode = mode
        self.base_url = self._resolve_base_url(mode)
        self.key_id, self.secret_key = self._resolve_credentials(mode)
        self.session = get_shared_session(mode)

        # Keep startup logs light. Printing secrets/lengths on every request slows the terminal
        # and can leak sensitive info in screenshots.
        print(f"ALPACA SERVICE INIT mode={self.mode} base_url={self.base_url} key_present={bool(self.key_id)}", flush=True)

        if not self.key_id or not self.secret_key:
            raise RuntimeError(
                f"Missing Alpaca credentials for mode '{mode}'. "
                "Set APCA_API_KEY_ID_LIVE / APCA_API_SECRET_KEY_LIVE for live and "
                "APCA_API_KEY_ID_PAPER / APCA_API_SECRET_KEY_PAPER for paper."
            )

    def _resolve_base_url(self, mode: AlpacaMode) -> str:
        if mode == "live":
            return os.getenv("ALPACA_LIVE_BASE_URL", "https://api.alpaca.markets").rstrip("/")
        return os.getenv("ALPACA_PAPER_BASE_URL", "https://paper-api.alpaca.markets").rstrip("/")

    def _resolve_credentials(self, mode: AlpacaMode) -> tuple[str, str]:
        if mode == "live":
            key = os.getenv("APCA_API_KEY_ID_LIVE", "").strip()
            secret = os.getenv("APCA_API_SECRET_KEY_LIVE", "").strip()
            return key, secret

        key = os.getenv("APCA_API_KEY_ID_PAPER", "").strip()
        secret = os.getenv("APCA_API_SECRET_KEY_PAPER", "").strip()
        return key, secret

    @property
    def headers(self) -> Dict[str, str]:
        return {
            "APCA-API-KEY-ID": self.key_id,
            "APCA-API-SECRET-KEY": self.secret_key,
            "Content-Type": "application/json",
        }

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json: Optional[Dict[str, Any]] = None,
    ) -> Any:
        try:
            response = self.session.request(
                method=method,
                url=f"{self.base_url}{path}",
                headers={**self.headers, "Connection": "keep-alive"},
                params=params,
                json=json,
                timeout=(8, 20),
            )
        except (requests.ConnectionError, requests.Timeout) as exc:
            # Reset the shared session once if Windows/Alpaca forcibly closes the socket.
            _SHARED_SESSIONS.pop(self.mode, None)
            self.session = get_shared_session(self.mode)
            try:
                response = self.session.request(
                    method=method,
                    url=f"{self.base_url}{path}",
                    headers={**self.headers, "Connection": "keep-alive"},
                    params=params,
                    json=json,
                    timeout=(8, 20),
                )
            except (requests.ConnectionError, requests.Timeout) as retry_exc:
                raise RuntimeError(f"Alpaca connection failed after retry: {retry_exc}") from retry_exc

        if response.status_code >= 400:
            try:
                detail = response.json()
            except Exception:
                detail = response.text
            raise RuntimeError(f"Alpaca API error ({response.status_code}): {detail}")

        if not response.text:
            return None
        return response.json()

    def get_account(self) -> Dict[str, Any]:
        return self._request("GET", "/v2/account")

    def get_positions(self) -> List[Dict[str, Any]]:
        data = self._request("GET", "/v2/positions")
        return data if isinstance(data, list) else []

    def get_orders(
        self,
        *,
        status: str = "open",
        limit: int = 50,
        nested: bool = False,
        symbols: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        params: Dict[str, Any] = {
            "status": status,
            "limit": max(1, min(limit, 500)),
            "direction": "desc",
            "nested": str(bool(nested)).lower(),
        }
        if symbols:
            params["symbols"] = ",".join(s.upper().strip() for s in symbols if s.strip())

        data = self._request("GET", "/v2/orders", params=params)
        return data if isinstance(data, list) else []

    def get_order(self, order_id: str, *, nested: bool = False) -> Dict[str, Any]:
        params = {"nested": str(bool(nested)).lower()}
        data = self._request("GET", f"/v2/orders/{order_id}", params=params)
        return data if isinstance(data, dict) else {}

    def place_order(
        self,
        *,
        symbol: str,
        side: str,
        order_type: str,
        time_in_force: str,
        qty: Optional[float] = None,
        notional: Optional[float] = None,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extended_hours: bool = False,
        client_order_id: Optional[str] = None,
        order_class: Optional[str] = None,   # "bracket", "oco", "oto"
        take_profit: Optional[Dict[str, Any]] = None,
        stop_loss: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {
            "symbol": symbol.upper().strip(),
            "side": side,
            "type": order_type,
            "time_in_force": time_in_force,
            "extended_hours": bool(extended_hours),
        }

        if qty is not None:
            payload["qty"] = qty
        if notional is not None:
            payload["notional"] = notional
        if limit_price is not None and order_type in {"limit", "stop_limit"}:
            payload["limit_price"] = limit_price
        if stop_price is not None and order_type in {"stop", "stop_limit"}:
            payload["stop_price"] = stop_price
        if client_order_id:
            payload["client_order_id"] = client_order_id

        if order_class:
            payload["order_class"] = order_class

        if take_profit:
            clean_tp = {
                k: v for k, v in take_profit.items()
                if v is not None
            }
            if clean_tp:
                payload["take_profit"] = clean_tp

        if stop_loss:
            clean_sl = {
                k: v for k, v in stop_loss.items()
                if v is not None
            }
            if clean_sl:
                payload["stop_loss"] = clean_sl

        return self._request("POST", "/v2/orders", json=payload)

    def update_order(
        self,
        order_id: str,
        *,
        qty: Optional[float] = None,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        trail: Optional[float] = None,
        time_in_force: Optional[str] = None,
        client_order_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        payload: Dict[str, Any] = {}

        if qty is not None:
            payload["qty"] = qty
        if limit_price is not None:
            payload["limit_price"] = limit_price
        if stop_price is not None:
            payload["stop_price"] = stop_price
        if trail is not None:
            payload["trail"] = trail
        if time_in_force is not None:
            payload["time_in_force"] = time_in_force
        if client_order_id is not None:
            payload["client_order_id"] = client_order_id

        if not payload:
            raise RuntimeError("No order update fields were provided")

        return self._request(
            "PATCH",
            f"/v2/orders/{order_id}",
            json=payload,
        )

    def cancel_order(self, order_id: str) -> None:
        self._request("DELETE", f"/v2/orders/{order_id}")

    def cancel_all_orders(self) -> Any:
        return self._request("DELETE", "/v2/orders")