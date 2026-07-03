import type { TradingAccount } from "./TradingTypes";

type AccountWidgetProps = {
  account: TradingAccount;
};

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

export default function AccountWidget({ account }: AccountWidgetProps) {
  const dayPositive = account.dayPnl >= 0;

  return (
    <section style={styles.card}>
      <div style={styles.header}>
        <div>
          <div style={styles.kicker}>Account</div>
          <div style={styles.title}>Overview</div>
        </div>

        <div
          style={{
            ...styles.pnlBadge,
            color: dayPositive ? "#22c55e" : "#ef4444",
            borderColor: dayPositive
              ? "rgba(34, 197, 94, 0.35)"
              : "rgba(239, 68, 68, 0.35)",
            background: dayPositive
              ? "rgba(34, 197, 94, 0.1)"
              : "rgba(239, 68, 68, 0.1)",
          }}
        >
          {dayPositive ? "+" : ""}
          {money(account.dayPnl)} / {account.dayPnlPct.toFixed(2)}%
        </div>
      </div>

      <div style={styles.grid}>
        <Metric label="Buying Power" value={money(account.buyingPower)} />
        <Metric label="Cash" value={money(account.cash)} />
        <Metric label="Portfolio" value={money(account.portfolioValue)} />
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metric}>
      <div style={styles.metricLabel}>{label}</div>
      <div style={styles.metricValue}>{value}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: 16,
    background:
      "linear-gradient(180deg, rgba(15, 23, 42, 0.92), rgba(2, 6, 23, 0.92))",
    padding: 14,
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },
  kicker: {
    fontSize: 10,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  title: {
    fontSize: 15,
    fontWeight: 800,
  },
  pnlBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    fontSize: 11,
    fontWeight: 800,
    whiteSpace: "nowrap",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr",
    gap: 8,
  },
  metric: {
    display: "flex",
    justifyContent: "space-between",
    background: "rgba(15, 23, 42, 0.7)",
    borderRadius: 10,
    padding: "8px 10px",
  },
  metricLabel: {
    color: "#94a3b8",
    fontSize: 12,
  },
  metricValue: {
    fontSize: 13,
    fontWeight: 800,
  },
};