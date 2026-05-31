# Final correctness fix

This patch fixes the remaining issues observed after deployment:

1. Synthetic exits now reconcile against the live Alpaca position before placing a sell order.
2. Exit orders include `position_intent="sell_to_close"` to prevent Alpaca from interpreting them as shorts.
3. If Alpaca still rejects with "account is not allowed to short", the runner state is reconciled or cleared instead of spamming errors forever.
4. Remaining `[bars] filled AH tail ...` journald spam is removed from `main.py`.

Files changed:
- backend/app/autotrade/engine.py
- backend/app/services/alpaca_service.py
- backend/app/main.py
