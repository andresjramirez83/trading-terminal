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
  positionStage?: "flat" | "working" | "live";
  protectionOwner?: "alpaca" | "server" | null;
  workingOrderStatus?: string | null;
  executionLoading?: boolean;
  trailEnabled?: boolean;
  extendedProtectionLoading?: boolean;
  canConvertToExtendedProtection?: boolean;
  onChange: (patch: Partial<CurrentPositionState>) => void;
  onEditStop?: (price: number) => void | Promise<void>;
  onMoveStopToBreakEven: () => void | Promise<void>;
  onToggleTrailingStop?: () => void | Promise<void>;
  onConvertToExtendedProtection?: () => void | Promise<void>;
  onClosePosition?: () => void | Promise<void>;
  onClosePositionPercent?: (percent: number) => void | Promise<void>;
  onFlattenAllPositions?: () => void | Promise<void>;
};

type ProtectionTone = "live" | "server" | "working" | "local" | "missing";

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function price(value: number): string {
  const digits = Math.abs(value) < 1 ? 4 : 2;
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function pct(value: number): string {
  if (!Number.isFinite(value)) return "0.00%";
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function protectionLabel(tone: ProtectionTone): string {
  if (tone === "live") return "LIVE";
  if (tone === "server") return "SERVER";
  if (tone === "working") return "ORDER";
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

  if (tone === "server") {
    return {
      color: "#a5f3fc",
      borderColor: "rgba(34,211,238,.42)",
      background: "rgba(8,145,178,.14)",
    };
  }

  if (tone === "working") {
    return {
      color: "#bfdbfe",
      borderColor: "rgba(96,165,250,.42)",
      background: "rgba(37,99,235,.14)",
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
  positionStage = "flat",
  protectionOwner = null,
  workingOrderStatus = null,
  executionLoading = false,
  trailEnabled = false,
  extendedProtectionLoading = false,
  canConvertToExtendedProtection = false,
  onChange,
  onEditStop,
  onMoveStopToBreakEven,
  onToggleTrailingStop,
  onConvertToExtendedProtection,
  onClosePosition,
  onClosePositionPercent,
  onFlattenAllPositions,
}: CurrentPositionWidgetProps) {
  const hasLivePosition = positionStage === "live" && position.shares > 0;
  const hasWorkingOrder = positionStage === "working" && position.shares > 0;
  const hasManagedTrade = hasLivePosition || hasWorkingOrder;
  const pnlPositive = stats.unrealizedPnl >= 0;

  const liveStop = Boolean(protection?.stopOrderId);
  const liveTarget = Boolean(protection?.targetOrderId);
  const hasStopValue = position.stop > 0;
  const hasTargetValue = position.target > 0;

  const stopTone: ProtectionTone =
    protectionOwner === "server" && hasStopValue
      ? "server"
      : hasLivePosition && liveStop
        ? "live"
        : hasWorkingOrder && hasStopValue
          ? "working"
          : hasStopValue
            ? "local"
            : "missing";

  const targetTone: ProtectionTone =
    protectionOwner === "server" && hasTargetValue
      ? "server"
      : hasLivePosition && liveTarget
        ? "live"
        : hasWorkingOrder && hasTargetValue
          ? "working"
          : hasTargetValue
            ? "local"
            : "missing";

  const fullyProtected = hasLivePosition
    ? protectionOwner === "server"
      ? hasStopValue && hasTargetValue
      : liveStop && liveTarget
    : hasWorkingOrder
      ? hasStopValue && hasTargetValue
      : false;

  const partiallyProtected = hasStopValue || hasTargetValue;

  const pnlPct =
    hasLivePosition && stats.activeEntry > 0
      ? (stats.pnlPerShare / stats.activeEntry) * 100
      : 0;

  const rewardRemaining =
    hasLivePosition && position.target > 0
      ? position.side === "long"
        ? Math.max(0, position.target - currentPrice) * position.shares
        : Math.max(0, currentPrice - position.target) * position.shares
      : 0;

  const riskRemaining =
    hasLivePosition && position.stop > 0
      ? position.side === "long"
        ? Math.max(0, currentPrice - position.stop) * position.shares
        : Math.max(0, position.stop - currentPrice) * position.shares
      : 0;

  const plannedRiskPerShare =
    position.entry > 0 && position.stop > 0
      ? position.side === "long"
        ? Math.max(0, position.entry - position.stop)
        : Math.max(0, position.stop - position.entry)
      : 0;

  const plannedRewardPerShare =
    position.entry > 0 && position.target > 0
      ? position.side === "long"
        ? Math.max(0, position.target - position.entry)
        : Math.max(0, position.entry - position.target)
      : 0;

  const plannedRisk = plannedRiskPerShare * position.shares;
  const plannedReward = plannedRewardPerShare * position.shares;
  const plannedRMultiple =
    plannedRiskPerShare > 0 ? plannedRewardPerShare / plannedRiskPerShare : 0;

  const controlsDisabled = !hasLivePosition || executionLoading;

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
          <div style={styles.title}>
            {hasLivePosition
              ? "Live Position"
              : hasWorkingOrder
                ? workingOrderStatus === "QUEUED"
                  ? "Queued Order"
                  : "Accepted Order"
                : "Live Position"}
          </div>
        </div>

        <div
          style={{
            ...styles.statusBadge,
            color: hasLivePosition
              ? pnlPositive
                ? "#22c55e"
                : "#ef4444"
              : hasWorkingOrder
                ? "#facc15"
              : "#94a3b8",
            borderColor: hasLivePosition
              ? pnlPositive
                ? "rgba(34,197,94,.45)"
                : "rgba(239,68,68,.45)"
              : hasWorkingOrder
                ? "rgba(250,204,21,.45)"
              : "rgba(148,163,184,.25)",
            background: hasLivePosition
              ? pnlPositive
                ? "rgba(34,197,94,.12)"
                : "rgba(239,68,68,.12)"
              : hasWorkingOrder
                ? "rgba(113,63,18,.22)"
              : "rgba(15,23,42,.75)",
          }}
        >
          {hasLivePosition
            ? `${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}`
            : hasWorkingOrder
              ? workingOrderStatus ?? "WORKING"
            : "FLAT"}
        </div>
      </div>

      <div style={styles.hero}>
        <div>
          <div style={styles.heroSymbol}>{position.symbol}</div>
          <div style={styles.heroSide}>
            {hasLivePosition
              ? `${position.side.toUpperCase()} ${position.shares} SHARES`
              : hasWorkingOrder
                ? `${position.side.toUpperCase()} ${position.shares} SHARES · ${workingOrderStatus ?? "WORKING"}`
              : "NO LIVE POSITION"}
          </div>
        </div>

        <div style={styles.heroPnl}>
          <strong
            style={{
              color: hasLivePosition
                ? pnlPositive
                  ? "#22c55e"
                  : "#ef4444"
                : hasWorkingOrder
                  ? "#facc15"
                : "#94a3b8",
            }}
          >
            {hasLivePosition
              ? `${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}`
              : hasWorkingOrder
                ? "WAITING FOR FILL"
              : "—"}
          </strong>
          <span>{hasLivePosition ? pct(pnlPct) : "—"}</span>
        </div>
      </div>

      {hasManagedTrade ? (
        <div style={styles.protectionCard}>
          <div style={styles.protectionHeader}>
            <div>
              <div style={styles.protectionKicker}>
                {protectionOwner === "server"
                  ? "Server Protection"
                  : hasWorkingOrder
                    ? "Accepted Order Protection"
                    : "Alpaca Protection"}
              </div>
              <div style={styles.protectionTitle}>
                {fullyProtected
                  ? hasWorkingOrder
                    ? "Protection Ready"
                    : "Position Protected"
                  : partiallyProtected
                    ? "Partially Protected"
                    : "Protection Missing"}
              </div>
            </div>

            <div
              style={{
                ...styles.protectionSummaryBadge,
                ...(fullyProtected
                  ? protectionToneStyle(
                      protectionOwner === "server"
                        ? "server"
                        : hasWorkingOrder
                          ? "working"
                          : "live",
                    )
                  : partiallyProtected
                    ? protectionToneStyle("local")
                    : protectionToneStyle("missing")),
              }}
            >
              {fullyProtected
                ? hasWorkingOrder
                  ? "READY"
                  : "PROTECTED"
                : partiallyProtected
                  ? "PARTIAL"
                  : "UNPROTECTED"}
            </div>
          </div>

          <div style={styles.protectionGrid}>
            <ProtectionMetric
              label="Stop"
              value={position.stop > 0 ? price(position.stop) : "—"}
              tone={stopTone}
            />
            <ProtectionMetric
              label="Target"
              value={position.target > 0 ? price(position.target) : "—"}
              tone={targetTone}
            />
          </div>

          <div style={styles.protectionNote}>
            {hasWorkingOrder && protectionOwner === "server"
              ? "This accepted order is protected by the AutoTrade server. Entry, stop, target, shares, risk, and reward stay visible here while the entry waits to fill."
              : hasWorkingOrder
                ? "These are the accepted Alpaca order levels. After the entry fills, this panel automatically switches to live position P/L and remaining risk/reward."
                : protectionOwner === "server"
                  ? "The AutoTrade server owns this position's synthetic stop and target protection."
                  : liveStop || liveTarget
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

      {hasLivePosition && protectionOwner === "alpaca" && (
        <div style={styles.extCard}>
          <div style={styles.extCardCopy}>
            <strong>Hold Through Extended Hours</strong>
            <span>
              Transfer this position from the native Alpaca bracket to the
              server-managed EXT stop/target so it can remain protected after
              4:00 PM and in pre-market.
            </span>
          </div>
          <button
            type="button"
            style={{
              ...styles.extButton,
              ...disabledStyle(
                !canConvertToExtendedProtection ||
                  extendedProtectionLoading ||
                  !fullyProtected,
              ),
            }}
            disabled={
              !canConvertToExtendedProtection ||
              extendedProtectionLoading ||
              !fullyProtected
            }
            onClick={() => {
              const confirmed = window.confirm(
                `Convert ${position.symbol} to EXT protection?\n\n` +
                  `Shares: ${position.shares}\n` +
                  `Stop: ${price(position.stop)}\n` +
                  `Target: ${price(position.target)}\n\n` +
                  "This will cancel the existing Alpaca closing/bracket orders for this symbol and transfer the same stop and target to the server-managed extended-hours protection worker.",
              );
              if (!confirmed) return;
              void onConvertToExtendedProtection?.();
            }}
            title={
              fullyProtected
                ? "Cancel the regular-hours Alpaca bracket exits and transfer these levels to server-managed extended-hours protection."
                : "A live stop and target are required before converting to EXT protection."
            }
          >
            {extendedProtectionLoading ? "Converting…" : "Convert to EXT"}
          </button>
        </div>
      )}

      {hasLivePosition && protectionOwner === "server" && (
        <div style={styles.extProtectedBanner}>
          <strong>EXT PROTECTED</strong>
          <span>After-hours · Overnight · Pre-market</span>
        </div>
      )}

      <div style={styles.tabs}>
        <SideButton
          active={position.side === "long"}
          label="Long"
          side="long"
          disabled={hasManagedTrade}
          onClick={() => onChange({ side: "long" })}
        />
        <SideButton
          active={position.side === "short"}
          label="Short"
          side="short"
          disabled={hasManagedTrade}
          onClick={() => onChange({ side: "short" })}
        />
      </div>

      <div style={styles.mainGrid}>
        <Metric label="Entry" value={position.entry > 0 ? price(position.entry) : "—"} />
        <Metric label="Current" value={currentPrice > 0 ? price(currentPrice) : "—"} />
        <Metric
          label="Open P/L"
          value={hasLivePosition ? `${pnlPositive ? "+" : ""}${money(stats.unrealizedPnl)}` : "—"}
          good={hasLivePosition && pnlPositive}
          danger={hasLivePosition && !pnlPositive}
        />
        <Metric
          label={hasWorkingOrder ? "Planned R:R" : "Current R"}
          value={
            hasWorkingOrder && plannedRiskPerShare > 0
              ? `${plannedRMultiple.toFixed(2)}R`
              : hasLivePosition
                ? `${stats.currentR.toFixed(2)}R`
                : "—"
          }
        />
        <Metric
          label={hasWorkingOrder ? "Planned Risk" : "Risk Left"}
          value={
            hasWorkingOrder && position.stop > 0
              ? money(plannedRisk)
              : hasLivePosition && position.stop > 0
                ? money(riskRemaining)
                : "—"
          }
          danger={hasManagedTrade && position.stop > 0}
        />
        <Metric
          label={hasWorkingOrder ? "Planned Reward" : "Reward Left"}
          value={
            hasWorkingOrder && position.target > 0
              ? money(plannedReward)
              : hasLivePosition && position.target > 0
                ? money(rewardRemaining)
                : "—"
          }
          good={hasManagedTrade && position.target > 0}
        />
      </div>

      <div style={styles.grid}>
        <Field
          label="Shares"
          value={position.shares}
          disabled={hasManagedTrade}
          onChange={(shares) => onChange({ shares })}
        />
        <Field
          label="Entry"
          value={position.entry}
          disabled={hasManagedTrade}
          onChange={(entry) => onChange({ entry })}
        />
        <Field
          label={`Target · ${protectionLabel(targetTone)}`}
          value={position.target}
          disabled={executionLoading || hasWorkingOrder || protectionOwner === "server"}
          tone={targetTone}
          onChange={(target) => onChange({ target })}
        />
        <Field
          label={`Stop · ${protectionLabel(stopTone)}`}
          value={position.stop}
          disabled={executionLoading || hasWorkingOrder || protectionOwner === "server"}
          tone={stopTone}
          onChange={(stop) => onChange({ stop })}
        />
      </div>

      <div style={styles.progressWrap}>
        <div style={styles.progressHeader}>
          <span>Target Progress</span>
          <strong>
            {hasLivePosition && position.target > 0
              ? `${stats.progressToTarget.toFixed(0)}%`
              : "—"}
          </strong>
        </div>

        <div style={styles.progressTrack}>
          <div
            style={{
              ...styles.progressFill,
              width: `${hasLivePosition && position.target > 0 ? stats.progressToTarget : 0}%`,
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
            ...disabledStyle(
              controlsDisabled ||
                !hasStopValue ||
                (!liveStop && protectionOwner !== "server"),
            ),
          }}
          disabled={
            controlsDisabled ||
            !hasStopValue ||
            (!liveStop && protectionOwner !== "server")
          }
          onClick={() => void onMoveStopToBreakEven()}
          title={
            protectionOwner === "server"
              ? "Move the server-managed Overnight Protected stop to the actual entry price."
              : liveStop
                ? "Replace the live Alpaca stop order at the average entry price."
                : "A live protective stop is required."
          }
        >
          Break Even
        </button>

        <button
          type="button"
          style={{
            ...styles.actionButton,
            ...disabledStyle(
              controlsDisabled ||
                !hasStopValue ||
                (!liveStop && protectionOwner !== "server"),
            ),
          }}
          disabled={
            controlsDisabled ||
            !hasStopValue ||
            (!liveStop && protectionOwner !== "server")
          }
          onClick={() => {
            const raw = window.prompt(
              protectionOwner === "server"
                ? "New server-protected stop price"
                : "New live Alpaca stop price",
              String(position.stop || ""),
            );
            if (raw == null) return;
            const next = Number(raw.trim());
            if (!Number.isFinite(next) || next <= 0) {
              window.alert("Enter a valid stop price greater than zero.");
              return;
            }
            void onEditStop?.(next);
          }}
          title={
            protectionOwner === "server"
              ? "Change the server worker's synthetic stop without detaching protection."
              : "Replace the active Alpaca stop order."
          }
        >
          Edit Live Stop
        </button>

        <button
          type="button"
          style={{
            ...styles.actionButton,
            ...disabledStyle(
              controlsDisabled ||
                protectionOwner !== "server" ||
                !hasStopValue,
            ),
          }}
          disabled={
            controlsDisabled ||
            protectionOwner !== "server" ||
            !hasStopValue
          }
          onClick={() => void onToggleTrailingStop?.()}
          title={
            protectionOwner === "server"
              ? trailEnabled
                ? "Stop server-side trailing and keep the latest raised stop."
                : "Start a server-side trail using the current stop-to-market distance."
              : "Server trailing is available for Overnight Protected Orders."
          }
        >
          {trailEnabled ? "Stop Trail" : "Trail Stop"}
        </button>

        <button
          type="button"
          style={{ ...styles.flattenButton, ...disabledStyle(controlsDisabled) }}
          disabled={controlsDisabled}
          onClick={() => {
            const confirmed = window.confirm(
              "Flatten ALL live positions in this Alpaca account? This affects every symbol, not only the chart symbol.",
            );
            if (!confirmed) return;
            void onFlattenAllPositions?.();
          }}
        >
          Flatten All
        </button>
      </div>

      <div style={styles.footer}>
        Accepted orders populate this manager before fill. After fill, shares
        and entry synchronize from Alpaca and the panel switches to live
        position risk, reward, P/L, and protection state. Server-protected
        positions keep scale-out, close, break-even, edit-stop, and trail
        actions attached to the Overnight Protected worker.
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
  extCard: {
    display: "grid",
    gap: 10,
    marginTop: 12,
    padding: 12,
    borderRadius: 12,
    border: "1px solid rgba(34,211,238,.32)",
    background: "rgba(8,145,178,.09)",
  },
  extCardCopy: {
    display: "grid",
    gap: 4,
    color: "#e2e8f0",
    fontSize: 11,
    lineHeight: 1.35,
  },
  extButton: {
    width: "100%",
    borderRadius: 10,
    border: "1px solid rgba(34,211,238,.55)",
    background: "rgba(8,145,178,.22)",
    color: "#cffafe",
    padding: "10px 12px",
    fontWeight: 800,
    cursor: "pointer",
  },
  extProtectedBanner: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
    marginTop: 12,
    padding: "9px 11px",
    borderRadius: 10,
    border: "1px solid rgba(34,211,238,.42)",
    background: "rgba(8,145,178,.14)",
    color: "#a5f3fc",
    fontSize: 10,
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