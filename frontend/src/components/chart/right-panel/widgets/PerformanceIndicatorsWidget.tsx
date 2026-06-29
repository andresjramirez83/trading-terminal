import PanelCard from "../components/PanelCard";
import StatusGrid from "../components/StatusGrid";
import { useDecisionCenter } from "../DecisionCenterContext";

function grade(score: number): string {
  if (score >= 95) return "A+";
  if (score >= 90) return "A";
  if (score >= 85) return "A-";
  if (score >= 80) return "B+";
  if (score >= 75) return "B";
  if (score >= 70) return "B-";
  if (score >= 65) return "C+";
  if (score >= 60) return "C";
  return "D";
}

function tone(score: number): "good" | "warn" | "bad" {
  if (score >= 75) return "good";
  if (score >= 50) return "warn";
  return "bad";
}

export default function PerformanceIndicatorsWidget() {
  const { state } = useDecisionCenter();

  const trend = state?.momentum?.score ?? 50;
  const momentum = state?.momentum?.score ?? 50;
  const compression = state?.compression?.score ?? 50;
  const structure = state?.structure?.score ?? 50;

  const overall = Math.round((trend + momentum + compression + structure) / 4);

  return (
    <PanelCard title="Market Health">
      <StatusGrid
        items={[
          {
            label: "Overall",
            value: `${grade(overall)} (${overall})`,
            tone: tone(overall),
          },
          {
            label: "Trend",
            value: `${trend}%`,
            tone: tone(trend),
          },
          {
            label: "Momentum",
            value: `${momentum}%`,
            tone: tone(momentum),
          },
          {
            label: "Structure",
            value: `${structure}%`,
            tone: tone(structure),
          },
          {
            label: "Compression",
            value:
              compression >= 70
                ? "Expanding"
                : compression >= 45
                ? "Neutral"
                : "Compressed",
            tone: tone(compression),
          },
        ]}
      />
    </PanelCard>
  );
}