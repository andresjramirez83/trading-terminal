import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

import {
  cancelAlpacaOrder,
  checkAutoTradeOnce,
  fetchAlpacaSnapshot,
  fetchAutoTradeStatus,
  placeAlpacaOrder,
  startAutoTrade,
  stopAutoTrade,
  updateAutoTradeConfig,
  type AlpacaMode,
  type AlpacaOrderType,
  type AlpacaSide,
  type AutoTradeStatus,
} from "../../../../services/api";
import { useActiveSymbol } from "../../ActiveSymbolContext";

type AccountData = Record<string, any> | null;
type PositionData = Record<string, any>;
type OrderData = Record<string, any>;

type OrderFormState = {
  symbol: string;
  side: AlpacaSide;
  type: AlpacaOrderType;
  qty: string;
  limitPrice: string;
  timeInForce: string;
  extendedHours: boolean;
};

const TERMINAL_ORDER_STATUSES = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "rejected",
  "done_for_day",
  "replaced",
]);

function isOpenOrder(order: OrderData): boolean {
  return !TERMINAL_ORDER_STATUSES.has(
    String(order.status ?? "").trim().toLowerCase(),
  );
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "");
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value: unknown): string {
  const num = toNumber(value);
  if (!Number.isFinite(num)) return "N/A";
  return num.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatNumber(value: unknown, decimals = 2): string {
  const num = toNumber(value);
  if (!Number.isFinite(num)) return "N/A";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function formatPercent(value: unknown): string {
  const num = toNumber(value);
  if (!Number.isFinite(num)) return "N/A";
  return `${num >= 0 ? "+" : ""}${num.toFixed(2)}%`;
}

function getOrderPrice(order: OrderData): string {
  if (order.limit_price != null) return formatMoney(order.limit_price);
  if (order.stop_price != null) return formatMoney(order.stop_price);
  if (order.filled_avg_price != null) return formatMoney(order.filled_avg_price);
  return "Market";
}

function positionSide(position: PositionData): "long" | "short" {
  const side = String(position.side ?? "").toLowerCase();
  if (side === "short") return "short";
  return toNumber(position.qty) < 0 ? "short" : "long";
}

const styles: Record<string, CSSProperties> = {
  panel: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: 10,
    color: "#e5e7eb",
    fontFamily:
      "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
  },
  card: {
    border: "1px solid #262b33",
    background: "#0d1117",
    borderRadius: 12,
    overflow: "hidden",
  },
  cardHeader: {
    padding: "9px 10px",
    borderBottom: "1px solid #202630",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  cardTitle: {
    fontSize: 10,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.7,
    color: "#8b949e",
  },
  cardBody: {
    padding: 10,
  },
  grid2: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  row: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    fontSize: 12,
    padding: "5px 0",
    borderBottom: "1px solid rgba(148,163,184,0.08)",
  },
  label: {
    display: "block",
    marginBottom: 5,
    fontSize: 10,
    fontWeight: 900,
    color: "#8b949e",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  input: {
    width: "100%",
    height: 34,
    border: "1px solid #27313d",
    background: "#080b10",
    color: "#f8fafc",
    borderRadius: 8,
    padding: "0 10px",
    fontSize: 12,
    fontWeight: 800,
    outline: "none",
    boxSizing: "border-box",
  },
  select: {
    width: "100%",
    height: 34,
    border: "1px solid #27313d",
    background: "#080b10",
    color: "#f8fafc",
    borderRadius: 8,
    padding: "0 10px",
    fontSize: 12,
    fontWeight: 800,
    outline: "none",
    cursor: "pointer",
  },
  button: {
    height: 32,
    border: "1px solid #30363d",
    background: "#161b22",
    color: "#e5e7eb",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 900,
    cursor: "pointer",
  },
  buyButton: {
    height: 34,
    border: "1px solid rgba(34,197,94,0.45)",
    background: "rgba(22,101,52,0.95)",
    color: "#fff",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 950,
    cursor: "pointer",
  },
  sellButton: {
    height: 34,
    border: "1px solid rgba(248,113,113,0.45)",
    background: "rgba(153,27,27,0.95)",
    color: "#fff",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 950,
    cursor: "pointer",
  },
  miniCard: {
    border: "1px solid rgba(148,163,184,0.16)",
    background: "rgba(8,11,16,0.72)",
    borderRadius: 10,
    padding: 9,
    display: "grid",
    gap: 5,
  },
  muted: {
    fontSize: 12,
    color: "#8b949e",
  },
  error: {
    border: "1px solid rgba(248,113,113,0.35)",
    background: "rgba(127,29,29,0.22)",
    color: "#fecaca",
    borderRadius: 10,
    padding: 9,
    fontSize: 12,
    fontWeight: 800,
  },
  success: {
    border: "1px solid rgba(34,197,94,0.32)",
    background: "rgba(20,83,45,0.20)",
    color: "#bbf7d0",
    borderRadius: 10,
    padding: 9,
    fontSize: 12,
    fontWeight: 800,
  },
};

export default function AlpacaWorkspacePanel() {
  const { activeSymbol, setActiveSymbol } = useActiveSymbol();

  const [mode, setMode] = useState<AlpacaMode>("paper");
  const [account, setAccount] = useState<AccountData>(null);
  const [positions, setPositions] = useState<PositionData[]>([]);
  const [orders, setOrders] = useState<OrderData[]>([]);
  const [autoTradeStatus, setAutoTradeStatus] = useState<AutoTradeStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const [orderForm, setOrderForm] = useState<OrderFormState>(() => ({
    symbol: normalizeSymbol(activeSymbol || "SPY"),
    side: "buy",
    type: "limit",
    qty: "1",
    limitPrice: "",
    timeInForce: "day",
    extendedHours: false,
  }));

  const orderSymbol = normalizeSymbol(orderForm.symbol || activeSymbol || "SPY");
  const orderQty = Math.max(0, toNumber(orderForm.qty));
  const orderLimitPrice = toNumber(orderForm.limitPrice);

  const selectedPosition = useMemo(() => {
    return positions.find((position) => normalizeSymbol(position.symbol) === orderSymbol) ?? null;
  }, [orderSymbol, positions]);

  const loadData = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError("");

    try {
      const [brokerSnapshot, nextAutoTradeStatus] = await Promise.all([
        fetchAlpacaSnapshot(mode, "all", true, forceRefresh),
        fetchAutoTradeStatus().catch(() => null),
      ]);

      setAccount(brokerSnapshot.account as AccountData);
      setPositions(
        Array.isArray(brokerSnapshot.positions)
          ? (brokerSnapshot.positions as PositionData[])
          : [],
      );
      setOrders(
        Array.isArray(brokerSnapshot.orders)
          ? (brokerSnapshot.orders as OrderData[]).filter(isOpenOrder)
          : [],
      );
      setAutoTradeStatus(nextAutoTradeStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load Alpaca data.");
    } finally {
      setLoading(false);
    }
  }, [mode]);

  useEffect(() => {
    const nextSymbol = normalizeSymbol(activeSymbol);
    if (!nextSymbol) return;

    setOrderForm((prev) => ({
      ...prev,
      symbol: nextSymbol,
    }));
  }, [activeSymbol]);

  useEffect(() => {
    void loadData();
    const timer = window.setInterval(() => {
      void loadData();
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [loadData]);

  const updateOrderForm = useCallback((patch: Partial<OrderFormState>) => {
    setMessage("");
    setError("");
    setOrderForm((prev) => ({ ...prev, ...patch }));
  }, []);

  const submitOrder = useCallback(
    async (side: AlpacaSide) => {
      const symbol = normalizeSymbol(orderForm.symbol);

      if (!symbol) {
        setError("Enter a symbol first.");
        return;
      }

      if (orderQty <= 0) {
        setError("Qty must be greater than zero.");
        return;
      }

      if (orderForm.type === "limit" && orderLimitPrice <= 0) {
        setError("Limit orders need a valid limit price.");
        return;
      }

      setBusy(true);
      setError("");
      setMessage("");

      try {
        await placeAlpacaOrder({
          mode,
          symbol,
          side,
          qty: orderQty,
          type: orderForm.type,
          time_in_force: orderForm.timeInForce,
          extended_hours: orderForm.extendedHours,
          ...(orderForm.type === "limit" ? { limit_price: orderLimitPrice } : {}),
        });

        setActiveSymbol(symbol);
        setMessage(`${side.toUpperCase()} order sent for ${symbol}.`);
        await loadData(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Order failed.");
      } finally {
        setBusy(false);
      }
    },
    [loadData, mode, orderForm.extendedHours, orderForm.symbol, orderForm.timeInForce, orderForm.type, orderLimitPrice, orderQty, setActiveSymbol]
  );

  const cancelOrder = useCallback(
    async (orderId: string, symbol?: string) => {
      if (!orderId) return;

      setBusy(true);
      setError("");
      setMessage("");

      try {
        await cancelAlpacaOrder(orderId, mode);
        setMessage(`Canceled ${symbol ? `${symbol} ` : ""}order.`);
        await loadData(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Cancel failed.");
      } finally {
        setBusy(false);
      }
    },
    [loadData, mode]
  );

  const flattenSelectedPosition = useCallback(async () => {
    if (!selectedPosition) {
      setError(`No open ${orderSymbol} position found.`);
      return;
    }

    const qty = Math.abs(toNumber(selectedPosition.qty));
    if (qty <= 0) {
      setError(`No open ${orderSymbol} quantity found.`);
      return;
    }

    const closeSide: AlpacaSide = positionSide(selectedPosition) === "short" ? "buy" : "sell";

    setBusy(true);
    setError("");
    setMessage("");

    try {
      await placeAlpacaOrder({
        mode,
        symbol: orderSymbol,
        side: closeSide,
        qty,
        type: "market",
        time_in_force: "day",
        extended_hours: orderForm.extendedHours,
      });

      setMessage(`Flatten order sent for ${orderSymbol}.`);
      await loadData(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Flatten failed.");
    } finally {
      setBusy(false);
    }
  }, [loadData, mode, orderForm.extendedHours, orderSymbol, selectedPosition]);

  const setAutoTradeEnabled = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      setError("");
      setMessage("");

      try {
        const nextStatus = enabled
          ? await startAutoTrade({ enabled: true, mode })
          : await stopAutoTrade();
        setAutoTradeStatus(nextStatus);
        setMessage(enabled ? "Auto trade started." : "Auto trade stopped.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Auto trade update failed.");
      } finally {
        setBusy(false);
      }
    },
    [mode]
  );

  const setAutoTradeMode = useCallback(
    async (nextMode: AlpacaMode) => {
      setMode(nextMode);
      setBusy(true);
      setError("");
      setMessage("");

      try {
        const nextStatus = await updateAutoTradeConfig({ mode: nextMode });
        setAutoTradeStatus(nextStatus);
        setMessage(`Mode set to ${nextMode.toUpperCase()}.`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Mode update failed.");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const runAutoTradeCheck = useCallback(async () => {
    setBusy(true);
    setError("");
    setMessage("");

    try {
      await checkAutoTradeOnce();
      const nextStatus = await fetchAutoTradeStatus();
      setAutoTradeStatus(nextStatus);
      setMessage("Auto trade check completed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Auto trade check failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  const autoTradeConfig = autoTradeStatus?.config;
  const autoTradeRunning = Boolean(autoTradeStatus?.running);

  return (
    <div style={styles.panel}>
      <div style={{ ...styles.card, borderColor: mode === "live" ? "rgba(248,113,113,0.55)" : "#262b33" }}>
        <div style={styles.cardHeader}>
          <div style={styles.cardTitle}>Alpaca Workspace</div>
          <select
            value={mode}
            onChange={(event) => void setAutoTradeMode(event.target.value as AlpacaMode)}
            style={{ ...styles.select, width: 96, height: 30 }}
            disabled={busy}
          >
            <option value="paper">Paper</option>
            <option value="live">Live</option>
          </select>
        </div>
        <div style={styles.cardBody}>
          <div style={{ fontSize: 18, fontWeight: 950, color: mode === "live" ? "#fecaca" : "#dbeafe" }}>
            {mode.toUpperCase()} Trading
          </div>
          <div style={{ ...styles.muted, marginTop: 4 }}>
            Active symbol: <strong style={{ color: "#f8fafc" }}>{normalizeSymbol(activeSymbol) || orderSymbol}</strong>
          </div>
        </div>
      </div>

      {error ? <div style={styles.error}>{error}</div> : null}
      {message ? <div style={styles.success}>{message}</div> : null}

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={styles.cardTitle}>Account</div>
          <button onClick={() => void loadData(true)} style={{ ...styles.button, width: 74 }} disabled={loading || busy}>
            {loading ? "Loading" : "Refresh"}
          </button>
        </div>
        <div style={styles.cardBody}>
          <div style={styles.row}><span>Status</span><strong>{account?.status ?? "N/A"}</strong></div>
          <div style={styles.row}><span>Equity</span><strong>{formatMoney(account?.equity)}</strong></div>
          <div style={styles.row}><span>Buying Power</span><strong>{formatMoney(account?.buying_power)}</strong></div>
          <div style={styles.row}><span>Cash</span><strong>{formatMoney(account?.cash)}</strong></div>
          <div style={styles.row}><span>Portfolio</span><strong>{formatMoney(account?.portfolio_value)}</strong></div>
          <div style={{ ...styles.row, borderBottom: "none" }}><span>PDT Count</span><strong>{account?.daytrade_count ?? "N/A"}</strong></div>
        </div>
      </section>

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={styles.cardTitle}>Quick Order</div>
          <button
            style={{ ...styles.button, width: 82 }}
            onClick={() => {
              const next = normalizeSymbol(orderForm.symbol);
              if (next) setActiveSymbol(next);
            }}
          >
            Load Chart
          </button>
        </div>
        <div style={{ ...styles.cardBody, display: "grid", gap: 9 }}>
          <div>
            <label style={styles.label}>Symbol</label>
            <input
              value={orderForm.symbol}
              onChange={(event) => updateOrderForm({ symbol: normalizeSymbol(event.target.value) })}
              style={styles.input}
            />
          </div>

          <div style={styles.grid2}>
            <div>
              <label style={styles.label}>Qty</label>
              <input
                type="number"
                min="0"
                step="1"
                value={orderForm.qty}
                onChange={(event) => updateOrderForm({ qty: event.target.value })}
                style={styles.input}
              />
            </div>
            <div>
              <label style={styles.label}>Type</label>
              <select
                value={orderForm.type}
                onChange={(event) => updateOrderForm({ type: event.target.value as AlpacaOrderType })}
                style={styles.select}
              >
                <option value="limit">Limit</option>
                <option value="market">Market</option>
              </select>
            </div>
          </div>

          <div style={styles.grid2}>
            <div>
              <label style={styles.label}>Limit Price</label>
              <input
                type="number"
                min="0"
                step="0.0001"
                value={orderForm.limitPrice}
                onChange={(event) => updateOrderForm({ limitPrice: event.target.value })}
                style={{ ...styles.input, opacity: orderForm.type === "limit" ? 1 : 0.55 }}
                disabled={orderForm.type !== "limit"}
              />
            </div>
            <div>
              <label style={styles.label}>TIF</label>
              <select
                value={orderForm.timeInForce}
                onChange={(event) => updateOrderForm({ timeInForce: event.target.value })}
                style={styles.select}
              >
                <option value="day">day</option>
                <option value="gtc">gtc</option>
                <option value="ioc">ioc</option>
                <option value="fok">fok</option>
                <option value="opg">opg</option>
                <option value="cls">cls</option>
              </select>
            </div>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 800, color: "#cbd5e1" }}>
            <input
              type="checkbox"
              checked={orderForm.extendedHours}
              onChange={(event) => updateOrderForm({ extendedHours: event.target.checked })}
            />
            Extended hours
          </label>

          <div style={styles.grid2}>
            <button onClick={() => void submitOrder("buy")} style={styles.buyButton} disabled={busy}>
              Buy
            </button>
            <button onClick={() => void submitOrder("sell")} style={styles.sellButton} disabled={busy}>
              Sell
            </button>
          </div>

          <button
            onClick={() => void flattenSelectedPosition()}
            style={{ ...styles.sellButton, background: "rgba(127,29,29,0.95)" }}
            disabled={busy || !selectedPosition}
          >
            Flatten {orderSymbol}
          </button>
        </div>
      </section>

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={styles.cardTitle}>Positions</div>
          <span style={styles.muted}>{positions.length}</span>
        </div>
        <div style={{ ...styles.cardBody, display: "grid", gap: 8 }}>
          {positions.length === 0 ? (
            <div style={styles.muted}>No open positions</div>
          ) : (
            positions.map((position) => {
              const pl = toNumber(position.unrealized_pl);
              const plpc = position.unrealized_plpc != null ? toNumber(position.unrealized_plpc) * 100 : null;
              return (
                <button
                  key={`position-${position.asset_id ?? position.symbol}`}
                  onClick={() => {
                    const next = normalizeSymbol(position.symbol);
                    if (!next) return;
                    setActiveSymbol(next);
                    updateOrderForm({ symbol: next });
                  }}
                  style={{ ...styles.miniCard, color: "#e5e7eb", textAlign: "left", cursor: "pointer" }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong>{position.symbol}</strong>
                    <span style={{ color: positionSide(position) === "short" ? "#fca5a5" : "#86efac", fontSize: 12, fontWeight: 900 }}>
                      {positionSide(position)}
                    </span>
                  </div>
                  <div style={styles.muted}>Qty: {formatNumber(position.qty, 4)} · Avg: {formatMoney(position.avg_entry_price)}</div>
                  <div style={styles.muted}>Value: {formatMoney(position.market_value)}</div>
                  <div style={{ fontSize: 12, fontWeight: 900, color: pl >= 0 ? "#86efac" : "#fca5a5" }}>
                    Unrealized: {formatMoney(pl)} {plpc != null ? `(${formatPercent(plpc)})` : ""}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </section>

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={styles.cardTitle}>Open Orders</div>
          <span style={styles.muted}>{orders.length}</span>
        </div>
        <div style={{ ...styles.cardBody, display: "grid", gap: 8 }}>
          {orders.length === 0 ? (
            <div style={styles.muted}>No open orders</div>
          ) : (
            orders.map((order) => (
              <div key={order.id ?? `${order.symbol}-${order.created_at}`} style={styles.miniCard}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <strong>{order.symbol}</strong>
                  <span style={{ color: String(order.side).toLowerCase() === "buy" ? "#86efac" : "#fca5a5", fontSize: 12, fontWeight: 900 }}>
                    {order.side}
                  </span>
                </div>
                <div style={styles.muted}>{order.type} · {order.time_in_force} · {order.status}</div>
                <div style={styles.muted}>Qty: {formatNumber(order.qty, 4)} · Price: {getOrderPrice(order)}</div>
                <button
                  onClick={() => void cancelOrder(String(order.id ?? ""), String(order.symbol ?? ""))}
                  style={{ ...styles.button, marginTop: 4, borderColor: "rgba(248,113,113,0.35)", color: "#fecaca" }}
                  disabled={busy}
                >
                  Cancel
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <div style={styles.cardTitle}>Auto Trade</div>
          <span style={{ fontSize: 11, fontWeight: 950, color: autoTradeRunning ? "#86efac" : "#fca5a5" }}>
            {autoTradeRunning ? "RUNNING" : "OFF"}
          </span>
        </div>
        <div style={{ ...styles.cardBody, display: "grid", gap: 8 }}>
          <div style={styles.row}><span>Mode</span><strong>{autoTradeConfig?.mode ?? mode}</strong></div>
          <div style={styles.row}><span>Source</span><strong>{autoTradeConfig?.source ?? "N/A"}</strong></div>
          <div style={styles.row}><span>Timeframe</span><strong>{autoTradeConfig?.timeframe ?? "N/A"}</strong></div>
          <div style={styles.row}><span>Trade Amount</span><strong>{formatMoney(autoTradeConfig?.trade_amount)}</strong></div>
          <div style={{ ...styles.row, borderBottom: "none" }}><span>Last Error</span><strong>{autoTradeStatus?.last_error ?? "None"}</strong></div>

          <div style={styles.grid2}>
            <button
              onClick={() => void setAutoTradeEnabled(!autoTradeRunning)}
              style={autoTradeRunning ? styles.sellButton : styles.buyButton}
              disabled={busy}
            >
              {autoTradeRunning ? "Stop" : "Start"}
            </button>
            <button onClick={() => void runAutoTradeCheck()} style={styles.button} disabled={busy}>
              Check Once
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
