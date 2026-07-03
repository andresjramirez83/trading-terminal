import type {
  CurrentPositionState,
  CurrentPositionStats,
  PositionSide,
} from "./TradingTypes";

type CurrentPositionWidgetProps = {
  position: CurrentPositionState;
  stats: CurrentPositionStats;
  currentPrice: number;
  onChange: (patch: Partial<CurrentPositionState>) => void;
  onMoveStopToBreakEven: () => void;
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

export default function CurrentPositionWidget({
  position,
  stats,
  currentPrice,
  onChange,
  onMoveStopToBreakEven,
}: CurrentPositionWidgetProps) {
  const pnlPositive = stats.unrealizedPnl >= 0;

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Position</div>
          <div style={styles.title}>Current Position</div>
        </div>

        <div
          style={{
            ...styles.statusBadge,
            color: pnlPositive ? "#22c55e" : "#ef4444",
            borderColor: pnlPositive ? "rgba(34,197,94,.45)" : "rgba(239,68,68,.45)",
            background: pnlPositive ? "rgba(34,197,94,.12)" : "rgba(239,68,68,.12)",
          }}
        >
          {pnlPositive ? "+" : ""}
          {money(stats.unrealizedPnl)}
        </div>
      </div>

      <div style={styles.symbolRow}>
        <strong>{position.symbol}</strong>
        <span>{position.side.toUpperCase()}</span>
      </div>

      <div style={styles.tabs}>
        <SideButton
          active={position.side === "long"}
          label="Long"
          side="long"
          onClick={() => onChange({ side: "long" })}
        />

        <SideButton
          active={position.side === "short"}
          label="Short"
          side="short"
          onClick={() => onChange({ side: "short" })}
        />
      </div>

      <div style={styles.grid}>
        <Field label="Shares" value={position.shares} onChange={(shares) => onChange({ shares })} />
        <Field label="Entry" value={position.entry} onChange={(entry) => onChange({ entry })} />
        <Field label="Target" value={position.target} onChange={(target) => onChange({ target })} />
        <Field label="Stop" value={position.stop} onChange={(stop) => onChange({ stop })} />
      </div>

      <div style={styles.metrics}>
        <Metric label="Entry" value={money(stats.activeEntry)} />
        <Metric label="Current" value={currentPrice > 0 ? money(currentPrice) : "—"} />
        <Metric
          label="Unrealized P/L"
          value={`${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}`}
          good={pnlPositive}
          danger={!pnlPositive}
        />
        <Metric
          label="Money Earned"
          value={`${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}`}
          good={pnlPositive}
          danger={!pnlPositive}
        />
        <Metric label="R Multiple" value={`${stats.currentR.toFixed(2)}R`} />
        <Metric label="Risk / Share" value={money(stats.riskPerShare)} danger />
      </div>

      <div style={styles.progressWrap}>
        <div style={styles.progressHeader}>
          <span>Progress to Target</span>
          <strong>{stats.progressToTarget.toFixed(0)}%</strong>
        </div>

        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${stats.progressToTarget}%` }} />
        </div>
      </div>

      <div style={styles.actionGrid}>
        <button type="button" style={styles.actionButton}>
          Move Stop
        </button>

        <button type="button" style={styles.actionButton} onClick={onMoveStopToBreakEven}>
          Break Even
        </button>

        <button type="button" style={styles.actionButton}>
          Scale Out
        </button>

        <button type="button" style={styles.closeButton}>
          Close
        </button>
      </div>
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
      <input
        type="number"
        value={num(value)}
        onChange={(event) => onChange(Number(event.target.value))}
        style={styles.input}
      />
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
  statusBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 900,
    height: "fit-content",
  },
  symbolRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.65)",
    borderRadius: 12,
    padding: "9px 10px",
    marginBottom: 10,
    color: "#cbd5e1",
    fontSize: 12,
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
  progressWrap: {
    marginTop: 12,
  },
  progressHeader: {
    display: "flex",
    justifyContent: "space-between",
    color: "#94a3b8",
    fontSize: 11,
    marginBottom: 6,
  },
  progressTrack: {
    height: 9,
    borderRadius: 999,
    background: "rgba(15,23,42,.95)",
    border: "1px solid rgba(148,163,184,.18)",
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    background: "linear-gradient(90deg, #2563eb, #22c55e)",
  },
  actionGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginTop: 12,
  },
  actionButton: {
    border: "1px solid rgba(148,163,184,.2)",
    background: "rgba(15,23,42,.85)",
    color: "#cbd5e1",
    borderRadius: 12,
    padding: "10px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
  closeButton: {
    border: "1px solid rgba(248,113,113,.35)",
    background: "rgba(127,29,29,.18)",
    color: "#fecaca",
    borderRadius: 12,
    padding: "10px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
};