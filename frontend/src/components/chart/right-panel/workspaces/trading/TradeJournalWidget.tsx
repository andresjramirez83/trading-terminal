import type { JournalTradeState } from "./TradingTypes";

type TradeJournalWidgetProps = {
  trades: JournalTradeState[];
};

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function TradeJournalWidget({ trades }: TradeJournalWidgetProps) {
  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Journal</div>
          <div style={styles.title}>Filled Trades</div>
        </div>

        <div style={styles.countBadge}>{trades.length}</div>
      </div>

      <div style={styles.notice}>
        Only filled trades should be logged here. Open orders stay in Open Orders.
      </div>

      {trades.length === 0 ? (
        <div style={styles.empty}>No filled trades logged yet.</div>
      ) : (
        <div style={styles.list}>
          {trades.map((trade) => {
            const positive = trade.netPnl >= 0;

            return (
              <div key={trade.id} style={styles.tradeCard}>
                <div style={styles.tradeHeader}>
                  <div>
                    <div style={styles.tradeTitle}>
                      {trade.symbol} · {trade.strategy}
                    </div>

                    <div style={styles.tradeSub}>
                      {trade.date} · {trade.time} · {trade.holdTime}
                    </div>
                  </div>

                  <div
                    style={{
                      ...styles.pnlBadge,
                      color: positive ? "#22c55e" : "#ef4444",
                      borderColor: positive
                        ? "rgba(34,197,94,.4)"
                        : "rgba(239,68,68,.4)",
                      background: positive
                        ? "rgba(34,197,94,.1)"
                        : "rgba(239,68,68,.1)",
                    }}
                  >
                    {positive ? "+" : ""}
                    {money(trade.netPnl)}
                  </div>
                </div>

                <div style={styles.metaGrid}>
                  <Meta label="Side" value={trade.side.toUpperCase()} />
                  <Meta label="Shares" value={String(trade.shares)} />
                  <Meta label="Entry" value={money(trade.entry)} />
                  <Meta label="Exit" value={money(trade.exit)} />
                  <Meta label="Target" value={money(trade.target)} />
                  <Meta label="Stop" value={money(trade.stop)} />
                  <Meta label="Reason" value={trade.exitReason} />
                  <Meta label="R" value={`${trade.rMultiple.toFixed(2)}R`} />
                </div>

                <div style={styles.notes}>{trade.notes}</div>

                <button type="button" style={styles.replayButton}>
                  Replay Trade
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.meta}>
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
  notice: {
    border: "1px solid rgba(96,165,250,.18)",
    background: "rgba(37,99,235,.08)",
    color: "#93c5fd",
    borderRadius: 12,
    padding: "8px 10px",
    fontSize: 11,
    lineHeight: 1.35,
    marginBottom: 10,
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
  tradeCard: {
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.55)",
    borderRadius: 14,
    padding: 10,
  },
  tradeHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 10,
  },
  tradeTitle: {
    fontSize: 13,
    fontWeight: 900,
    color: "#e5e7eb",
  },
  tradeSub: {
    marginTop: 3,
    color: "#64748b",
    fontSize: 10,
    fontWeight: 700,
  },
  pnlBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    fontSize: 11,
    fontWeight: 900,
    height: "fit-content",
    whiteSpace: "nowrap",
  },
  metaGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 7,
  },
  meta: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    border: "1px solid rgba(148,163,184,.14)",
    background: "rgba(15,23,42,.75)",
    borderRadius: 10,
    padding: "7px 8px",
    color: "#94a3b8",
    fontSize: 10,
  },
  notes: {
    marginTop: 9,
    color: "#cbd5e1",
    fontSize: 11,
    lineHeight: 1.35,
  },
  replayButton: {
    width: "100%",
    marginTop: 10,
    border: "1px solid rgba(96,165,250,.35)",
    background: "rgba(37,99,235,.16)",
    color: "#bfdbfe",
    borderRadius: 11,
    padding: "9px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
};