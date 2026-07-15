import { calculateQuickOrderEstimate } from "./OrderCalculator";
import TradingNumberInput from "./TradingNumberInput";
import type { OrderType, QuickOrderState } from "./TradingTypes";

type QuickOrderWidgetProps = {
  order: QuickOrderState;
  currentPrice: number;
  onChange: (patch: Partial<QuickOrderState>) => void;
  onSubmit: (estimatedShares: number) => void | Promise<void>;
};

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function getSubmitWarning(order: QuickOrderState, currentPrice: number, estimatedShares: number): string | null {
  if (!order.symbol || order.symbol === "—") return "No symbol selected.";
  if (estimatedShares <= 0) return "Estimated shares is 0.";
  if (order.orderType === "limit" && order.limitPrice <= 0) return "Limit price is required.";
  if (order.orderType === "stop") return "Stop orders are not wired yet. Use market or limit.";
  if (order.bracketEnabled && order.bracketTarget <= 0 && order.bracketStop <= 0) {
    return "Bracket needs a target or stop, or turn bracket off.";
  }
  return null;
}

export default function QuickOrderWidget({
  order,
  currentPrice,
  onChange,
  onSubmit,
}: QuickOrderWidgetProps) {
  const estimate = calculateQuickOrderEstimate(order, currentPrice);
  const isBuy = order.side === "buy";
  const warning = getSubmitWarning(order, currentPrice, estimate.estimatedShares);
  const canSubmit = !warning;

  async function handleSubmit() {
    console.log("[QuickOrderWidget] submit clicked", {
      canSubmit,
      warning,
      currentPrice,
      estimatedShares: estimate.estimatedShares,
      order,
    });

    if (!canSubmit) return;

    await onSubmit(estimate.estimatedShares);
  }

  return (
    <section
      style={styles.card}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Execution</div>
          <div style={styles.title}>Quick Order</div>
        </div>

        <div style={styles.symbol}>{order.symbol}</div>
      </div>

      <div style={styles.buySellGrid}>
        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onChange({ side: "buy" })}
          style={{
            ...styles.bigSideButton,
            background: isBuy
              ? "linear-gradient(135deg, #15803d, #22c55e)"
              : "rgba(15, 23, 42, 0.9)",
            borderColor: isBuy
              ? "rgba(34,197,94,.65)"
              : "rgba(148,163,184,.2)",
          }}
        >
          BUY
        </button>

        <button
          type="button"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => onChange({ side: "sell" })}
          style={{
            ...styles.bigSideButton,
            background: !isBuy
              ? "linear-gradient(135deg, #b91c1c, #ef4444)"
              : "rgba(15, 23, 42, 0.9)",
            borderColor: !isBuy
              ? "rgba(239,68,68,.65)"
              : "rgba(148,163,184,.2)",
          }}
        >
          SELL
        </button>
      </div>

      <div style={styles.priceStrip}>
        <span>Last Price</span>
        <strong>{currentPrice > 0 ? money(currentPrice) : "—"}</strong>
      </div>

      <div style={styles.tabs}>
        <Tab
          active={order.sizingMode === "shares"}
          label="Shares"
          onClick={() => onChange({ sizingMode: "shares" })}
        />

        <Tab
          active={order.sizingMode === "dollars"}
          label="Dollars"
          onClick={() => onChange({ sizingMode: "dollars" })}
        />
      </div>

      <div style={styles.inputGrid}>
        {order.sizingMode === "shares" ? (
          <NumberField
            label="Share Qty"
            value={order.shares}
            onChange={(shares) => onChange({ shares })}
          />
        ) : (
          <NumberField
            label="Dollar Size"
            value={order.dollars}
            onChange={(dollars) => onChange({ dollars })}
          />
        )}

        <NumberField
          label="Est. Shares"
          value={estimate.estimatedShares}
          disabled
          onChange={() => undefined}
        />
      </div>

      <div style={styles.tabs}>
        {(["market", "limit", "stop"] as OrderType[]).map((type) => (
          <Tab
            key={type}
            active={order.orderType === type}
            label={type.toUpperCase()}
            onClick={() => onChange({ orderType: type })}
          />
        ))}
      </div>

      <div style={styles.inputGrid}>
        <NumberField
          label="Limit"
          value={order.limitPrice}
          disabled={order.orderType !== "limit"}
          onChange={(limitPrice) => onChange({ limitPrice })}
        />

        <NumberField
          label="Stop Order"
          value={order.stopPrice}
          disabled={order.orderType !== "stop"}
          onChange={(stopPrice) => onChange({ stopPrice })}
        />
      </div>

      <div style={styles.bracketHeader}>
        <label style={styles.toggle}>
          <input
            type="checkbox"
            checked={order.extendedHours}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) =>
              onChange({ extendedHours: event.target.checked })
            }
          />
          EXT
        </label>

        <label style={styles.toggle}>
          <input
            type="checkbox"
            checked={order.bracketEnabled}
            onPointerDown={(event) => event.stopPropagation()}
            onChange={(event) =>
              onChange({ bracketEnabled: event.target.checked })
            }
          />
          Bracket
        </label>
      </div>

      <div style={styles.inputGrid}>
        <NumberField
          label="Target"
          value={order.bracketTarget}
          disabled={!order.bracketEnabled}
          onChange={(bracketTarget) => onChange({ bracketTarget })}
        />

        <NumberField
          label="Stop"
          value={order.bracketStop}
          disabled={!order.bracketEnabled}
          onChange={(bracketStop) => onChange({ bracketStop })}
        />
      </div>

      <div style={styles.statsGrid}>
        <Stat label="Position" value={money(estimate.estimatedCost)} />
        <Stat label="Risk" value={money(estimate.totalRisk)} danger />
        <Stat label="Reward" value={money(estimate.totalReward)} good />
        <Stat label="R Multiple" value={`${estimate.rMultiple.toFixed(2)}R`} />
      </div>

      {warning && <div style={styles.warning}>{warning}</div>}

      <button
        type="button"
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void handleSubmit();
        }}
        style={{
          ...styles.submit,
          opacity: canSubmit ? 1 : 0.65,
          cursor: "pointer",
          background: isBuy
            ? "linear-gradient(135deg, #16a34a, #22c55e)"
            : "linear-gradient(135deg, #dc2626, #ef4444)",
        }}
      >
        Send Live {isBuy ? "Buy" : "Sell"} Order · {estimate.estimatedShares} Shares
      </button>

      <div style={styles.footer}>
        Orders route through TradeExecutionService → Alpaca.
      </div>
    </section>
  );
}

function Tab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      style={{
        ...styles.tab,
        background: active ? "rgba(37, 99, 235, 0.28)" : "rgba(15,23,42,.8)",
        borderColor: active
          ? "rgba(96,165,250,.6)"
          : "rgba(148,163,184,.18)",
        color: active ? "#fff" : "#94a3b8",
      }}
    >
      {label}
    </button>
  );
}

function NumberField({
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
    <label style={{ ...styles.field, opacity: disabled ? 0.45 : 1 }}>
      <span>{label}</span>
      <TradingNumberInput value={value} disabled={disabled} onChange={onChange} />
    </label>
  );
}

function Stat({
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
    <div style={styles.stat}>
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
    boxShadow: "0 20px 50px rgba(0,0,0,.25)",
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
  buySellGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 10,
    marginBottom: 10,
  },
  bigSideButton: {
    border: "1px solid",
    borderRadius: 14,
    padding: "14px 10px",
    color: "#fff",
    fontSize: 18,
    fontWeight: 950,
    cursor: "pointer",
  },
  priceStrip: {
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
  tabs: {
    display: "grid",
    gridAutoFlow: "column",
    gridAutoColumns: "1fr",
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
  inputGrid: {
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
  bracketHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 10,
  },
  toggle: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: 800,
  },
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginTop: 4,
  },
  stat: {
    display: "grid",
    gap: 3,
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(15,23,42,.72)",
    borderRadius: 12,
    padding: "9px 10px",
    fontSize: 11,
    color: "#94a3b8",
  },
  warning: {
    marginTop: 10,
    border: "1px solid rgba(250,204,21,.3)",
    background: "rgba(113,63,18,.2)",
    color: "#fde68a",
    borderRadius: 12,
    padding: "8px 10px",
    fontSize: 11,
    fontWeight: 800,
  },
  submit: {
    width: "100%",
    border: "none",
    borderRadius: 14,
    color: "#fff",
    padding: "13px 10px",
    marginTop: 12,
    fontSize: 13,
    fontWeight: 950,
  },
  footer: {
    marginTop: 10,
    color: "#64748b",
    fontSize: 11,
    lineHeight: 1.35,
  },
};