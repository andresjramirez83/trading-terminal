import { LineStyle } from "lightweight-charts";
import type { FxAnalysisInput, FxAnalysisResult } from "./AnalysisTypes";

function formatPrice(price: number): string {
  return price >= 10 ? price.toFixed(2) : price.toFixed(4);
}

export function buildResistancePrediction(input: FxAnalysisInput): FxAnalysisResult | null {
  const { bar, settings } = input;
  const toolSettings = settings.resistancePrediction;
  const range = Number(bar.high) - Number(bar.low);
  const resistance = Number(bar.high) + range;

  if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(resistance) || resistance <= 0) {
    return null;
  }

  return {
    id: `fx-resistance-${Number(bar.time)}`,
    tool: "resistancePrediction",
    anchorTime: bar.time,
    anchorBar: bar,
    lines: [
      {
        id: `fx-resistance-line-${Number(bar.time)}`,
        kind: "resistance",
        price: resistance,
        color: toolSettings.color,
        title: `FX Resistance ${formatPrice(resistance)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: toolSettings.lineWidth,
        showLabel: true,
        extendRight: true,
      },
    ],
  };
}
