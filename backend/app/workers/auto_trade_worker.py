from __future__ import annotations

import asyncio
import signal

from dotenv import load_dotenv

from app.autotrade.engine import AutoTradeEngine

load_dotenv(override=True)


async def main() -> None:
    engine = AutoTradeEngine()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, setattr, engine, "stop_requested", True)
        except NotImplementedError:
            pass
    await engine.run_forever()


if __name__ == "__main__":
    asyncio.run(main())
