import DecisionEngineWidget from "../widgets/DecisionEngineWidget";
import TradeReadinessWidget from "../widgets/TradeReadinessWidget";
import PerformanceIndicatorsWidget from "../widgets/PerformanceIndicatorsWidget";
import StructureWidget from "../widgets/StructureWidget";
import MomentumWidget from "../widgets/MomentumWidget";
import CompressionWidget from "../widgets/CompressionWidget";
import TrendStrengthWidget from "../widgets/TrendStrengthWidget";
import BalanceWidget from "../widgets/BalanceWidget";
import EntryQualityWidget from "../widgets/EntryQualityWidget";
import RiskWidget from "../widgets/RiskWidget";
import VWAPWidget from "../widgets/VWAPWidget";
import KeyStatsWidget from "../widgets/KeyStatsWidget";

export default function ChartWorkspacePanel() {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      {/* ==========================================================
          Decision Engine
      ========================================================== */}

      <DecisionEngineWidget />

      <TradeReadinessWidget />

      <PerformanceIndicatorsWidget />

      {/* ==========================================================
          Market Analysis
      ========================================================== */}

      <StructureWidget />

      <MomentumWidget />

      <CompressionWidget />

      <TrendStrengthWidget />

      <BalanceWidget />

      {/* ==========================================================
          Trade Analysis
      ========================================================== */}

      <EntryQualityWidget />

      <RiskWidget />

      {/* ==========================================================
          Reference
      ========================================================== */}

      <VWAPWidget />

      <KeyStatsWidget />
    </div>
  );
}