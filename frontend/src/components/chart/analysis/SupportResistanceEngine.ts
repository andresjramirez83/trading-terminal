import { LineStyle } from "lightweight-charts";
import type { AnalysisInput, AnalysisResult } from "./AnalysisTypes";

function formatPrice(price: number): string {
  return price >= 10 ? price.toFixed(2) : price.toFixed(4);
}

function candleRange(input: AnalysisInput): number {
  const { bar } = input;
  return Math.max(0, Number(bar.high) - Number(bar.low));
}

export function buildSupportPrediction(input: AnalysisInput): AnalysisResult {
  const { bar } = input;
  const range = candleRange(input);
  const price = Number(bar.low) - range;

  return {
    id: `support-${bar.time}`,
    tool: "supportPrediction",
    anchorTime: Number(bar.time),
    lines: [
      {
        id: `support-line-${bar.time}`,
        price,
        color: "#38bdf8",
        title: `Support ${formatPrice(price)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: 2,
      },
    ],
  };
}

export function buildResistancePrediction(input: AnalysisInput): AnalysisResult {
  const { bar } = input;
  const range = candleRange(input);
  const price = Number(bar.high) + range;

  return {
    id: `resistance-${bar.time}`,
    tool: "resistancePrediction",
    anchorTime: Number(bar.time),
    lines: [
      {
        id: `resistance-line-${bar.time}`,
        price,
        color: "#ef4444",
        title: `Resistance ${formatPrice(price)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: 2,
      },
    ],
  };
}

export function buildDemandZone(input: AnalysisInput): AnalysisResult {
  const { bar } = input;
  const bodyHigh = Math.max(Number(bar.open), Number(bar.close));
  const low = Number(bar.low);
  const high = bodyHigh;

  return {
    id: `demand-${bar.time}`,
    tool: "demandZone",
    anchorTime: Number(bar.time),
    lines: [
      {
        id: `demand-top-${bar.time}`,
        price: high,
        color: "#22c55e",
        title: `Demand Top ${formatPrice(high)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: 2,
      },
      {
        id: `demand-bottom-${bar.time}`,
        price: low,
        color: "#16a34a",
        title: `Demand Low ${formatPrice(low)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: 2,
      },
    ],
    demandZone: {
      id: `demand-zone-${bar.time}`,
      low,
      high,
      color: "rgba(34,197,94,0.35)",
      title: `Demand ${formatPrice(low)} - ${formatPrice(high)}`,
    },
  };
}

export function buildAnalysisResult(tool: string, input: AnalysisInput): AnalysisResult | null {
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
