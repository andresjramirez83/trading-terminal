import PanelCard from "../components/PanelCard";
import { useDecisionCenter } from "../DecisionCenterContext";

function getToneColor(tone: "good" | "warn" | "bad"): string {
  if (tone === "good") return "#22c55e";
  if (tone === "bad") return "#ef4444";
  return "#f59e0b";
}

export default function DecisionEngineWidget() {
  const { state } = useDecisionCenter();

  const decision = state.ai;

  return (
    <PanelCard title="Decision Engine">
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div
          style={{
            textAlign: "center",
            padding: "14px 10px",
            borderRadius: 12,
            background: "rgba(255,255,255,0.04)",
            border: `1px solid ${getToneColor(decision.tone)}55`,
          }}
        >
          <div
            style={{
              fontSize: 11,
              fontWeight: 800,
              letterSpacing: "0.08em",
              color: "#94a3b8",
              textTransform: "uppercase",
              marginBottom: 6,
            }}
          >
            Recommended Action
          </div>

          <div
            style={{
              fontSize: 34,
              fontWeight: 950,
              lineHeight: 1,
              color: getToneColor(decision.tone),
              letterSpacing: "0.06em",
            }}
          >
            {decision.action}
          </div>

          <div
            style={{
              marginTop: 8,
              fontSize: 12,
              fontWeight: 700,
              color: "#cbd5e1",
            }}
          >
            Confidence {decision.confidence}%
          </div>
        </div>

        <div
          style={{
            height: 8,
            borderRadius: 999,
            background: "rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: `${Math.max(0, Math.min(100, decision.confidence))}%`,
              height: "100%",
              borderRadius: 999,
              background: getToneColor(decision.tone),
            }}
          />
        </div>

        <div
          style={{
            padding: 10,
            borderRadius: 10,
            background: "rgba(255,255,255,0.035)",
            border: "1px solid rgba(255,255,255,0.06)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              fontWeight: 800,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "#94a3b8",
              marginBottom: 6,
            }}
          >
            Primary Reason
          </div>

          <div
            style={{
              fontSize: 12,
              lineHeight: 1.45,
              color: "#e2e8f0",
            }}
          >
            {decision.reason}
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <MiniStat label="Trend" value={state.trendStrength.score} />
          <MiniStat label="Balance" value={state.balance.score} />
          <MiniStat label="Entry" value={state.entryQuality.score} />
          <MiniStat label="Risk" value={state.risk.score} />
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          <PlanBox label="Stop" value={state.risk.stopDistance} />
          <PlanBox label="Target" value={state.risk.targetDistance} />
          <PlanBox label="R:R" value={state.risk.expectedRR} />
        </div>
      </div>
    </PanelCard>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  const tone = value >= 70 ? "good" : value >= 45 ? "warn" : "bad";

  return (
    <div
      style={{
        padding: 8,
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
          marginBottom: 4,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 16,
          fontWeight: 900,
          color: getToneColor(tone),
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function PlanBox({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: 8,
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
          marginBottom: 4,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 13,
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