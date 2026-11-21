import CollapsibleCard from "./CollapsibleCard";
import DecisionEngineWidget from "../widgets/DecisionEngineWidget";
import MarketStoryWidget from "../widgets/MarketStoryWidget";
import MarketObjectsWidget from "../widgets/MarketObjectsWidget";
import LiquidityWidget from "../widgets/LiquidityWidget";
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

      <CollapsibleCard workspace="chart" id="DecisionEngineWidget" title="Decision Engine"><DecisionEngineWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="MarketStoryWidget" title="Market Story"><MarketStoryWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="MarketObjectsWidget" title="Market Objects"><MarketObjectsWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="LiquidityWidget" title="Liquidity"><LiquidityWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="TradeReadinessWidget" title="Trade Readiness"><TradeReadinessWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="PerformanceIndicatorsWidget" title="Performance Indicators"><PerformanceIndicatorsWidget /></CollapsibleCard>

      {/* ==========================================================
          Market Analysis
      ========================================================== */}

      <CollapsibleCard workspace="chart" id="StructureWidget" title="Structure"><StructureWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="MomentumWidget" title="Momentum"><MomentumWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="CompressionWidget" title="Compression"><CompressionWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="TrendStrengthWidget" title="Trend Strength"><TrendStrengthWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="BalanceWidget" title="Balance"><BalanceWidget /></CollapsibleCard>

      {/* ==========================================================
          Trade Analysis
      ========================================================== */}

      <CollapsibleCard workspace="chart" id="EntryQualityWidget" title="Entry Quality"><EntryQualityWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="RiskWidget" title="Risk"><RiskWidget /></CollapsibleCard>

      {/* ==========================================================
          Reference
      ========================================================== */}

      <CollapsibleCard workspace="chart" id="VWAPWidget" title="VWAP"><VWAPWidget /></CollapsibleCard>

      <CollapsibleCard workspace="chart" id="KeyStatsWidget" title="Key Stats"><KeyStatsWidget /></CollapsibleCard>
    </div>
  );
}
