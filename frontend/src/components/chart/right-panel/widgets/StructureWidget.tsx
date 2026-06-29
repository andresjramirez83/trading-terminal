import ScoreCard from "../components/ScoreCard";
import { useDecisionCenter } from "../DecisionCenterContext";

function buildSubtitle(
  score: number,
  badge: string,
  existingSubtitle?: string
): string {
  if (existingSubtitle && existingSubtitle.trim().length > 0) {
    return existingSubtitle;
  }

  switch (badge) {
    case "Bullish":
      if (score >= 85) return "Strong bullish structure with continuation potential.";
      if (score >= 70) return "Bullish structure remains intact.";
      return "Bullish bias, but monitor for weakness.";

    case "Bearish":
      if (score >= 85) return "Strong bearish structure with downside control.";
      if (score >= 70) return "Bearish structure remains intact.";
      return "Bearish bias, but sellers are weakening.";

    default:
      if (score >= 70) return "Structure improving but awaiting confirmation.";
      if (score >= 50) return "Balanced market structure.";
      return "Structure is weak and lacks directional conviction.";
  }
}

export default function StructureWidget() {
  const { structure } = useDecisionCenter();

  return (
    <ScoreCard
      title="Market Structure"
      score={structure.score}
      subtitle={buildSubtitle(
        structure.score,
        structure.badge,
        structure.subtitle
      )}
      badge={structure.badge}
      tone={structure.tone}
    />
  );
}