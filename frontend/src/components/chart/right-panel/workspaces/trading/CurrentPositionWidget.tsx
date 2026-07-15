import type {
  CurrentPositionState,
  CurrentPositionStats,
  PositionSide,
} from "./TradingTypes";
import type { PositionProtectionState } from "../../../../../trading/position/PositionProtectionEngine";
import TradingNumberInput from "./TradingNumberInput";

type CurrentPositionWidgetProps = {
  position: CurrentPositionState;
  stats: CurrentPositionStats;
  currentPrice: number;
  protection?: PositionProtectionState | null;
  executionLoading?: boolean;
  onChange: (patch: Partial<CurrentPositionState>) => void;
  onMoveStopToBreakEven: () => void | Promise<void>;
  onClosePosition?: () => void | Promise<void>;
  onClosePositionPercent?: (percent: number) => void | Promise<void>;
  onFlattenAllPositions?: () => void | Promise<void>;
};

type ProtectionTone = "live" | "local" | "missing";

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function protectionLabel(tone: ProtectionTone): string {
  if (tone === "live") return "LIVE";
  if (tone === "local") return "LOCAL";
  return "MISSING";
}

function protectionToneStyle(tone: ProtectionTone): React.CSSProperties {
  if (tone === "live") {
    return {
      color: "#86efac",
      borderColor: "rgba(34,197,94,.45)",
      background: "rgba(34,197,94,.12)",
    };
  }

  if (tone === "local") {
    return {
      color: "#fde68a",
      borderColor: "rgba(250,204,21,.38)",
      background: "rgba(113,63,18,.2)",
    };
  }

  return {
    color: "#fecaca",
    borderColor: "rgba(248,113,113,.38)",
    background: "rgba(127,29,29,.18)",
  };
}

export default function CurrentPositionWidget({
  position,
  stats,
  currentPrice,
  protection,
  executionLoading = false,
  onChange,
  onMoveStopToBreakEven,
  onClosePosition,
  onClosePositionPercent,
  onFlattenAllPositions,
}: CurrentPositionWidgetProps) {
  const hasPosition = position.shares > 0;
  const pnlPositive = stats.unrealizedPnl >= 0;

  const liveStop = Boolean(protection?.stopOrderId);
  const liveTarget = Boolean(protection?.targetOrderId);
  const hasStopValue = position.stop > 0;
  const hasTargetValue = position.target > 0;

  const stopTone: ProtectionTone = liveStop
    ? "live"
    : hasStopValue
      ? "local"
      : "missing";

  const targetTone: ProtectionTone = liveTarget
    ? "live"
    : hasTargetValue
      ? "local"
      : "missing";

  const fullyProtected = liveStop && liveTarget;
  const partiallyProtected = liveStop || liveTarget;

  const pnlPct =
    hasPosition && stats.activeEntry > 0
      ? (stats.pnlPerShare / stats.activeEntry) * 100
      : 0;

  const rewardRemaining =
    hasPosition && position.target > 0
      ? position.side === "long"
        ? Math.max(0, position.target - currentPrice) * position.shares
        : Math.max(0, currentPrice - position.target) * position.shares
      : 0;

  const riskRemaining =
    hasPosition && position.stop > 0
      ? position.side === "long"
        ? Math.max(0, currentPrice - position.stop) * position.shares
        : Math.max(0, position.stop - currentPrice) * position.shares
      : 0;

  const controlsDisabled = !hasPosition || executionLoading;

  return (
    <section
      style={styles.card}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Position Manager</div>
          <div style={styles.title}>Live Position</div>
        </div>

        <div
          style={{
            ...styles.statusBadge,
            color: hasPosition
              ? pnlPositive
                ? "#22c55e"
                : "#ef4444"
              : "#94a3b8",
            borderColor: hasPosition
              ? pnlPositive
                ? "rgba(34,197,94,.45)"
                : "rgba(239,68,68,.45)"
              : "rgba(148,163,184,.25)",
            background: hasPosition
              ? pnlPositive
                ? "rgba(34,197,94,.12)"
                : "rgba(239,68,68,.12)"
              : "rgba(15,23,42,.75)",
          }}
        >
          {hasPosition
            ? `${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}`
            : "FLAT"}
        </div>
      </div>

      <div style={styles.hero}>
        <div>
          <div style={styles.heroSymbol}>{position.symbol}</div>
          <div style={styles.heroSide}>
            {hasPosition
              ? `${position.side.toUpperCase()} ${position.shares} SHARES`
              : "NO LIVE POSITION"}
          </div>
        </div>

        <div style={styles.heroPnl}>
          <strong
            style={{
              color: hasPosition
                ? pnlPositive
                  ? "#22c55e"
                  : "#ef4444"
                : "#94a3b8",
            }}
          >
            {hasPosition
              ? `${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}`
              : "—"}
          </strong>
          <span>{hasPosition ? pct(pnlPct) : "—"}</span>
        </div>
      </div>

      {hasPosition ? (
        <div style={styles.protectionCard}>
          <div style={styles.protectionHeader}>
            <div>
              <div style={styles.protectionKicker}>Alpaca Protection</div>
              <div style={styles.protectionTitle}>
                {fullyProtected
                  ? "Position Protected"
                  : partiallyProtected
                    ? "Partially Protected"
                    : "Protection Missing"}
              </div>
            </div>

            <div
              style={{
                ...styles.protectionSummaryBadge,
                ...(fullyProtected
                  ? protectionToneStyle("live")
                  : partiallyProtected
                    ? protectionToneStyle("local")
                    : protectionToneStyle("missing")),
              }}
            >
              {fullyProtected
                ? "PROTECTED"
                : partiallyProtected
                  ? "PARTIAL"
                  : "UNPROTECTED"}
            </div>
          </div>

          <div style={styles.protectionGrid}>
            <ProtectionMetric
              label="Stop"
              value={position.stop > 0 ? money(position.stop) : "—"}
              tone={stopTone}
            />
            <ProtectionMetric
              label="Target"
              value={position.target > 0 ? money(position.target) : "—"}
              tone={targetTone}
            />
          </div>

          <div style={styles.protectionNote}>
            {liveStop || liveTarget
              ? "LIVE values are matched to active Alpaca closing orders. Editing a LIVE field sends an order replacement to Alpaca."
              : "No active Alpaca protective order was matched. Values entered below remain local until a live stop or target order exists."}
          </div>
        </div>
      ) : (
        <div style={styles.empty}>
          No live Alpaca position for this symbol. Target and stop can still be
          prepared here before a fill appears.
        </div>
      )}

      <div style={styles.tabs}>
        <SideButton
          active={position.side === "long"}
          label="Long"
          side="long"
          disabled={hasPosition}
          onClick={() => onChange({ side: "long" })}
        />
        <SideButton
          active={position.side === "short"}
          label="Short"
          side="short"
          disabled={hasPosition}
          onClick={() => onChange({ side: "short" })}
        />
      </div>

      <div style={styles.mainGrid}>
        <Metric label="Entry" value={position.entry > 0 ? money(position.entry) : "—"} />
        <Metric label="Current" value={currentPrice > 0 ? money(currentPrice) : "—"} />
        <Metric
          label="Open P/L"
          value={hasPosition ? `${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}` : "—"}
          good={hasPosition && pnlPositive}
          danger={hasPosition && !pnlPositive}
        />
        <Metric label="Current R" value={hasPosition ? `${stats.currentR.toFixed(2)}R` : "—"} />
        <Metric
          label="Risk Left"
          value={hasPosition && position.stop > 0 ? money(riskRemaining) : "—"}
          danger={hasPosition && position.stop > 0}
        />
        <Metric
          label="Reward Left"
          value={hasPosition && position.target > 0 ? money(rewardRemaining) : "—"}
          good={hasPosition && position.target > 0}
        />
      </div>

      <div style={styles.grid}>
        <Field
          label="Shares"
          value={position.shares}
          disabled={hasPosition}
          onChange={(shares) => onChange({ shares })}
        />
        <Field
          label="Entry"
          value={position.entry}
          disabled={hasPosition}
          onChange={(entry) => onChange({ entry })}
        />
        <Field
          label={`Target · ${protectionLabel(targetTone)}`}
          value={position.target}
          disabled={executionLoading}
          tone={targetTone}
          onChange={(target) => onChange({ target })}
        />
        <Field
          label={`Stop · ${protectionLabel(stopTone)}`}
          value={position.stop}
          disabled={executionLoading}
          tone={stopTone}
          onChange={(stop) => onChange({ stop })}
        />
      </div>

      <div style={styles.progressWrap}>
        <div style={styles.progressHeader}>
          <span>Target Progress</span>
          <strong>
            {hasPosition && position.target > 0
              ? `${stats.progressToTarget.toFixed(0)}%`
              : "—"}
          </strong>
        </div>

        <div style={styles.progressTrack}>
          <div
            style={{
              ...styles.progressFill,
              width: `${hasPosition && position.target > 0 ? stats.progressToTarget : 0}%`,
            }}
          />
        </div>
      </div>

      <div style={styles.sectionLabel}>Scale Out</div>

      <div style={styles.actionGrid}>
        <ActionButton
          label="Close 25%"
          disabled={controlsDisabled}
          onClick={() => onClosePositionPercent?.(25)}
        />
        <ActionButton
          label="Close 50%"
          disabled={controlsDisabled}
          onClick={() => onClosePositionPercent?.(50)}
        />
        <ActionButton
          label="Close 75%"
          disabled={controlsDisabled}
          onClick={() => onClosePositionPercent?.(75)}
        />

        <button
          type="button"
          style={{ ...styles.closeButton, ...disabledStyle(controlsDisabled) }}
          disabled={controlsDisabled}
          onClick={() => void onClosePosition?.()}
        >
          Close All
        </button>
      </div>

      <div style={styles.sectionLabel}>Risk Controls</div>

      <div style={styles.actionGrid}>
        <button
          type="button"
          style={{
            ...styles.actionButton,
            ...disabledStyle(controlsDisabled || !liveStop),
          }}
          disabled={controlsDisabled || !liveStop}
          onClick={() => void onMoveStopToBreakEven()}
          title={
            liveStop
              ? "Replace the live Alpaca stop order at the average entry price."
              : "A live Alpaca stop order is required."
          }
        >
          Break Even
        </button>

        <button
          type="button"
          style={{
            ...styles.actionButton,
            ...disabledStyle(controlsDisabled || !liveStop),
          }}
          disabled={controlsDisabled || !liveStop}
          title={
            liveStop
              ? "Enter a new price in the LIVE Stop field to replace the Alpaca order."
              : "A live Alpaca stop order is required."
          }
        >
          Edit Live Stop
        </button>

        <button
          type="button"
          style={{ ...styles.actionButton, ...disabledStyle(true) }}
          disabled
          title="Trailing-stop automation will be wired in the next phase."
        >
          Trail Stop
        </button>

        <button
          type="button"
          style={{ ...styles.flattenButton, ...disabledStyle(controlsDisabled) }}
          disabled={controlsDisabled}
          onClick={() => void onFlattenAllPositions?.()}
        >
          Flatten All
        </button>
      </div>

      <div style={styles.footer}>
        Shares and entry are synchronized from Alpaca. LIVE stop and target
        fields replace matched Alpaca orders when edited.
      </div>
    </section>
  );
}

function ProtectionMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: ProtectionTone;
}) {
  return (
    <div style={styles.protectionMetric}>
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
      </div>

      <div style={{ ...styles.protectionBadge, ...protectionToneStyle(tone) }}>
        {protectionLabel(tone)}
      </div>
    </div>
  );
}

function ActionButton({
  label,
  disabled,
  onClick,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void | Promise<void>;
}) {
  return (
    <button
      type="button"
      style={{ ...styles.actionButton, ...disabledStyle(disabled) }}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {label}
    </button>
  );
}

function disabledStyle(disabled: boolean): React.CSSProperties {
  return disabled
    ? { opacity: 0.45, cursor: "not-allowed" }
    : { opacity: 1, cursor: "pointer" };
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
  tone,
  onChange,
}: {
  label: string;
  value: number;
  disabled?: boolean;
  tone?: ProtectionTone;
  onChange: (value: number) => void;
}) {
  return (
    <label
      style={{
        ...styles.field,
        opacity: disabled ? 0.55 : 1,
        color:
          tone === "live"
            ? "#86efac"
            : tone === "local"
              ? "#fde68a"
              : tone === "missing"
                ? "#fecaca"
                : "#94a3b8",
      }}
    >
      <span>{label}</span>
      <TradingNumberInput value={value} disabled={disabled} onChange={onChange} />
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
    fontSize: 12,
    fontWeight: 900,
    height: "fit-content",
  },
  hero: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.65)",
    borderRadius: 14,
    padding: "12px",
    marginBottom: 10,
  },
  heroSymbol: {
    fontSize: 20,
    fontWeight: 950,
    color: "#e5e7eb",
  },
  heroSide: {
    marginTop: 3,
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 900,
    letterSpacing: 0.8,
  },
  heroPnl: {
    display: "grid",
    justifyItems: "end",
    gap: 3,
    fontSize: 11,
    color: "#94a3b8",
  },
  protectionCard: {
    border: "1px solid rgba(148,163,184,.18)",
    background: "rgba(2,6,23,.72)",
    borderRadius: 14,
    padding: 10,
    marginBottom: 10,
  },
  protectionHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 10,
    marginBottom: 9,
  },
  protectionKicker: {
    color: "#64748b",
    fontSize: 9,
    fontWeight: 900,
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  protectionTitle: {
    marginTop: 2,
    color: "#e5e7eb",
    fontSize: 12,
    fontWeight: 900,
  },
  protectionSummaryBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    fontSize: 9,
    fontWeight: 950,
    whiteSpace: "nowrap",
  },
  protectionGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 7,
  },
  protectionMetric: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    border: "1px solid rgba(148,163,184,.14)",
    background: "rgba(15,23,42,.76)",
    borderRadius: 11,
    padding: 8,
    color: "#94a3b8",
    fontSize: 10,
  },
  protectionBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 950,
    whiteSpace: "nowrap",
  },
  protectionNote: {
    marginTop: 8,
    color: "#64748b",
    fontSize: 10,
    lineHeight: 1.35,
  },
  empty: {
    border: "1px dashed rgba(148,163,184,.25)",
    borderRadius: 14,
    padding: 10,
    color: "#64748b",
    fontSize: 11,
    lineHeight: 1.35,
    marginBottom: 10,
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
  mainGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
    marginBottom: 10,
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
    fontSize: 11,
    fontWeight: 800,
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
  sectionLabel: {
    marginTop: 12,
    marginBottom: 7,
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 950,
    textTransform: "uppercase",
    letterSpacing: 0.9,
  },
  actionGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 8,
  },
  actionButton: {
    border: "1px solid rgba(148,163,184,.2)",
    background: "rgba(15,23,42,.85)",
    color: "#cbd5e1",
    borderRadius: 12,
    padding: 10,
    fontSize: 11,
    fontWeight: 900,
  },
  closeButton: {
    border: "1px solid rgba(248,113,113,.35)",
    background: "rgba(127,29,29,.18)",
    color: "#fecaca",
    borderRadius: 12,
    padding: 10,
    fontSize: 11,
    fontWeight: 900,
  },
  flattenButton: {
    border: "1px solid rgba(251,146,60,.35)",
    background: "rgba(124,45,18,.18)",
    color: "#fed7aa",
    borderRadius: 12,
    padding: 10,
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