import { LineStyle } from "lightweight-charts";
import type { FxAnalysisInput, FxAnalysisResult } from "./AnalysisTypes";

function formatPrice(price: number): string {
  return price >= 10 ? price.toFixed(2) : price.toFixed(4);
}

export function buildSupportPrediction(input: FxAnalysisInput): FxAnalysisResult | null {
  const { bar, settings } = input;
  const toolSettings = settings.supportPrediction;
  const range = Number(bar.high) - Number(bar.low);
  const support = Number(bar.low) - range;

  if (!Number.isFinite(range) || range <= 0 || !Number.isFinite(support) || support <= 0) {
    return null;
  }

  return {
    id: `fx-support-${Number(bar.time)}`,
    tool: "supportPrediction",
    anchorTime: bar.time,
    anchorBar: bar,
    lines: [
      {
        id: `fx-support-line-${Number(bar.time)}`,
        kind: "support",
        price: support,
        color: toolSettings.color,
        title: `FX Support ${formatPrice(support)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: toolSettings.lineWidth,
        showLabel: true,
        extendRight: true,
      },
    ],
  };
}
