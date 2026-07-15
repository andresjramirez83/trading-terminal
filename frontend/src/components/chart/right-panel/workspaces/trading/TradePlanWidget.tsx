import type {
  PositionSide,
  TradePlanState,
  TradePlanStats,
} from "./TradingTypes";
import type { TradeStatus } from "../../../../../trading/engine/TradeTypes";
import TradingNumberInput from "./TradingNumberInput";
import { roundToTick } from "../../../../../trading/pricing/TickSizeManager";

type TradePlanWidgetProps = {
  plan: TradePlanState;
  stats: TradePlanStats;
  currentPrice: number;
  tradeStatus?: TradeStatus | null;
  alpacaOrderCount?: number;
  executionLoading?: boolean;
  executionMessage?: string | null;
  onChange: (patch: Partial<TradePlanState>) => void;
  onSendToOrder: () => void | Promise<void>;
  onSendToPosition: () => void;
};

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function lifecycleLabel(status: TradeStatus | null | undefined): string {
  switch (status) {
    case "submitted":
      return "Submitted";
    case "accepted":
      return "Accepted";
    case "partially_filled":
      return "Partially Filled";
    case "filled":
      return "Filled";
    case "managing":
      return "Live";
    case "closed":
      return "Closed";
    case "cancelled":
      return "Cancelled";
    case "rejected":
      return "Rejected";
    case "ready":
      return "Ready";
    default:
      return "Draft";
  }
}

function lifecycleTone(status: TradeStatus | null | undefined): {
  color: string;
  borderColor: string;
  background: string;
} {
  if (status === "managing" || status === "filled") {
    return {
      color: "#86efac",
      borderColor: "rgba(34,197,94,.45)",
      background: "rgba(34,197,94,.12)",
    };
  }

  if (
    status === "submitted" ||
    status === "accepted" ||
    status === "partially_filled"
  ) {
    return {
      color: "#fde68a",
      borderColor: "rgba(250,204,21,.42)",
      background: "rgba(113,63,18,.2)",
    };
  }

  if (status === "closed") {
    return {
      color: "#bfdbfe",
      borderColor: "rgba(96,165,250,.42)",
      background: "rgba(37,99,235,.14)",
    };
  }

  if (status === "cancelled" || status === "rejected") {
    return {
      color: "#fecaca",
      borderColor: "rgba(248,113,113,.42)",
      background: "rgba(127,29,29,.18)",
    };
  }

  return {
    color: "#cbd5e1",
    borderColor: "rgba(148,163,184,.28)",
    background: "rgba(15,23,42,.78)",
  };
}

export default function TradePlanWidget({
  plan,
  stats,
  currentPrice,
  tradeStatus,
  alpacaOrderCount = 0,
  executionLoading = false,
  executionMessage,
  onChange,
  onSendToOrder,
  onSendToPosition,
}: TradePlanWidgetProps) {
  const status = tradeStatus ?? "draft";
  const submitted =
    status === "submitted" ||
    status === "accepted" ||
    status === "partially_filled";
  const managing = status === "filled" || status === "managing";
  const closed = status === "closed";
  const terminal = closed || status === "cancelled" || status === "rejected";
  const lockPlan = submitted || managing || closed;
  const canSubmit =
    !executionLoading &&
    !submitted &&
    !managing &&
    !closed &&
    plan.shares > 0 &&
    plan.entry > 0 &&
    plan.stop > 0 &&
    plan.target > 0;

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>
            {managing
              ? "Live Trade"
              : closed
                ? "Completed Trade"
                : submitted
                  ? "Order Working"
                  : "Planning"}
          </div>
          <div style={styles.title}>
            {managing || closed || submitted ? "Trade" : "Trade Plan"}
          </div>
        </div>

        <div style={styles.topBadges}>
          <div style={styles.symbol}>{plan.symbol}</div>
          <div
            style={{
              ...styles.statusBadge,
              ...lifecycleTone(status),
            }}
          >
            {lifecycleLabel(status).toUpperCase()}
          </div>
        </div>
      </div>

      {(submitted || managing || terminal) && (
        <div style={styles.lifecycleCard}>
          <div style={styles.lifecycleRow}>
            <span>Status</span>
            <strong>{lifecycleLabel(status)}</strong>
          </div>

          <div style={styles.lifecycleRow}>
            <span>Linked Alpaca Orders</span>
            <strong>{alpacaOrderCount}</strong>
          </div>

          {executionMessage && (
            <div style={styles.lifecycleMessage}>{executionMessage}</div>
          )}

          {submitted && (
            <div style={styles.lifecycleHint}>
              Waiting for Alpaca to report a fill. This same trade and drawing
              will transition to LIVE automatically.
            </div>
          )}

          {managing && (
            <div style={styles.lifecycleHint}>
              Alpaca’s live entry, quantity, stop, and target now control this
              trade.
            </div>
          )}

          {closed && (
            <div style={styles.lifecycleHint}>
              This trade is closed and has been sent to Journal and Performance.
            </div>
          )}
        </div>
      )}

      <div style={styles.tabs}>
        <SideButton
          active={plan.side === "long"}
          label="Long"
          side="long"
          disabled={lockPlan}
          onClick={() => onChange({ side: "long" })}
        />

        <SideButton
          active={plan.side === "short"}
          label="Short"
          side="short"
          disabled={lockPlan}
          onClick={() => onChange({ side: "short" })}
        />
      </div>

      <div style={styles.currentStrip}>
        <span>Current Price</span>
        <strong>{currentPrice > 0 ? money(currentPrice) : "—"}</strong>
      </div>

      <div style={styles.grid}>
        <Field
          label="Entry"
          value={plan.entry}
          disabled={lockPlan}
          onChange={(entry) => onChange({ entry: roundToTick(entry) })}
        />

        <Field
          label="Shares"
          value={plan.shares}
          disabled={lockPlan}
          onChange={(shares) => onChange({ shares })}
        />

        <Field
          label="Target"
          value={plan.target}
          disabled={closed}
          onChange={(target) => onChange({ target: roundToTick(target) })}
        />

        <Field
          label="Stop"
          value={plan.stop}
          disabled={closed}
          onChange={(stop) => onChange({ stop: roundToTick(stop) })}
        />
      </div>

      <div style={styles.metrics}>
        <Metric label="Active Entry" value={money(stats.activeEntry)} />
        <Metric label="Risk / Share" value={money(stats.riskPerShare)} danger />
        <Metric
          label="Reward / Share"
          value={money(stats.rewardPerShare)}
          good
        />
        <Metric label="Total Risk" value={money(stats.totalRisk)} danger />
        <Metric label="Total Reward" value={money(stats.totalReward)} good />
        <Metric label="R Multiple" value={`${stats.rMultiple.toFixed(2)}R`} />
      </div>

      {!closed && (
        <div style={styles.actions}>
          <button
            type="button"
            style={{
              ...styles.primaryButton,
              opacity: canSubmit ? 1 : 0.45,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
            disabled={!canSubmit}
            onClick={() => void onSendToOrder()}
          >
            {executionLoading
              ? "Submitting..."
              : submitted
                ? "Order Submitted"
                : managing
                  ? "Position Live"
                  : "Send Order"}
          </button>

          <button
            type="button"
            style={{
              ...styles.secondaryButton,
              opacity: lockPlan ? 0.45 : 1,
              cursor: lockPlan ? "not-allowed" : "pointer",
            }}
            disabled={lockPlan}
            onClick={onSendToPosition}
          >
            Mock Position
          </button>
        </div>
      )}

      <div style={styles.footer}>
        {closed
          ? "Closed trades remain available in Journal and Performance."
          : managing
            ? "Use Live Position controls to scale out, move to break-even, or flatten."
            : submitted
              ? "The order is linked to this trade and its chart drawing."
              : "Entry, Stop, Target, and Shares must be valid before submission."}
      </div>
    </section>
  );
}

function SideButton({
  active,
  label,
  side,
  disabled,
  onClick,
}: {
  active: boolean;
  label: string;
  side: PositionSide;
  disabled?: boolean;
  onClick: () => void;
}) {
  const isLong = side === "long";

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      style={{
        ...styles.tab,
        opacity: disabled ? 0.55 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
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
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label
      style={{
        ...styles.field,
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span>{label}</span>
      <TradingNumberInput
        value={value}
        disabled={disabled}
        onChange={onChange}
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
      <strong
        style={{
          color: good ? "#22c55e" : danger ? "#ef4444" : "#e5e7eb",
        }}
      >
        {value}
      </strong>
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
  topBadges: {
    display: "flex",
    alignItems: "flex-start",
    gap: 6,
    flexWrap: "wrap",
    justifyContent: "flex-end",
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
  statusBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 9px",
    fontSize: 9,
    fontWeight: 950,
    height: "fit-content",
  },
  lifecycleCard: {
    border: "1px solid rgba(148,163,184,.17)",
    background: "rgba(2,6,23,.65)",
    borderRadius: 13,
    padding: 10,
    marginBottom: 10,
  },
  lifecycleRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    color: "#94a3b8",
    fontSize: 10,
    marginBottom: 5,
  },
  lifecycleMessage: {
    marginTop: 7,
    color: "#cbd5e1",
    fontSize: 10,
    lineHeight: 1.35,
  },
  lifecycleHint: {
    marginTop: 7,
    color: "#64748b",
    fontSize: 10,
    lineHeight: 1.35,
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
  },
  secondaryButton: {
    border: "1px solid rgba(148,163,184,.2)",
    background: "rgba(15,23,42,.85)",
    color: "#cbd5e1",
    borderRadius: 12,
    padding: "10px",
    fontSize: 11,
    fontWeight: 900,
  },
  footer: {
    marginTop: 10,
    color: "#64748b",
    fontSize: 11,
    lineHeight: 1.35,
  },
};