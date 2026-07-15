import type { OpenOrderState } from "./TradingTypes";

type OpenOrdersWidgetProps = {
  orders: OpenOrderState[];
  onCancelOrder: (orderId: string) => void | Promise<void>;
  onFillOrder?: (orderId: string) => void;
};

function money(value?: number): string {
  if (!Number.isFinite(value ?? NaN)) return "—";

  return Number(value).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function OpenOrdersWidget({
  orders,
  onCancelOrder,
}: OpenOrdersWidgetProps) {
  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Orders</div>
          <div style={styles.title}>Live Open Orders</div>
        </div>

        <div style={styles.countBadge}>{orders.length}</div>
      </div>

      {orders.length === 0 ? (
        <div style={styles.empty}>No live open Alpaca orders for this symbol.</div>
      ) : (
        <div style={styles.list}>
          {orders.map((order) => (
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
                    {order.type.toUpperCase()} · {order.status.toUpperCase()} ·{" "}
                    {order.createdAt}
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
                <Price label="Limit" value={money(order.limitPrice)} />
                <Price label="Stop" value={money(order.stopPrice)} />
                <Price label="Target" value={money(order.targetPrice)} />
              </div>

              <div style={styles.actions}>
                <button type="button" style={styles.modifyButton} disabled>
                  Modify Soon
                </button>

                <button
                  type="button"
                  style={styles.cancelButton}
                  onClick={() => onCancelOrder(order.id)}
                >
                  Cancel Live Order
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={styles.footer}>
        These orders come from Alpaca. The old mock fill button was removed.
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
  empty: {
    border: "1px dashed rgba(148,163,184,.25)",
    borderRadius: 14,
    padding: 14,
    color: "#64748b",
    fontSize: 12,
    textAlign: "center",
  },
  list: {
    display: "grid",
    gap: 10,
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
  priceGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr 1fr",
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
  actions: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginTop: 10,
  },
  modifyButton: {
    border: "1px solid rgba(96,165,250,.2)",
    background: "rgba(37,99,235,.08)",
    color: "#64748b",
    borderRadius: 11,
    padding: "9px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "not-allowed",
  },
  cancelButton: {
    border: "1px solid rgba(248,113,113,.35)",
    background: "rgba(127,29,29,.18)",
    color: "#fecaca",
    borderRadius: 11,
    padding: "9px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
  footer: {
    marginTop: 10,
    color: "#64748b",
    fontSize: 11,
    lineHeight: 1.35,
  },
};