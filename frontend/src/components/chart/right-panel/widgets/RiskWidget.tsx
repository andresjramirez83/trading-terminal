import PanelCard from "../components/PanelCard";
import { useDecisionCenter } from "../DecisionCenterContext";

function getToneColor(tone: "good" | "warn" | "bad") {
  if (tone === "good") return "#22c55e";
  if (tone === "bad") return "#ef4444";
  return "#f59e0b";
}

function PlanBox({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 9,
        borderRadius: 9,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "#94a3b8",
          textTransform: "uppercase",
          marginBottom: 5,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 14,
          fontWeight: 900,
          color: "#f8fafc",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

export default function RiskWidget() {
  const { state } = useDecisionCenter();
  const risk = state.risk;

  return (
    <PanelCard title="Risk">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div>
            <div
              style={{
                fontSize: 30,
                fontWeight: 900,
                color: getToneColor(risk.tone),
                lineHeight: 1,
              }}
            >
              {risk.score}
            </div>

            <div style={{ marginTop: 4, fontSize: 12, color: "#cbd5e1" }}>
              {risk.badge}
            </div>
          </div>

          <div
            style={{
              padding: "6px 10px",
              borderRadius: 999,
              background: `${getToneColor(risk.tone)}22`,
              color: getToneColor(risk.tone),
              fontSize: 11,
              fontWeight: 700,
              height: "fit-content",
            }}
          >
            Risk Profile
          </div>
        </div>

        <div style={{ fontSize: 12, color: "#cbd5e1", lineHeight: 1.45 }}>
          {risk.subtitle}
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          <PlanBox label="Stop" value={risk.stopDistance} />
          <PlanBox label="Target" value={risk.targetDistance} />
          <PlanBox label="R:R" value={risk.expectedRR} />
        </div>
      </div>
    </PanelCard>
  );
}