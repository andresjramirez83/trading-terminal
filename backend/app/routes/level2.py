from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

from app.services.moomoo_level2_service import moomoo_level2_service

router = APIRouter(prefix="/level2", tags=["level2"])


@router.get("/status")
def level2_status():
    return moomoo_level2_service.status()


@router.get("/book")
async def level2_book(symbol: str = Query(..., min_length=1)):
    normalized = ""
    try:
        normalized = await asyncio.to_thread(moomoo_level2_service.add_consumer, symbol)
        deadline = time.monotonic() + 2.0
        snapshot = moomoo_level2_service.get_snapshot(normalized)
        while snapshot is None and time.monotonic() < deadline:
            await asyncio.sleep(0.05)
            snapshot = moomoo_level2_service.get_snapshot(normalized)
        if snapshot is None:
            raise HTTPException(status_code=504, detail="No Level 2 snapshot received from Moomoo OpenD.")
        return snapshot
    except HTTPException:
        raise
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    finally:
        if normalized:
            await asyncio.to_thread(moomoo_level2_service.remove_consumer, normalized)


@router.websocket("/ws")
async def level2_websocket(websocket: WebSocket, symbol: str = Query(..., min_length=1)):
    await websocket.accept()
    normalized = ""
    try:
        normalized = await asyncio.to_thread(moomoo_level2_service.add_consumer, symbol)
        await websocket.send_json(
            {
                "type": "level2_status",
                "symbol": normalized,
                "status": "connected",
                "provider": "moomoo",
                "depth": moomoo_level2_service.depth,
            }
        )

        last_version = -1
        last_heartbeat = 0.0
        # Cap browser updates at 5 Hz. OpenD can push faster internally, while the
        # frontend receives only the newest snapshot so React never becomes the
        # Level 2 hot path.
        while True:
            version = moomoo_level2_service.get_version(normalized)
            now = time.monotonic()
            if version != last_version:
                snapshot = moomoo_level2_service.get_snapshot(normalized)
                if snapshot is not None:
                    await websocket.send_json(snapshot)
                    last_version = version
                    last_heartbeat = now
            elif now - last_heartbeat >= 5.0:
                await websocket.send_json(
                    {
                        "type": "level2_heartbeat",
                        "symbol": normalized,
                        "status": "connected",
                        "ts": time.time(),
                    }
                )
                last_heartbeat = now

            await asyncio.sleep(0.20)
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        try:
            await websocket.send_json(
                {
                    "type": "level2_error",
                    "symbol": symbol.strip().upper(),
                    "error": str(exc),
                }
            )
        except Exception:
            pass
        try:
            await websocket.close(code=1011)
        except Exception:
            pass
    finally:
        if normalized:
            await asyncio.to_thread(moomoo_level2_service.remove_consumer, normalized)
