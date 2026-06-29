import PanelCard from "../components/PanelCard";
import { useDecisionCenter } from "../DecisionCenterContext";

function StatBox({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div
      style={{
        background: "#020617",
        border: "1px solid rgba(255,255,255,.06)",
        borderRadius: 8,
        padding: 8,
      }}
    >
      <div
        style={{
          fontSize: 11,
          color: "#64748b",
          marginBottom: 4,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 13,
          fontWeight: 800,
          color: "#f8fafc",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function formatNumber(value: unknown, digits = 2): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";
  return value.toFixed(digits);
}

function formatVolume(value: unknown): string {
  if (typeof value !== "number" || Number.isNaN(value)) return "--";

  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;

  return Math.round(value).toString();
}

export default function KeyStatsWidget() {
  const { state } = useDecisionCenter();

  const stats = state.keyStats ?? {};

  return (
    <PanelCard title="Key Statistics">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 8,
        }}
      >
        <StatBox
          label="Price"
          value={`$${formatNumber(stats.price)}`}
        />

        <StatBox
          label="Range"
          value={formatNumber(stats.range)}
        />

        <StatBox
          label="Volume"
          value={formatVolume(stats.volume)}
        />

        <StatBox
          label="ATR"
          value={formatNumber(stats.atr)}
        />

        <StatBox
          label="VWAP Δ"
          value={formatNumber(stats.vwapDistance)}
        />

        <StatBox
          label="R:R"
          value={stats.rr ?? "--"}
        />
      </div>
    </PanelCard>
  );
}