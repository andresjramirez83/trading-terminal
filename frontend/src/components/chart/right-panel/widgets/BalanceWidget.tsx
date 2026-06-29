import PanelCard from "../components/PanelCard";
import { useDecisionCenter } from "../DecisionCenterContext";

function getToneColor(tone: "good" | "warn" | "bad") {
  if (tone === "good") return "#22c55e";
  if (tone === "bad") return "#ef4444";
  return "#f59e0b";
}

function MetricBar({ label, value }: { label: string; value: number }) {
  const safe = Math.max(0, Math.min(100, value));
  const tone = safe >= 70 ? "good" : safe >= 45 ? "warn" : "bad";

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "90px 1fr 38px",
        gap: 8,
        alignItems: "center",
      }}
    >
      <div style={{ fontSize: 11, color: "#94a3b8" }}>{label}</div>

      <div
        style={{
          height: 7,
          borderRadius: 999,
          background: "rgba(255,255,255,.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${safe}%`,
            height: "100%",
            borderRadius: 999,
            background: getToneColor(tone),
          }}
        />
      </div>

      <div
        style={{
          textAlign: "right",
          fontSize: 11,
          fontWeight: 700,
          color: "#f8fafc",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {safe}
      </div>
    </div>
  );
}

export default function BalanceWidget() {
  const { state } = useDecisionCenter();
  const balance = state.balance;

  return (
    <PanelCard title="Balance">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 900,
                color: getToneColor(balance.tone),
                lineHeight: 1,
              }}
            >
              {balance.score}
            </div>

            <div style={{ marginTop: 4, fontSize: 12, color: "#cbd5e1" }}>
              {balance.badge}
            </div>
          </div>

          <div
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              background: `${getToneColor(balance.tone)}22`,
              color: getToneColor(balance.tone),
              fontSize: 11,
              fontWeight: 700,
              height: "fit-content",
            }}
          >
            Market State
          </div>
        </div>

        <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.45 }}>
          {balance.subtitle}
        </div>

        <MetricBar label="Buyers" value={balance.buyers} />
        <MetricBar label="Sellers" value={balance.sellers} />
        <MetricBar label="Equilibrium" value={balance.equilibrium} />
      </div>
    </PanelCard>
  );
}