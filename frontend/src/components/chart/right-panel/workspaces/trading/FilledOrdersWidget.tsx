import type { FilledOrderState, TradeSide } from "./TradingTypes";

type FilledOrdersWidgetProps = {
  orders: FilledOrderState[];
};

type OpenLot = {
  id: string;
  side: TradeSide;
  shares: number;
  price: number;
  timestamp: number;
};

type RealizedTrade = {
  id: string;
  symbol: string;
  direction: "long" | "short";
  shares: number;
  entryPrice: number;
  exitPrice: number;
  entryTimestamp: number;
  exitTimestamp: number;
  pnl: number;
  pnlPct: number;
};

const EPSILON = 0.000001;

function money(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return "—";

  return Number(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function signedMoney(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return "—";
  const amount = Number(value);
  if (Math.abs(amount) < 0.005) return "$0.00";
  return `${amount > 0 ? "+" : ""}${money(amount)}`;
}

function price(value?: number): string {
  if (!Number.isFinite(value ?? NaN) || Number(value) <= 0) return "—";
  const amount = Number(value);

  return amount < 1
    ? `$${amount.toFixed(4)}`
    : `$${amount.toFixed(2)}`;
}

function signedPercent(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return "—";
  const amount = Number(value);
  if (Math.abs(amount) < 0.005) return "0.00%";
  return `${amount > 0 ? "+" : ""}${amount.toFixed(2)}%`;
}

function getFillTimestamp(order: FilledOrderState): number {
  const raw = order.raw as Record<string, unknown> | undefined;
  const candidates = [
    raw?.filled_at,
    raw?.updated_at,
    raw?.submitted_at,
    order.filledAt,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(String(candidate));
    if (Number.isFinite(parsed)) return parsed;
  }

  return 0;
}

function formatTradeTime(timestamp: number): string {
  if (!timestamp) return "—";

  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function marketDateKey(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp));

  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function buildRealizedTrades(orders: FilledOrderState[]): RealizedTrade[] {
  const uniqueOrders = Array.from(
    new Map(
      orders.map((order) => [String(order.orderId || order.id), order]),
    ).values(),
  );

  const fills = uniqueOrders
    .filter(
      (order) =>
        order.symbol.trim().length > 0 &&
        order.shares > 0 &&
        order.averageFillPrice > 0,
    )
    .sort((a, b) => getFillTimestamp(a) - getFillTimestamp(b));

  const openLotsBySymbol = new Map<string, OpenLot[]>();
  const realized: RealizedTrade[] = [];

  for (const fill of fills) {
    const symbol = fill.symbol.trim().toUpperCase();
    const timestamp = getFillTimestamp(fill);
    const priceValue = Number(fill.averageFillPrice);
    let remaining = Number(fill.shares);

    if (!symbol || remaining <= 0 || priceValue <= 0) continue;

    const lots = openLotsBySymbol.get(symbol) ?? [];
    const matches: Array<{ lot: OpenLot; shares: number }> = [];

    while (
      remaining > EPSILON &&
      lots.length > 0 &&
      lots[0].side !== fill.side
    ) {
      const lot = lots[0];
      const matchedShares = Math.min(remaining, lot.shares);

      matches.push({ lot: { ...lot }, shares: matchedShares });

      lot.shares -= matchedShares;
      remaining -= matchedShares;

      if (lot.shares <= EPSILON) {
        lots.shift();
      }
    }

    if (matches.length > 0) {
      const closedShares = matches.reduce(
        (sum, match) => sum + match.shares,
        0,
      );
      const entryNotional = matches.reduce(
        (sum, match) => sum + match.shares * match.lot.price,
        0,
      );
      const entryPrice =
        closedShares > 0 ? entryNotional / closedShares : 0;
      const direction = matches[0].lot.side === "buy" ? "long" : "short";
      const pnl = matches.reduce((sum, match) => {
        const perShare =
          match.lot.side === "buy"
            ? priceValue - match.lot.price
            : match.lot.price - priceValue;
        return sum + perShare * match.shares;
      }, 0);
      const pnlPct = entryNotional > 0 ? (pnl / entryNotional) * 100 : 0;
      const entryTimestamp = Math.min(
        ...matches.map((match) => match.lot.timestamp || timestamp),
      );

      realized.push({
        id: `${symbol}:${fill.orderId || fill.id}:${realized.length}`,
        symbol,
        direction,
        shares: closedShares,
        entryPrice,
        exitPrice: priceValue,
        entryTimestamp,
        exitTimestamp: timestamp,
        pnl,
        pnlPct,
      });
    }

    // If this fill was larger than the position it closed, the excess starts
    // a new position in the opposite direction (long-to-short or short-to-long).
    if (remaining > EPSILON) {
      lots.push({
        id: String(fill.orderId || fill.id),
        side: fill.side,
        shares: remaining,
        price: priceValue,
        timestamp,
      });
    }

    openLotsBySymbol.set(symbol, lots);
  }

  return realized.sort((a, b) => b.exitTimestamp - a.exitTimestamp);
}

export default function FilledOrdersWidget({ orders }: FilledOrdersWidgetProps) {
  const realizedTrades = buildRealizedTrades(orders);
  const todayKey = marketDateKey(Date.now());
  const todayTrades = realizedTrades.filter(
    (trade) => marketDateKey(trade.exitTimestamp) === todayKey,
  );
  const todayPnl = todayTrades.reduce((sum, trade) => sum + trade.pnl, 0);
  const todayWins = todayTrades.filter((trade) => trade.pnl > 0).length;
  const todayLosses = todayTrades.filter((trade) => trade.pnl < 0).length;

  const todayBySymbol = Array.from(
    todayTrades.reduce((map, trade) => {
      map.set(trade.symbol, (map.get(trade.symbol) ?? 0) + trade.pnl);
      return map;
    }, new Map<string, number>()),
  ).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

  const todayPositive = todayPnl > 0.005;
  const todayNegative = todayPnl < -0.005;

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>History</div>
          <div style={styles.title}>Trade Results</div>
        </div>

        <div style={styles.countBadge}>{orders.length} fills</div>
      </div>

      <div style={styles.todayCard}>
        <div>
          <div style={styles.todayLabel}>Today Realized P/L</div>
          <div
            style={{
              ...styles.todayValue,
              color: todayPositive
                ? "#86efac"
                : todayNegative
                  ? "#fca5a5"
                  : "#e5e7eb",
            }}
          >
            {signedMoney(todayPnl)}
          </div>
        </div>

        <div style={styles.todayStats}>
          <span>{todayTrades.length} realized</span>
          <span>{todayWins}W / {todayLosses}L</span>
        </div>
      </div>

      {todayBySymbol.length > 0 && (
        <div style={styles.symbolSummary}>
          {todayBySymbol.slice(0, 8).map(([symbol, pnl]) => (
            <div key={symbol} style={styles.symbolChip}>
              <span>{symbol}</span>
              <strong
                style={{
                  color:
                    pnl > 0.005
                      ? "#86efac"
                      : pnl < -0.005
                        ? "#fca5a5"
                        : "#e5e7eb",
                }}
              >
                {signedMoney(pnl)}
              </strong>
            </div>
          ))}
        </div>
      )}

      <div style={styles.sectionHeader}>
        <span>Realized Trades</span>
        <span>{realizedTrades.length}</span>
      </div>

      {realizedTrades.length === 0 ? (
        <div style={styles.empty}>
          No completed buy/sell pairs yet. P/L appears after shares are closed.
        </div>
      ) : (
        <div style={styles.realizedList}>
          {realizedTrades.slice(0, 20).map((trade) => {
            const positive = trade.pnl > 0.005;
            const negative = trade.pnl < -0.005;

            return (
              <div key={trade.id} style={styles.realizedCard}>
                <div style={styles.orderHeader}>
                  <div>
                    <div style={styles.orderTitle}>
                      <span
                        style={{
                          ...styles.sideDot,
                          background: positive
                            ? "#22c55e"
                            : negative
                              ? "#ef4444"
                              : "#94a3b8",
                        }}
                      />
                      {trade.direction.toUpperCase()} {trade.shares} {trade.symbol}
                    </div>

                    <div style={styles.orderSub}>
                      REALIZED · {formatTradeTime(trade.exitTimestamp)}
                    </div>
                  </div>

                  <div
                    style={{
                      ...styles.pnlBadge,
                      color: positive
                        ? "#86efac"
                        : negative
                          ? "#fecaca"
                          : "#cbd5e1",
                      borderColor: positive
                        ? "rgba(34,197,94,.4)"
                        : negative
                          ? "rgba(239,68,68,.4)"
                          : "rgba(148,163,184,.3)",
                      background: positive
                        ? "rgba(34,197,94,.1)"
                        : negative
                          ? "rgba(239,68,68,.1)"
                          : "rgba(148,163,184,.08)",
                    }}
                  >
                    {signedMoney(trade.pnl)}
                  </div>
                </div>

                <div style={styles.priceGrid}>
                  <Price label="Entry" value={price(trade.entryPrice)} />
                  <Price label="Exit" value={price(trade.exitPrice)} />
                  <Price label="Realized P/L" value={signedMoney(trade.pnl)} />
                  <Price label="Return" value={signedPercent(trade.pnlPct)} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={styles.sectionHeader}>
        <span>Order Fills</span>
        <span>{orders.length}</span>
      </div>

      {orders.length === 0 ? (
        <div style={styles.empty}>No filled Alpaca orders yet.</div>
      ) : (
        <div style={styles.list}>
          {orders.slice(0, 30).map((order) => (
            <div key={order.id} style={styles.orderCard}>
              <div style={styles.orderHeader}>
                <div>
                  <div style={styles.orderTitle}>
                    <span
                      style={{
                        ...styles.sideDot,
                        background:
                          order.side === "buy" ? "#22c55e" : "#ef4444",
                      }}
                    />
                    {order.side.toUpperCase()} {order.shares} {order.symbol}
                  </div>

                  <div style={styles.orderSub}>
                    FILLED · {order.type.toUpperCase()} · {order.filledAt}
                  </div>
                </div>

                <div
                  style={{
                    ...styles.sideBadge,
                    color: order.side === "buy" ? "#86efac" : "#fecaca",
                    borderColor:
                      order.side === "buy"
                        ? "rgba(34,197,94,.4)"
                        : "rgba(239,68,68,.4)",
                    background:
                      order.side === "buy"
                        ? "rgba(34,197,94,.1)"
                        : "rgba(239,68,68,.1)",
                  }}
                >
                  {order.side}
                </div>
              </div>

              <div style={styles.priceGrid}>
                <Price label="Avg Fill" value={price(order.averageFillPrice)} />
                <Price label="Limit" value={price(order.limitPrice)} />
                <Price label="Stop" value={price(order.stopPrice)} />
                <Price label="Target" value={price(order.targetPrice)} />
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={styles.footer}>
        Realized P/L is matched FIFO from Alpaca fills. Bracket target/stop legs
        are included when Alpaca reports them as filled. Open shares are not
        counted as realized profit or loss.
      </div>
    </section>
  );
}

function Price({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.priceBox}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: 18,
    background:
      "linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.96))",
    padding: 14,
    boxShadow: "0 20px 50px rgba(0,0,0,.22)",
  },
  top: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },
  kicker: {
    fontSize: 10,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.9,
  },
  title: {
    fontSize: 16,
    fontWeight: 900,
  },
  countBadge: {
    border: "1px solid rgba(96,165,250,.4)",
    background: "rgba(37,99,235,.15)",
    color: "#bfdbfe",
    borderRadius: 999,
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 900,
    height: "fit-content",
  },
  todayCard: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    border: "1px solid rgba(96,165,250,.28)",
    background: "rgba(30,64,175,.10)",
    borderRadius: 14,
    padding: "10px 11px",
    marginBottom: 8,
  },
  todayLabel: {
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  todayValue: {
    marginTop: 2,
    fontSize: 21,
    fontWeight: 950,
  },
  todayStats: {
    display: "grid",
    gap: 3,
    textAlign: "right",
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 800,
  },
  symbolSummary: {
    display: "flex",
    flexWrap: "wrap",
    gap: 6,
    marginBottom: 10,
  },
  symbolChip: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(15,23,42,.72)",
    borderRadius: 999,
    padding: "5px 8px",
    color: "#cbd5e1",
    fontSize: 10,
    fontWeight: 850,
  },
  sectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    margin: "11px 2px 7px",
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  empty: {
    border: "1px dashed rgba(148,163,184,.25)",
    borderRadius: 14,
    padding: 14,
    color: "#64748b",
    fontSize: 12,
    textAlign: "center",
  },
  realizedList: {
    display: "grid",
    gap: 9,
    maxHeight: 360,
    overflowY: "auto",
    paddingRight: 2,
  },
  list: {
    display: "grid",
    gap: 10,
    maxHeight: 420,
    overflowY: "auto",
    paddingRight: 2,
  },
  realizedCard: {
    border: "1px solid rgba(96,165,250,.2)",
    background: "rgba(2,6,23,.72)",
    borderRadius: 14,
    padding: 10,
  },
  orderCard: {
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.55)",
    borderRadius: 14,
    padding: 10,
  },
  orderHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 10,
  },
  orderTitle: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    fontSize: 13,
    fontWeight: 900,
    color: "#e5e7eb",
  },
  sideDot: {
    width: 8,
    height: 8,
    borderRadius: 999,
    flexShrink: 0,
  },
  orderSub: {
    marginTop: 3,
    color: "#64748b",
    fontSize: 10,
    fontWeight: 700,
  },
  sideBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "4px 8px",
    height: "fit-content",
    fontSize: 10,
    fontWeight: 900,
    textTransform: "uppercase",
  },
  pnlBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    height: "fit-content",
    fontSize: 11,
    fontWeight: 950,
    whiteSpace: "nowrap",
  },
  priceGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 7,
  },
  priceBox: {
    display: "grid",
    gap: 3,
    border: "1px solid rgba(148,163,184,.14)",
    background: "rgba(15,23,42,.75)",
    borderRadius: 10,
    padding: "7px 8px",
    color: "#94a3b8",
    fontSize: 10,
  },
  footer: {
    marginTop: 10,
    color: "#64748b",
    fontSize: 11,
    lineHeight: 1.35,
  },
};
