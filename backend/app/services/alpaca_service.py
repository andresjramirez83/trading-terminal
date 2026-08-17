from __future__ import annotations

import os
import logging
import time
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

logger = logging.getLogger(__name__)
DEBUG_ALPACA = os.getenv("DEBUG_ALPACA", "false").strip().lower() in {"1", "true", "yes", "on"}

def _debug(message: str) -> None:
    if DEBUG_ALPACA:
        logger.info(message)


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

        _debug(f"ALPACA SERVICE INIT mode={self.mode} base_url={self.base_url} key_present={bool(self.key_id)}")

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

    def get_position(self, symbol: str) -> Optional[Dict[str, Any]]:
        safe_symbol = str(symbol or "").strip().upper()
        if not safe_symbol:
            return None
        for position in self.get_positions():
            if str(position.get("symbol") or "").strip().upper() == safe_symbol:
                return position
        return None

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
        position_intent: Optional[str] = None,
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
        if position_intent:
            payload["position_intent"] = position_intent
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

        try:
            return self._request(
                "PATCH",
                f"/v2/orders/{order_id}",
                json=payload,
            )
        except RuntimeError as exc:
            # Alpaca keeps orders submitted outside a trading session in
            # ``accepted`` status and refuses PATCH replacements until they
            # become ``new``.  Waiting is not enough here: on a weekend that
            # state can last until the next session.  For an entirely unfilled
            # accepted order, cancel it and recreate the same broker order with
            # the requested fields.  The returned replacement has a new ID;
            # the frontend already reconciles that ID into its shared snapshot.
            message = str(exc).lower()
            if "cannot replace order in accepted status" not in message:
                raise
            return self._recreate_accepted_order(order_id, payload)

    @staticmethod
    def _positive_number(value: Any) -> Optional[float]:
        try:
            number = float(value)
        except (TypeError, ValueError):
            return None
        return number if number > 0 else None

    def _recreate_accepted_order(
        self,
        order_id: str,
        updates: Dict[str, Any],
    ) -> Dict[str, Any]:
        original = self.get_order(order_id, nested=True)
        status = str(original.get("status") or "").strip().lower()
        filled_qty = self._positive_number(original.get("filled_qty")) or 0.0

        if status != "accepted":
            # The broker state changed between PATCH and GET. Retry once using
            # the same original ID; Alpaca will either replace it or return the
            # current, meaningful error to the caller.
            return self._request("PATCH", f"/v2/orders/{order_id}", json=updates)
        if filled_qty > 0:
            raise RuntimeError(
                "Cannot safely recreate an accepted order that is partially filled"
            )

        qty = self._positive_number(updates.get("qty"))
        if qty is None:
            qty = self._positive_number(original.get("qty"))
        notional = None if qty is not None else self._positive_number(original.get("notional"))

        symbol = str(original.get("symbol") or "").strip().upper()
        side = str(original.get("side") or "").strip().lower()
        order_type = str(original.get("type") or "").strip().lower()
        time_in_force = str(
            updates.get("time_in_force") or original.get("time_in_force") or "day"
        ).strip().lower()
        if not symbol or side not in {"buy", "sell"} or not order_type:
            raise RuntimeError("Accepted order is missing fields required for safe recreation")
        if qty is None and notional is None:
            raise RuntimeError("Accepted order has no quantity or notional to recreate")

        limit_price = self._positive_number(
            updates.get("limit_price", original.get("limit_price"))
        )
        stop_price = self._positive_number(
            updates.get("stop_price", original.get("stop_price"))
        )

        take_profit: Optional[Dict[str, Any]] = None
        stop_loss: Optional[Dict[str, Any]] = None
        for leg in original.get("legs") or []:
            if not isinstance(leg, dict):
                continue
            leg_type = str(leg.get("type") or "").strip().lower()
            leg_limit = self._positive_number(leg.get("limit_price"))
            leg_stop = self._positive_number(leg.get("stop_price"))
            if leg_type == "limit" and leg_limit is not None:
                take_profit = {"limit_price": leg_limit}
            elif leg_type in {"stop", "stop_limit"} and leg_stop is not None:
                stop_loss = {"stop_price": leg_stop}
                if leg_type == "stop_limit" and leg_limit is not None:
                    stop_loss["limit_price"] = leg_limit

        order_class = str(original.get("order_class") or "").strip().lower() or None
        if order_class == "simple":
            order_class = None

        self.cancel_order(order_id)

        # Do not submit a duplicate while Alpaca still considers the original
        # active. Cancellation normally settles immediately, but allow a short
        # broker propagation window.
        canceled = False
        for _ in range(10):
            current = self.get_order(order_id, nested=False)
            current_status = str(current.get("status") or "").strip().lower()
            if current_status in {"canceled", "cancelled", "expired", "rejected"}:
                canceled = True
                break
            if current_status in {"filled", "partially_filled"}:
                raise RuntimeError(
                    "Order filled while its accepted-price update was being applied"
                )
            time.sleep(0.2)
        if not canceled:
            raise RuntimeError("Timed out waiting for accepted order cancellation")

        recreated = self.place_order(
            symbol=symbol,
            side=side,
            order_type=order_type,
            time_in_force=time_in_force,
            qty=qty,
            notional=notional,
            limit_price=limit_price,
            stop_price=stop_price,
            extended_hours=bool(original.get("extended_hours")),
            position_intent=str(original.get("position_intent") or "").strip() or None,
            order_class=order_class,
            take_profit=take_profit,
            stop_loss=stop_loss,
        )
        if isinstance(recreated, dict):
            # Alpaca's recreate response has no `replaces` link because this is
            # cancel + submit. Supply it so all clients can reconcile identity.
            recreated.setdefault("replaces", order_id)
        return recreated

    def cancel_order(self, order_id: str) -> None:
        self._request("DELETE", f"/v2/orders/{order_id}")

    def cancel_all_orders(self) -> Any:
        return self._request("DELETE", "/v2/orders")

    @staticmethod
    def _order_is_active(order: Dict[str, Any]) -> bool:
        status = str(order.get("status") or "").strip().lower()
        return status not in {
            "filled",
            "canceled",
            "cancelled",
            "expired",
            "replaced",
            "rejected",
            "done_for_day",
        }

    def _cancel_symbol_orders(
        self,
        symbol: str,
        *,
        timeout_seconds: float = 4.0,
    ) -> List[str]:
        safe_symbol = str(symbol or "").strip().upper()
        if not safe_symbol:
            return []

        orders = self.get_orders(
            status="open",
            limit=500,
            nested=False,
            symbols=[safe_symbol],
        )
        order_ids = []
        for order in orders:
            if not isinstance(order, dict) or not self._order_is_active(order):
                continue
            order_id = str(order.get("id") or "").strip()
            if order_id and order_id not in order_ids:
                order_ids.append(order_id)

        # Cancel every visible symbol order. For bracket/OCO groups, canceling
        # one leg can automatically cancel its sibling, so later DELETE calls
        # can legitimately fail because the sibling is already gone. The
        # authoritative check is the fresh open-order poll below.
        for order_id in order_ids:
            try:
                self.cancel_order(order_id)
            except RuntimeError:
                pass

        deadline = time.monotonic() + max(0.5, timeout_seconds)
        while time.monotonic() < deadline:
            remaining = self.get_orders(
                status="open",
                limit=500,
                nested=False,
                symbols=[safe_symbol],
            )
            remaining_active = [
                order
                for order in remaining
                if isinstance(order, dict) and self._order_is_active(order)
            ]
            if not remaining_active:
                return order_ids
            time.sleep(0.15)

        raise RuntimeError(
            f"Timed out waiting for open {safe_symbol} orders to cancel before liquidation"
        )

    def _capture_position_protection(
        self,
        symbol: str,
        position: Dict[str, Any],
    ) -> Dict[str, Any]:
        safe_symbol = str(symbol or "").strip().upper()
        qty = float(position.get("qty") or 0)
        avg_entry = self._positive_number(position.get("avg_entry_price")) or 0.0
        closing_side = "sell" if qty > 0 else "buy"

        orders = self.get_orders(
            status="open",
            limit=500,
            nested=False,
            symbols=[safe_symbol],
        )

        stops: List[Dict[str, Any]] = []
        targets: List[Dict[str, Any]] = []
        for order in orders:
            if not isinstance(order, dict) or not self._order_is_active(order):
                continue
            if str(order.get("side") or "").strip().lower() != closing_side:
                continue

            order_type = str(order.get("type") or "").strip().lower()
            stop_price = self._positive_number(order.get("stop_price"))
            limit_price = self._positive_number(order.get("limit_price"))

            valid_stop = (
                stop_price is not None
                and (
                    avg_entry <= 0
                    or (qty > 0 and stop_price <= avg_entry)
                    or (qty < 0 and stop_price >= avg_entry)
                )
            )
            valid_target = (
                limit_price is not None
                and (
                    avg_entry <= 0
                    or (qty > 0 and limit_price >= avg_entry)
                    or (qty < 0 and limit_price <= avg_entry)
                )
            )

            if stop_price is not None or order_type in {"stop", "stop_limit"}:
                if valid_stop:
                    stops.append(order)
                continue

            if order_type == "limit" and valid_target:
                targets.append(order)

        def stop_distance(order: Dict[str, Any]) -> float:
            price = self._positive_number(order.get("stop_price")) or 0.0
            return abs(avg_entry - price) if avg_entry > 0 else price

        def target_distance(order: Dict[str, Any]) -> float:
            price = self._positive_number(order.get("limit_price")) or 0.0
            return abs(avg_entry - price) if avg_entry > 0 else price

        stop_order = min(stops, key=stop_distance) if stops else None
        target_order = min(targets, key=target_distance) if targets else None

        stop_price = (
            self._positive_number(stop_order.get("stop_price"))
            if stop_order
            else None
        )
        stop_limit_price = (
            self._positive_number(stop_order.get("limit_price"))
            if stop_order
            else None
        )
        target_price = (
            self._positive_number(target_order.get("limit_price"))
            if target_order
            else None
        )
        tif = str(
            (target_order or stop_order or {}).get("time_in_force") or "day"
        ).strip().lower()
        if tif not in {"day", "gtc"}:
            tif = "day"

        return {
            "stop_price": stop_price,
            "stop_limit_price": stop_limit_price,
            "target_price": target_price,
            "time_in_force": tif,
        }

    def _wait_for_close_order(
        self,
        close_order: Dict[str, Any],
        *,
        timeout_seconds: float = 6.0,
    ) -> Dict[str, Any]:
        order_id = str(close_order.get("id") or "").strip()
        if not order_id:
            return close_order

        deadline = time.monotonic() + max(0.5, timeout_seconds)
        latest = close_order
        while time.monotonic() < deadline:
            latest = self.get_order(order_id, nested=False)
            status = str(latest.get("status") or "").strip().lower()
            if status in {
                "filled",
                "canceled",
                "cancelled",
                "expired",
                "rejected",
                "done_for_day",
            }:
                return latest
            time.sleep(0.15)

        # Do not leave a slow/pending manual scale-out competing with the OCO
        # protection we are about to restore. Cancel it, then restore against
        # the broker's actual remaining position quantity.
        try:
            self.cancel_order(order_id)
        except RuntimeError:
            pass

        cancel_deadline = time.monotonic() + 3.0
        while time.monotonic() < cancel_deadline:
            latest = self.get_order(order_id, nested=False)
            status = str(latest.get("status") or "").strip().lower()
            if status in {
                "filled",
                "canceled",
                "cancelled",
                "expired",
                "rejected",
                "done_for_day",
            }:
                return latest
            time.sleep(0.15)

        raise RuntimeError(
            "Timed out waiting for a scale-out order to stop before restoring protection"
        )

    def _wait_for_position_reduction(
        self,
        symbol: str,
        original_qty: float,
        *,
        timeout_seconds: float = 3.0,
    ) -> Optional[Dict[str, Any]]:
        original_abs = abs(float(original_qty))
        deadline = time.monotonic() + max(0.5, timeout_seconds)
        latest = self.get_position(symbol)

        while time.monotonic() < deadline:
            latest = self.get_position(symbol)
            if latest is None:
                return None
            current_abs = abs(float(latest.get("qty") or 0))
            if current_abs < max(0.0, original_abs - 1e-9):
                return latest
            time.sleep(0.1)

        return latest

    def _restore_position_protection(
        self,
        symbol: str,
        protection: Dict[str, Any],
    ) -> Optional[Dict[str, Any]]:
        position = self.get_position(symbol)
        if not position:
            return None

        raw_qty = float(position.get("qty") or 0)
        qty = abs(raw_qty)
        if qty <= 0:
            return None

        side = "sell" if raw_qty > 0 else "buy"
        target_price = self._positive_number(protection.get("target_price"))
        stop_price = self._positive_number(protection.get("stop_price"))
        stop_limit_price = self._positive_number(
            protection.get("stop_limit_price")
        )
        tif = str(protection.get("time_in_force") or "day").strip().lower()
        if tif not in {"day", "gtc"}:
            tif = "day"

        if target_price is not None and stop_price is not None:
            stop_loss: Dict[str, Any] = {"stop_price": stop_price}
            if stop_limit_price is not None:
                stop_loss["limit_price"] = stop_limit_price
            return self.place_order(
                symbol=symbol,
                side=side,
                order_type="limit",
                time_in_force=tif,
                qty=qty,
                extended_hours=False,
                order_class="oco",
                take_profit={"limit_price": target_price},
                stop_loss=stop_loss,
            )

        if stop_price is not None:
            return self.place_order(
                symbol=symbol,
                side=side,
                order_type="stop_limit" if stop_limit_price is not None else "stop",
                time_in_force=tif,
                qty=qty,
                stop_price=stop_price,
                limit_price=stop_limit_price,
                extended_hours=False,
            )

        if target_price is not None:
            return self.place_order(
                symbol=symbol,
                side=side,
                order_type="limit",
                time_in_force=tif,
                qty=qty,
                limit_price=target_price,
                extended_hours=False,
            )

        return None

    def close_position(
        self,
        symbol: str,
        *,
        qty: Optional[float] = None,
        percentage: Optional[float] = None,
        cancel_orders: bool = True,
        preserve_protection: bool = False,
    ) -> Dict[str, Any]:
        safe_symbol = str(symbol or "").strip().upper()
        if not safe_symbol:
            raise RuntimeError("symbol is required")
        if qty is not None and percentage is not None:
            raise RuntimeError("qty and percentage are mutually exclusive")

        position = self.get_position(safe_symbol)
        if not position:
            raise RuntimeError(f"No open position found for {safe_symbol}")

        is_partial = qty is not None or (
            percentage is not None and float(percentage) < 100.0
        )
        protection = (
            self._capture_position_protection(safe_symbol, position)
            if preserve_protection and is_partial
            else {}
        )

        if cancel_orders:
            self._cancel_symbol_orders(safe_symbol)

        params: Dict[str, Any] = {}
        if qty is not None:
            params["qty"] = qty
        if percentage is not None:
            params["percentage"] = percentage

        close_order = self._request(
            "DELETE",
            f"/v2/positions/{safe_symbol}",
            params=params or None,
        )
        if not isinstance(close_order, dict):
            close_order = {"result": close_order}

        restored_order: Optional[Dict[str, Any]] = None
        if protection and any(
            protection.get(key) is not None
            for key in ("target_price", "stop_price")
        ):
            terminal_close = self._wait_for_close_order(close_order)
            close_status = str(terminal_close.get("status") or "").strip().lower()
            if close_status == "filled":
                self._wait_for_position_reduction(
                    safe_symbol,
                    float(position.get("qty") or 0),
                )
            restored_order = self._restore_position_protection(
                safe_symbol,
                protection,
            )
            close_order = terminal_close or close_order

            if close_status in {
                "rejected",
                "canceled",
                "cancelled",
                "expired",
                "done_for_day",
            }:
                raise RuntimeError(
                    f"Scale-out order for {safe_symbol} did not complete; position protection was restored"
                )

        return {
            "order": close_order,
            "protection_order": restored_order,
            "protection_restored": restored_order is not None,
        }

    def close_all_positions(self, *, cancel_orders: bool = True) -> Any:
        return self._request(
            "DELETE",
            "/v2/positions",
            params={"cancel_orders": str(bool(cancel_orders)).lower()},
        )
