import PanelCard from "../components/PanelCard";
import { useDecisionCenter } from "../DecisionCenterContext";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function price(value: unknown): string {
  return finite(value) ? `$${value.toFixed(value < 1 ? 4 : 2)}` : "—";
}

export default function LiquidityWidget() {
  const { report } = useDecisionCenter();
  const liquidity = record(report?.context.input?.metadata?.liquidity);
  const eventType = liquidity.eventType;
  const eventSide = liquidity.eventSide;
  const touches = finite(liquidity.eventTouches) ? liquidity.eventTouches : 0;

  const headline =
    eventType === "sweep"
      ? eventSide === "sell-side"
        ? "Sell-Side Sweep Reclaimed"
        : "Buy-Side Sweep Rejected"
      : eventType === "break"
        ? eventSide === "sell-side"
          ? "Sell-Side Liquidity Broken"
          : "Buy-Side Liquidity Broken"
        : "Liquidity Pools Forming";
  const color =
    eventType === "sweep"
      ? eventSide === "sell-side"
        ? "#22c55e"
        : "#ef4444"
      : eventType === "break"
        ? eventSide === "buy-side"
          ? "#22c55e"
          : "#ef4444"
        : "#38bdf8";

  return (
    <PanelCard title="Liquidity">
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <div
          style={{
            padding: 10,
            borderRadius: 10,
            border: `1px solid ${color}55`,
            background: `${color}12`,
            color,
            fontSize: 12,
            fontWeight: 850,
          }}
        >
          {headline}
          {eventType && finite(liquidity.eventPrice) ? (
            <div style={{ marginTop: 4, color: "#cbd5e1", fontSize: 10 }}>
              {price(liquidity.eventPrice)} · {touches || 1} touch
              {(touches || 1) === 1 ? "" : "es"} · {String(liquidity.eventSource ?? "structure")}
            </div>
          ) : null}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <Level label="Buy-side above" value={price(liquidity.nearestLiquidityAbove)} />
          <Level label="Sell-side below" value={price(liquidity.nearestLiquidityBelow)} />
        </div>

        <div style={{ color: "#64748b", fontSize: 10, lineHeight: 1.4 }}>
          Pools require at least 2 separated touches. A wick through and close back is a sweep; a close through is a break.
        </div>
      </div>
    </PanelCard>
  );
}

function Level({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 8,
        borderRadius: 9,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div style={{ color: "#94a3b8", fontSize: 9, fontWeight: 750 }}>{label}</div>
      <div style={{ color: "#e2e8f0", fontSize: 14, fontWeight: 900, marginTop: 3 }}>{value}</div>
    </div>
  );
}
