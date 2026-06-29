import { useDecisionCenter } from "../DecisionCenterContext";

function getToneColor(tone: "good" | "warn" | "bad"): string {
  if (tone === "good") return "#22c55e";
  if (tone === "bad") return "#ef4444";
  return "#f59e0b";
}

function getMomentumTone(score: number): "good" | "warn" | "bad" {
  if (score >= 70) return "good";
  if (score <= 40) return "bad";
  return "warn";
}

function ScoreBar({ value }: { value: number }) {
  const safeValue = Math.max(0, Math.min(100, value));
  const tone = getMomentumTone(safeValue);

  return (
    <div
      style={{
        width: "100%",
        height: 6,
        borderRadius: 999,
        background: "rgba(255,255,255,0.08)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${safeValue}%`,
          height: "100%",
          borderRadius: 999,
          background: getToneColor(tone),
        }}
      />
    </div>
  );
}

function MomentumRow({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "72px 1fr 36px",
        gap: 8,
        alignItems: "center",
        fontSize: 11,
      }}
    >
      <span style={{ color: "rgba(255,255,255,0.62)" }}>{label}</span>
      <ScoreBar value={value} />
      <span
        style={{
          color: "rgba(255,255,255,0.9)",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {Math.round(value)}
      </span>
    </div>
  );
}

function buildAnalysis(momentum: any): string {
  if (momentum.increasing && momentum.score >= 80)
    return "Momentum is accelerating with strong participation.";

  if (momentum.increasing)
    return "Momentum is building and buyers are gaining control.";

  if (momentum.fading && momentum.score >= 60)
    return "Momentum remains positive but is beginning to slow.";

  if (momentum.fading)
    return "Momentum is weakening. Watch for a reversal or consolidation.";

  if (momentum.score >= 70)
    return "Momentum remains healthy and supports continuation.";

  if (momentum.score <= 40)
    return "Momentum is weak with limited directional conviction.";

  return "Momentum is balanced with no clear acceleration.";
}

export default function MomentumWidget() {
  const { state } = useDecisionCenter();

  const momentum = state.momentum ?? {
    score: 50,
    status: "Neutral",
    direction: "neutral",
    ema: 50,
    vwap: 50,
    candle: 50,
    volume: 50,
    atr: 50,
    increasing: false,
    fading: false,
  };

  const tone = getMomentumTone(momentum.score);

  const badge = momentum.increasing
    ? "Accelerating"
    : momentum.fading
    ? "Fading"
    : "Stable";

  return (
    <section
      style={{
        padding: 12,
        borderRadius: 14,
        border: "1px solid rgba(255,255,255,0.09)",
        background:
          "linear-gradient(180deg, rgba(255,255,255,0.055), rgba(255,255,255,0.025))",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          marginBottom: 10,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 800,
              letterSpacing: 0.3,
              color: "rgba(255,255,255,0.92)",
            }}
          >
            Momentum
          </div>

          <div
            style={{
              marginTop: 3,
              fontSize: 11,
              color: "rgba(255,255,255,0.55)",
            }}
          >
            {momentum.status}
          </div>
        </div>

        <div style={{ textAlign: "right" }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 900,
              lineHeight: 1,
              color: getToneColor(tone),
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {Math.round(momentum.score)}
          </div>

          <div
            style={{
              marginTop: 4,
              fontSize: 10,
              fontWeight: 700,
              color: getToneColor(tone),
            }}
          >
            {badge}
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 12 }}>
        <ScoreBar value={momentum.score} />
      </div>

      <div
        style={{
          padding: 10,
          marginBottom: 12,
          borderRadius: 10,
          background: "rgba(255,255,255,0.045)",
          border: "1px solid rgba(255,255,255,0.05)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 6,
            fontSize: 11,
          }}
        >
          <span style={{ color: "rgba(255,255,255,0.58)" }}>
            Momentum State
          </span>

          <span
            style={{
              color: getToneColor(tone),
              fontWeight: 700,
              textTransform: "capitalize",
            }}
          >
            {momentum.direction}
          </span>
        </div>

        <div
          style={{
            fontSize: 11,
            lineHeight: 1.45,
            color: "rgba(255,255,255,0.75)",
          }}
        >
          {buildAnalysis(momentum)}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <MomentumRow label="EMA Trend" value={momentum.ema} />
        <MomentumRow label="VWAP" value={momentum.vwap} />
        <MomentumRow label="Candle" value={momentum.candle} />
        <MomentumRow label="Volume" value={momentum.volume} />
        <MomentumRow label="ATR" value={momentum.atr} />
      </div>
    </section>
  );
}