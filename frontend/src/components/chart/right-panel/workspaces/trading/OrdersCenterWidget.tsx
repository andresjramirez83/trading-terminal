import type { CSSProperties } from "react";
import type { AutoTradeStatus } from "../../../../../services/api";
import type {
  CurrentPositionState,
  OpenOrderState,
} from "./TradingTypes";

type OrdersCenterWidgetProps = {
  orders: OpenOrderState[];
  positions: CurrentPositionState[];
  rawPositions: any[];
  recentBrokerOrders: any[];
  autoTradeStatus: AutoTradeStatus | null;
  mode: "paper" | "live";
  onCancelOrder: (orderId: string) => void | Promise<void>;
};

type ProtectedState = {
  symbol: string;
  phase: string;
  status: string;
  entry: number;
  stop: number;
  target: number;
  qty: number;
};

const TERMINAL = new Set([
  "filled",
  "canceled",
  "cancelled",
  "expired",
  "rejected",
  "done_for_day",
  "replaced",
]);

function number(value: unknown): number {
  const next = Number(value);
  return Number.isFinite(next) ? next : 0;
}

function price(value: unknown): string {
  const amount = number(value);
  if (amount <= 0) return "—";
  return amount < 1 ? `$${amount.toFixed(4)}` : `$${amount.toFixed(2)}`;
}

function signedMoney(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const sign = amount > 0 ? "+" : "";
  return `${sign}${amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function signedPercentFromDecimal(value: unknown): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "—";
  const pct = amount * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function qty(value: unknown): string {
  const amount = Math.abs(number(value));
  if (amount <= 0) return "0";
  return Number.isInteger(amount)
    ? amount.toLocaleString()
    : amount.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function rawStatusLabel(value: unknown): string {
  const raw = String(value ?? "working").trim();
  return raw.replaceAll("_", " ").toUpperCase();
}

function formatBrokerTime(value: unknown): string {
  if (!value) return "—";
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleString([], {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case "queued":
      return "QUEUED";
    case "entry_submitted":
      return "ENTRY WAITING";
    case "entry_cancel_requested":
      return "CANCELING ENTRY";
    case "active_synthetic":
      return "PROTECTION ACTIVE";
    case "exit_submitted":
      return "FLATTENING";
    default:
      return rawStatusLabel(phase || "working");
  }
}

function buildProtectedStates(
  status: AutoTradeStatus | null,
): Map<string, ProtectedState> {
  const out = new Map<string, ProtectedState>();
  const runnerStates = status?.runner_states ?? {};

  Object.entries(runnerStates).forEach(([symbolKey, raw]) => {
    if (!raw || typeof raw !== "object") return;
    const payload = raw as Record<string, unknown>;
    const strategy = String(payload.strategy_id ?? "");
    if (
      !["overnight_protected_order", "overnite_hail_mary"].includes(strategy)
    ) {
      return;
    }

    const symbol = String(payload.symbol ?? symbolKey).trim().toUpperCase();
    if (!symbol) return;
    const phase = String(payload.phase ?? "working");

    out.set(symbol, {
      symbol,
      phase,
      status: phaseLabel(phase),
      entry: number(payload.entry_price),
      stop: number(payload.stop_price),
      target: number(payload.target_price),
      qty: number(payload.filled_qty ?? payload.qty ?? payload.fixed_shares),
    });
  });

  const plans = status?.queued_manual_plans ?? status?.manual_trade_plans ?? [];
  plans.forEach((item) => {
    const record = item && typeof item === "object"
      ? (item as Record<string, unknown>)
      : {};
    const rawPayload = record.payload;
    const payload = rawPayload && typeof rawPayload === "object"
      ? (rawPayload as Record<string, unknown>)
      : record;
    const strategy = String(record.strategy_id ?? payload.strategy_id ?? "");
    if (
      !["overnight_protected_order", "overnite_hail_mary"].includes(strategy)
    ) {
      return;
    }

    const symbol = String(record.symbol ?? payload.symbol ?? "")
      .trim()
      .toUpperCase();
    if (!symbol || out.has(symbol)) return;

    out.set(symbol, {
      symbol,
      phase: "queued",
      status: "QUEUED",
      entry: number(payload.entry_price),
      stop: number(payload.stop_price),
      target: number(payload.target_price),
      qty: number(payload.qty ?? payload.fixed_shares),
    });
  });

  return out;
}

function flattenBrokerOrders(orders: any[]): any[] {
  const out: any[] = [];
  const seen = new Set<string>();

  const visit = (order: any) => {
    if (!order || typeof order !== "object") return;
    const id = String(order.id ?? order.order_id ?? "").trim();
    if (!id || !seen.has(id)) {
      if (id) seen.add(id);
      out.push(order);
    }
    if (Array.isArray(order.legs)) {
      order.legs.forEach(visit);
    }
  };

  orders.forEach(visit);
  return out;
}

function orderTimestamp(order: any): number {
  const raw =
    order?.filled_at ??
    order?.canceled_at ??
    order?.expired_at ??
    order?.failed_at ??
    order?.updated_at ??
    order?.submitted_at;
  const parsed = raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

export default function OrdersCenterWidget({
  orders,
  positions,
  rawPositions,
  recentBrokerOrders,
  autoTradeStatus,
  mode,
  onCancelOrder,
}: OrdersCenterWidgetProps) {
  const protectedStates = buildProtectedStates(autoTradeStatus);
  const protectedRows = Array.from(protectedStates.values()).sort((a, b) =>
    a.symbol.localeCompare(b.symbol),
  );
  const pendingEntries = orders.filter(
    (order) => order.side === "buy" && (order.remainingShares ?? order.shares) > 0,
  ).length;
  const flattening = protectedRows.filter(
    (row) => row.phase === "exit_submitted",
  ).length;

  const recent = flattenBrokerOrders(recentBrokerOrders)
    .filter((order) => TERMINAL.has(String(order?.status ?? "").toLowerCase()))
    .sort((a, b) => orderTimestamp(b) - orderTimestamp(a))
    .slice(0, 8);

  return (
    <section style={styles.card}>
      <div style={styles.header}>
        <div>
          <div style={styles.kicker}>Broker Source of Truth</div>
          <div style={styles.title}>Orders Center</div>
        </div>
        <div style={styles.mode}>{mode.toUpperCase()}</div>
      </div>

      <div style={styles.summaryGrid}>
        <Summary label="Working" value={orders.length} />
        <Summary label="Pending Entries" value={pendingEntries} />
        <Summary label="Positions" value={positions.length} />
        <Summary label="Flattening" value={flattening} />
      </div>

      <SectionTitle title="All Working Orders" count={orders.length} />
      {orders.length === 0 ? (
        <Empty text="No working broker orders." />
      ) : (
        <div style={styles.list}>
          {orders.map((order) => {
            const protectedState = protectedStates.get(order.symbol);
            const filled = order.filledShares ?? 0;
            const remaining = order.remainingShares ?? Math.max(0, order.shares - filled);

            return (
              <div key={order.id} style={styles.orderCard}>
                <div style={styles.rowTop}>
                  <div>
                    <div style={styles.symbolLine}>
                      <strong>{order.symbol}</strong>
                      <span style={order.side === "buy" ? styles.buyBadge : styles.sellBadge}>
                        {order.side.toUpperCase()}
                      </span>
                      {order.extendedHours && <span style={styles.extBadge}>EXT</span>}
                    </div>
                    <div style={styles.muted}>
                      {order.type.toUpperCase()} · {rawStatusLabel(order.rawStatus ?? order.status)} · {order.createdAt}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void onCancelOrder(order.id)}
                    style={styles.cancelButton}
                  >
                    Cancel
                  </button>
                </div>

                <div style={styles.orderStats}>
                  <SmallStat label="Qty" value={qty(order.shares)} />
                  <SmallStat label="Filled" value={qty(filled)} />
                  <SmallStat label="Remaining" value={qty(remaining)} />
                </div>

                <div style={styles.levelGrid}>
                  <SmallStat
                    label="Limit"
                    value={price(order.limitPrice ?? protectedState?.entry)}
                  />
                  <SmallStat
                    label="Stop"
                    value={price(order.stopPrice ?? protectedState?.stop)}
                  />
                  <SmallStat
                    label="Target"
                    value={price(order.targetPrice ?? protectedState?.target)}
                  />
                </div>

                {protectedState && (
                  <div style={protectedState.phase === "exit_submitted" ? styles.protectedDanger : styles.protectedGood}>
                    PROTECTED OVERNIGHT · {protectedState.status}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <SectionTitle title="Open Positions" count={positions.length} />
      {positions.length === 0 ? (
        <Empty text="No open broker positions." />
      ) : (
        <div style={styles.list}>
          {positions.map((position) => {
            const protectedState = protectedStates.get(position.symbol);
            const rawPosition = rawPositions.find(
              (raw) => String(raw?.symbol ?? "").trim().toUpperCase() === position.symbol,
            );
            const unrealized = Number(rawPosition?.unrealized_pl ?? 0);
            const unrealizedPct = Number(rawPosition?.unrealized_plpc ?? 0);
            return (
              <div key={position.symbol} style={styles.positionCard}>
                <div style={styles.rowTop}>
                  <div>
                    <div style={styles.symbolLine}>
                      <strong>{position.symbol}</strong>
                      <span style={position.side === "long" ? styles.buyBadge : styles.sellBadge}>
                        {position.side.toUpperCase()}
                      </span>
                    </div>
                    <div style={styles.muted}>
                      {qty(position.shares)} shares · Avg {price(position.entry)}
                    </div>
                    <div
                      style={{
                        ...styles.positionPnl,
                        color: unrealized > 0 ? "#86efac" : unrealized < 0 ? "#fca5a5" : "#cbd5e1",
                      }}
                    >
                      Unrealized {signedMoney(unrealized)} · {signedPercentFromDecimal(unrealizedPct)}
                    </div>
                  </div>
                  {protectedState && (
                    <span style={protectedState.phase === "exit_submitted" ? styles.flattenBadge : styles.protectedBadge}>
                      {protectedState.status}
                    </span>
                  )}
                </div>
                {protectedState && (
                  <div style={styles.levelGrid}>
                    <SmallStat label="Protected Entry" value={price(protectedState.entry)} />
                    <SmallStat label="Stop" value={price(protectedState.stop)} />
                    <SmallStat label="Target" value={price(protectedState.target)} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {protectedRows.some(
        (row) => !orders.some((order) => order.symbol === row.symbol) &&
          !positions.some((position) => position.symbol === row.symbol),
      ) && (
        <>
          <SectionTitle title="Protected Overnight Queue" count={protectedRows.length} />
          <div style={styles.list}>
            {protectedRows
              .filter(
                (row) =>
                  !orders.some((order) => order.symbol === row.symbol) &&
                  !positions.some((position) => position.symbol === row.symbol),
              )
              .map((row) => (
                <div key={`${row.symbol}:${row.phase}`} style={styles.positionCard}>
                  <div style={styles.rowTop}>
                    <strong>{row.symbol}</strong>
                    <span style={styles.protectedBadge}>{row.status}</span>
                  </div>
                  <div style={styles.levelGrid}>
                    <SmallStat label="Entry" value={price(row.entry)} />
                    <SmallStat label="Stop" value={price(row.stop)} />
                    <SmallStat label="Target" value={price(row.target)} />
                  </div>
                </div>
              ))}
          </div>
        </>
      )}

      <SectionTitle title="Recent Broker Activity" count={recent.length} />
      {recent.length === 0 ? (
        <Empty text="No recent filled, canceled, expired, or rejected orders." />
      ) : (
        <div style={styles.activityList}>
          {recent.map((order, index) => {
            const status = String(order?.status ?? "unknown").toLowerCase();
            const fillPrice = number(order?.filled_avg_price ?? order?.average_fill_price);
            const filledQty = number(order?.filled_qty);
            const symbol = String(order?.symbol ?? "—").toUpperCase();
            return (
              <div key={`${String(order?.id ?? index)}:${index}`} style={styles.activityRow}>
                <div>
                  <strong>{symbol}</strong>{" "}
                  <span style={styles.activityStatus}>{rawStatusLabel(status)}</span>
                  <div style={styles.muted}>
                    {String(order?.side ?? "").toUpperCase()} {qty(filledQty || order?.qty)}
                    {fillPrice > 0 ? ` @ ${price(fillPrice)}` : ""}
                  </div>
                </div>
                <span style={styles.activityTime}>
                  {formatBrokerTime(
                    order?.filled_at ?? order?.canceled_at ?? order?.updated_at ?? order?.submitted_at,
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <div style={styles.footer}>
        Working orders and positions are rebuilt from Alpaca on every refresh, so changing symbols, reloading, or using another device does not hide them.
      </div>
    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <div style={styles.summary}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.smallStat}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SectionTitle({ title, count }: { title: string; count: number }) {
  return (
    <div style={styles.sectionTitle}>
      <span>{title}</span>
      <strong>{count}</strong>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div style={styles.empty}>{text}</div>;
}

const styles: Record<string, CSSProperties> = {
  card: {
    display: "grid",
    gap: 10,
    border: "1px solid rgba(96,165,250,.28)",
    borderRadius: 18,
    padding: 12,
    background: "linear-gradient(180deg, rgba(15,23,42,.97), rgba(2,6,23,.97))",
  },
  header: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 },
  kicker: { fontSize: 9, color: "#60a5fa", fontWeight: 900, letterSpacing: 0.9, textTransform: "uppercase" },
  title: { marginTop: 2, fontSize: 17, fontWeight: 950, color: "#f8fafc" },
  mode: { border: "1px solid rgba(96,165,250,.38)", background: "rgba(37,99,235,.14)", color: "#bfdbfe", borderRadius: 999, padding: "4px 8px", fontSize: 9, fontWeight: 900 },
  summaryGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 },
  summary: { display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, border: "1px solid rgba(148,163,184,.14)", borderRadius: 10, background: "rgba(15,23,42,.72)", padding: "8px 9px", color: "#94a3b8", fontSize: 9 },
  sectionTitle: { marginTop: 4, display: "flex", justifyContent: "space-between", color: "#cbd5e1", fontSize: 10, fontWeight: 900, textTransform: "uppercase", letterSpacing: 0.6 },
  list: { display: "grid", gap: 8 },
  orderCard: { border: "1px solid rgba(148,163,184,.16)", borderRadius: 12, padding: 9, background: "rgba(2,6,23,.52)" },
  positionCard: { border: "1px solid rgba(148,163,184,.16)", borderRadius: 12, padding: 9, background: "rgba(15,23,42,.55)" },
  rowTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 },
  symbolLine: { display: "flex", alignItems: "center", gap: 6, color: "#f8fafc", fontSize: 12 },
  buyBadge: { border: "1px solid rgba(34,197,94,.35)", background: "rgba(22,163,74,.12)", color: "#86efac", borderRadius: 999, padding: "2px 5px", fontSize: 8, fontWeight: 900 },
  sellBadge: { border: "1px solid rgba(239,68,68,.35)", background: "rgba(127,29,29,.14)", color: "#fecaca", borderRadius: 999, padding: "2px 5px", fontSize: 8, fontWeight: 900 },
  extBadge: { border: "1px solid rgba(250,204,21,.3)", color: "#fde68a", borderRadius: 999, padding: "2px 5px", fontSize: 8, fontWeight: 900 },
  protectedBadge: { border: "1px solid rgba(34,197,94,.34)", background: "rgba(22,163,74,.1)", color: "#bbf7d0", borderRadius: 999, padding: "3px 6px", fontSize: 8, fontWeight: 900, whiteSpace: "nowrap" },
  flattenBadge: { border: "1px solid rgba(251,146,60,.42)", background: "rgba(154,52,18,.16)", color: "#fed7aa", borderRadius: 999, padding: "3px 6px", fontSize: 8, fontWeight: 900, whiteSpace: "nowrap" },
  protectedGood: { marginTop: 8, padding: "5px 7px", borderRadius: 8, background: "rgba(22,163,74,.1)", border: "1px solid rgba(34,197,94,.22)", color: "#bbf7d0", fontSize: 8, fontWeight: 900 },
  protectedDanger: { marginTop: 8, padding: "5px 7px", borderRadius: 8, background: "rgba(154,52,18,.15)", border: "1px solid rgba(251,146,60,.3)", color: "#fed7aa", fontSize: 8, fontWeight: 900 },
  muted: { marginTop: 3, color: "#64748b", fontSize: 9, lineHeight: 1.35 },
  positionPnl: { marginTop: 4, fontSize: 9, fontWeight: 900 },
  cancelButton: { border: "1px solid rgba(248,113,113,.35)", background: "rgba(127,29,29,.16)", color: "#fecaca", borderRadius: 8, padding: "5px 7px", fontSize: 9, fontWeight: 900, cursor: "pointer" },
  orderStats: { marginTop: 7, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 },
  levelGrid: { marginTop: 6, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 5 },
  smallStat: { display: "grid", gap: 2, padding: "5px 6px", borderRadius: 8, border: "1px solid rgba(148,163,184,.12)", background: "rgba(15,23,42,.65)", color: "#64748b", fontSize: 8, minWidth: 0 },
  empty: { border: "1px dashed rgba(148,163,184,.2)", borderRadius: 10, padding: 10, textAlign: "center", color: "#64748b", fontSize: 10 },
  activityList: { display: "grid", gap: 4 },
  activityRow: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 7px", borderRadius: 8, background: "rgba(15,23,42,.52)", color: "#cbd5e1", fontSize: 9 },
  activityStatus: { color: "#94a3b8", fontSize: 8, fontWeight: 900 },
  activityTime: { color: "#64748b", fontSize: 8, whiteSpace: "nowrap" },
  footer: { paddingTop: 2, color: "#64748b", fontSize: 9, lineHeight: 1.4 },
};
