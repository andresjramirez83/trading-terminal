import { LineStyle, type Time } from "lightweight-charts";
import type { CleanBar } from "../ChartTypes";

export type FxAnalysisToolId = "none" | "supportPrediction" | "resistancePrediction" | "demandZone";

export type FxAnalysisLineKind = "support" | "resistance" | "demandTop" | "demandBottom";

export type FxAnalysisLine = {
  id: string;
  kind: FxAnalysisLineKind;
  price: number;
  color: string;
  title: string;
  lineStyle?: LineStyle;
  lineWidth?: 1 | 2 | 3 | 4;
  showLabel?: boolean;
  extendRight?: boolean;
};

export type FxDemandZone = {
  id: string;
  low: number;
  high: number;
  fillColor: string;
  borderColor: string;
  title: string;
  extendRight?: boolean;
};

export type FxAnalysisResult = {
  id: string;
  tool: FxAnalysisToolId;
  anchorTime: Time;
  anchorBar: CleanBar;
  lines: FxAnalysisLine[];
  zone?: FxDemandZone;
};

export type FxAnalysisInput = {
  bar: CleanBar;
  bars: CleanBar[];
  settings: FxAnalysisSettings;
};

export type FxToolSettings = {
  enabled: boolean;
  saveWithSymbol: boolean;
  extendRight: boolean;
  showLabels: boolean;
  showLine: boolean;
  color: string;
  lineWidth: 1 | 2 | 3 | 4;
  opacity: number;
  includeInAutoScale: boolean;
};

export type FxAnalysisSettings = {
  supportPrediction: FxToolSettings;
  resistancePrediction: FxToolSettings;
  demandZone: FxToolSettings;
};

export const DEFAULT_FX_ANALYSIS_SETTINGS: FxAnalysisSettings = {
  supportPrediction: {
    enabled: true,
    saveWithSymbol: true,
    extendRight: true,
    showLabels: true,
    showLine: true,
    color: "#38bdf8",
    lineWidth: 2,
    opacity: 0.18,
    includeInAutoScale: true,
  },
  resistancePrediction: {
    enabled: true,
    saveWithSymbol: true,
    extendRight: true,
    showLabels: true,
    showLine: true,
    color: "#ef4444",
    lineWidth: 2,
    opacity: 0.18,
    includeInAutoScale: true,
  },
  demandZone: {
    enabled: true,
    saveWithSymbol: true,
    extendRight: true,
    showLabels: true,
    showLine: true,
    color: "#22c55e",
    lineWidth: 2,
    opacity: 0.18,
    includeInAutoScale: true,
  },
};
