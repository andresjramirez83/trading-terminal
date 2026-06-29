import HeroCard from "../components/HeroCard";
import { useDecisionCenter } from "../DecisionCenterContext";

export default function TradeReadinessWidget() {
  const decisionCenter = useDecisionCenter();

  return (
    <HeroCard
      title="Trade Readiness"
      score={decisionCenter.tradeReadiness.score}
      status={decisionCenter.tradeReadiness.status}
      items={decisionCenter.tradeReadiness.items}
    />
  );
}