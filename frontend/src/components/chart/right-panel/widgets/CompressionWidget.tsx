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
    case "Expanding":
      if (score >= 85)
        return "Expansion is accelerating. Momentum is being confirmed by volatility.";
      if (score >= 70)
        return "Price is breaking away from balance with healthy expansion.";
      return "Expansion has begun but still needs confirmation.";

    case "Compressed":
      if (score >= 70)
        return "Energy is building. Watch for a directional breakout.";
      return "Market remains compressed with limited directional conviction.";

    case "Neutral":
    default:
      if (score >= 60)
        return "Transitioning between compression and expansion.";
      return "Balanced conditions with no significant volatility edge.";
  }
}

export default function CompressionWidget() {
  const { compression } = useDecisionCenter();

  return (
    <ScoreCard
      title="Volatility & Compression"
      score={compression.score}
      subtitle={buildSubtitle(
        compression.score,
        compression.badge,
        compression.subtitle
      )}
      badge={compression.badge}
      tone={compression.tone}
    />
  );
}