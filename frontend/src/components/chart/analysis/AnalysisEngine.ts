import type { CleanBar } from "../ChartTypes";
import { buildDemandZone } from "./DemandZoneEngine";
import { buildResistancePrediction } from "./ResistancePredictionEngine";
import { buildSupportPrediction } from "./SupportPredictionEngine";
import {
  DEFAULT_FX_ANALYSIS_SETTINGS,
  type FxAnalysisResult,
  type FxAnalysisSettings,
  type FxAnalysisToolId,
} from "./AnalysisTypes";

export function buildFxAnalysisResult(
  tool: FxAnalysisToolId,
  bar: CleanBar,
  bars: CleanBar[],
  settings: FxAnalysisSettings = DEFAULT_FX_ANALYSIS_SETTINGS,
): FxAnalysisResult | null {
  if (tool === "none") return null;

  const toolSettings = settings[tool];
  if (!toolSettings?.enabled) return null;

  const input = { bar, bars, settings };

  switch (tool) {
    case "supportPrediction":
      return buildSupportPrediction(input);
    case "resistancePrediction":
      return buildResistancePrediction(input);
    case "demandZone":
      return buildDemandZone(input);
    default:
      return null;
  }
}
