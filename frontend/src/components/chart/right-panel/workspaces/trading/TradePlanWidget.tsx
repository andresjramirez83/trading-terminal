import type { PositionSide, TradePlanState, TradePlanStats } from "./TradingTypes";
import TradingNumberInput from "./TradingNumberInput";

type TradePlanWidgetProps = {
  plan: TradePlanState;
  stats: TradePlanStats;
  currentPrice: number;
  onChange: (patch: Partial<TradePlanState>) => void;
  onSendToOrder: () => void;
  onSendToPosition: () => void;
};

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function num(value: number): string {
  return Number.isFinite(value) && value > 0 ? value.toString() : "";
}

export default function TradePlanWidget({
  plan,
  stats,
  currentPrice,
  onChange,
  onSendToOrder,
  onSendToPosition,
}: TradePlanWidgetProps) {
  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Planning</div>
          <div style={styles.title}>Trade Plan</div>
        </div>

        <div style={styles.symbol}>{plan.symbol}</div>
      </div>

      <div style={styles.tabs}>
        <SideButton
          active={plan.side === "long"}
          label="Long"
          side="long"
          onClick={() => onChange({ side: "long" })}
        />

        <SideButton
          active={plan.side === "short"}
          label="Short"
          side="short"
          onClick={() => onChange({ side: "short" })}
        />
      </div>

      <div style={styles.currentStrip}>
        <span>Current Price</span>
        <strong>{currentPrice > 0 ? money(currentPrice) : "—"}</strong>
      </div>

      <div style={styles.grid}>
        <Field label="Entry" value={plan.entry} onChange={(entry) => onChange({ entry })} />
        <Field label="Shares" value={plan.shares} onChange={(shares) => onChange({ shares })} />
        <Field label="Target" value={plan.target} onChange={(target) => onChange({ target })} />
        <Field label="Stop" value={plan.stop} onChange={(stop) => onChange({ stop })} />
      </div>

      <div style={styles.metrics}>
        <Metric label="Active Entry" value={money(stats.activeEntry)} />
        <Metric label="Risk / Share" value={money(stats.riskPerShare)} danger />
        <Metric label="Reward / Share" value={money(stats.rewardPerShare)} good />
        <Metric label="Total Risk" value={money(stats.totalRisk)} danger />
        <Metric label="Total Reward" value={money(stats.totalReward)} good />
        <Metric label="R Multiple" value={`${stats.rMultiple.toFixed(2)}R`} />
      </div>

      <div style={styles.actions}>
        <button type="button" style={styles.primaryButton} onClick={onSendToOrder}>
          Send to Order
        </button>

        <button type="button" style={styles.secondaryButton} onClick={onSendToPosition}>
          Mock Position
        </button>
      </div>

      <div style={styles.footer}>Entry defaults to current price when left blank.</div>
    </section>
  );
}

function SideButton({
  active,
  label,
  side,
  onClick,
}: {
  active: boolean;
  label: string;
  side: PositionSide;
  onClick: () => void;
}) {
  const isLong = side === "long";

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...styles.tab,
        background: active
          ? isLong
            ? "rgba(34,197,94,.22)"
            : "rgba(239,68,68,.22)"
          : "rgba(15,23,42,.8)",
        borderColor: active
          ? isLong
            ? "rgba(34,197,94,.6)"
            : "rgba(239,68,68,.6)"
          : "rgba(148,163,184,.18)",
        color: active ? "#fff" : "#94a3b8",
      }}
    >
      {label}
    </button>
  );
}

function Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label style={styles.field}>
      <span>{label}</span>
      <TradingNumberInput value={value} onChange={onChange} />
    </label>
  );
}

function Metric({
  label,
  value,
  good,
  danger,
}: {
  label: string;
  value: string;
  good?: boolean;
  danger?: boolean;
}) {
  return (
    <div style={styles.metric}>
      <span>{label}</span>
      <strong style={{ color: good ? "#22c55e" : danger ? "#ef4444" : "#e5e7eb" }}>
        {value}
      </strong>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: 18,
    background: "linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.96))",
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
  symbol: {
    border: "1px solid rgba(59,130,246,.4)",
    background: "rgba(59,130,246,.12)",
    color: "#bfdbfe",
    borderRadius: 999,
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 900,
    height: "fit-content",
  },
  tabs: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginBottom: 10,
  },
  tab: {
    border: "1px solid",
    borderRadius: 11,
    padding: "8px 6px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
  currentStrip: {
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
  grid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginBottom: 10,
  },
  field: {
    display: "grid",
    gap: 5,
    color: "#94a3b8",
    fontSize: 11,
    fontWeight: 800,
  },
  input: {
    width: "100%",
    boxSizing: "border-box",
    background: "rgba(2,6,23,.95)",
    border: "1px solid rgba(148,163,184,.24)",
    borderRadius: 11,
    color: "#e5e7eb",
    padding: "9px 10px",
    outline: "none",
    fontSize: 13,
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
    border: "1px solid rgba(96,165,250,.45)",
    background: "rgba(37,99,235,.22)",
    color: "#bfdbfe",
    borderRadius: 12,
    padding: "10px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
  secondaryButton: {
    border: "1px solid rgba(148,163,184,.2)",
    background: "rgba(15,23,42,.85)",
    color: "#cbd5e1",
    borderRadius: 12,
    padding: "10px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
  footer: {
    marginTop: 10,
    color: "#64748b",
    fontSize: 11,
  },
};