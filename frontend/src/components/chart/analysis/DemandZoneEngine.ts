import { LineStyle } from "lightweight-charts";
import type { FxAnalysisInput, FxAnalysisResult } from "./AnalysisTypes";

function formatPrice(price: number): string {
  return price >= 10 ? price.toFixed(2) : price.toFixed(4);
}

function hexToRgba(hex: string, opacity: number): string {
  const clean = hex.replace("#", "");
  const full = clean.length === 3
    ? clean.split("").map((c) => c + c).join("")
    : clean;

  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return `rgba(34,197,94,${opacity})`;

  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;

  return `rgba(${r},${g},${b},${opacity})`;
}

export function buildDemandZone(input: FxAnalysisInput): FxAnalysisResult | null {
  const { bar, settings } = input;
  const toolSettings = settings.demandZone;

  // Use the full anchor candle range, including both upper and lower wicks.
  const low = Number(bar.low);
  const high = Number(bar.high);

  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low) {
    return null;
  }

  return {
    id: `fx-demand-${Number(bar.time)}`,
    tool: "demandZone",
    anchorTime: bar.time,
    anchorBar: bar,
    zone: {
      id: `fx-demand-zone-${Number(bar.time)}`,
      low,
      high,
      fillColor: hexToRgba(toolSettings.color, toolSettings.opacity),
      borderColor: toolSettings.color,
      title: `FX Demand ${formatPrice(low)} - ${formatPrice(high)}`,
      extendRight: true,
    },
    lines: [
      {
        id: `fx-demand-top-${Number(bar.time)}`,
        kind: "demandTop",
        price: high,
        color: toolSettings.color,
        title: `FX Demand Top ${formatPrice(high)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: toolSettings.lineWidth,
        showLabel: true,
        extendRight: true,
      },
      {
        id: `fx-demand-low-${Number(bar.time)}`,
        kind: "demandBottom",
        price: low,
        color: toolSettings.color,
        title: `FX Demand Low ${formatPrice(low)}`,
        lineStyle: LineStyle.Solid,
        lineWidth: toolSettings.lineWidth,
        showLabel: true,
        extendRight: true,
      },
    ],
  };
}
