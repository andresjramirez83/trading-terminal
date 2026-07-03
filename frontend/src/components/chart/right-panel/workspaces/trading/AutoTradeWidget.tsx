import { useState } from "react";

type AutoTradeStatus = "running" | "stopped";

type AutoTradeWidgetProps = {
  symbol: string;
};

const STRATEGIES = [
  "6/7 Low Sweep Reclaim",
  "5AM Pacific Sweep",
  "Overnight Runner",
  "IFVG HTF",
  "Gap ATR Runner",
  "Hourly Sweep Runner",
];

const WATCHLISTS = [
  "Scanner Watchlist",
  "Manual Watchlist",
  "Momentum",
  "Premarket",
];

export default function AutoTradeWidget({ symbol }: AutoTradeWidgetProps) {
  const [status, setStatus] = useState<AutoTradeStatus>("stopped");
  const [strategy, setStrategy] = useState(STRATEGIES[0]);
  const [watchlist, setWatchlist] = useState(WATCHLISTS[0]);

  const running = status === "running";

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Automation</div>
          <div style={styles.title}>Auto Trade</div>
        </div>

        <div
          style={{
            ...styles.statusBadge,
            color: running ? "#22c55e" : "#94a3b8",
            borderColor: running
              ? "rgba(34,197,94,.45)"
              : "rgba(148,163,184,.25)",
            background: running
              ? "rgba(34,197,94,.12)"
              : "rgba(15,23,42,.75)",
          }}
        >
          {running ? "RUNNING" : "STOPPED"}
        </div>
      </div>

      <div style={styles.symbolStrip}>
        <span>Active Symbol</span>
        <strong>{symbol}</strong>
      </div>

      <label style={styles.field}>
        <span>Strategy</span>
        <select
          value={strategy}
          onChange={(event) => setStrategy(event.target.value)}
          style={styles.select}
        >
          {STRATEGIES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <label style={styles.field}>
        <span>Watchlist</span>
        <select
          value={watchlist}
          onChange={(event) => setWatchlist(event.target.value)}
          style={styles.select}
        >
          {WATCHLISTS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <div style={styles.metrics}>
        <Metric label="Trades Today" value="0" />
        <Metric label="Active Positions" value="0" />
        <Metric label="Last Trade" value="—" />
        <Metric label="Last Scan" value="—" />
        <Metric label="Next Scan" value="45s" />
        <Metric label="Mode" value="Paper" />
      </div>

      <div style={styles.actions}>
        <button
          type="button"
          onClick={() => setStatus(running ? "stopped" : "running")}
          style={{
            ...styles.primaryButton,
            background: running
              ? "rgba(127,29,29,.22)"
              : "rgba(22,163,74,.18)",
            borderColor: running
              ? "rgba(248,113,113,.4)"
              : "rgba(34,197,94,.4)",
            color: running ? "#fecaca" : "#bbf7d0",
          }}
        >
          {running ? "Stop" : "Start"}
        </button>

        <button type="button" style={styles.secondaryButton}>
          Settings
        </button>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metric}>
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
  statusBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 11,
    fontWeight: 900,
    height: "fit-content",
  },
  symbolStrip: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.65)",
    borderRadius: 12,
    padding: "9px 10px",
    marginBottom: 10,
    color: "#94a3b8",
    fontSize: 12,
  },
  field: {
    display: "grid",
    gap: 5,
    marginBottom: 10,
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: 800,
  },
  select: {
    width: "100%",
    boxSizing: "border-box",
    background: "rgba(2,6,23,.95)",
    border: "1px solid rgba(148,163,184,.24)",
    borderRadius: 11,
    color: "#e5e7eb",
    padding: "9px 10px",
    outline: "none",
    fontSize: 12,
    fontWeight: 800,
  },
  metrics: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  metric: {
    display: "grid",
    gap: 3,
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(15,23,42,.72)",
    borderRadius: 12,
    padding: "9px 10px",
    fontSize: 11,
    color: "#94a3b8",
  },
  actions: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginTop: 12,
  },
  primaryButton: {
    border: "1px solid",
    borderRadius: 12,
    padding: "10px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid rgba(96,165,250,.35)",
    background: "rgba(37,99,235,.16)",
    color: "#bfdbfe",
    borderRadius: 12,
    padding: "10px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
};