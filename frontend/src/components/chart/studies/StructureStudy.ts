// src/components/chart/studies/StructureStudy.ts

import type { Time } from "lightweight-charts";

import {
  buildMarketStructure,
  type MarketStructurePointType,
  type PendingMarketStructurePointType,
} from "../analysis/MarketStructureEngine";
import type { CleanBar } from "../ChartTypes";

export type StructureLineSide = "high" | "low";

export interface StructureStudyLine {
  id: string;
  side: StructureLineSide;
  label: MarketStructurePointType | PendingMarketStructurePointType;
  price: number;
  pointTime: Time;
  confirmationTime: Time;
  startTime: Time;
  endTime: Time;
  color: string;
  lineWidth: number;
  lineStyle: "solid" | "dashed";
  pending: boolean;
}

export interface StructureStudySettings {
  enabled: boolean;
  showHighs: boolean;
  showLows: boolean;
  maxLevels: number;
  swingStrength: number;
  bullishHighColor: string;
  bullishLowColor: string;
  bearishHighColor: string;
  bearishLowColor: string;
  lineWidth: number;
  showPending: boolean;
  pendingColor: string;
}

export const DEFAULT_STRUCTURE_STUDY_SETTINGS: StructureStudySettings = {
  enabled: true,
  showHighs: true,
  showLows: true,
  maxLevels: 24,
  swingStrength: 3,
  bullishHighColor: "#22c55e",
  bullishLowColor: "#38bdf8",
  bearishHighColor: "#f97316",
  bearishLowColor: "#ef4444",
  lineWidth: 2,
  showPending: true,
  pendingColor: "#facc15",
};

function normalizePositiveInteger(
  value: number,
  fallback: number,
  minimum = 1,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
}

export function normalizeStructureStudySettings(
  settings?: Partial<StructureStudySettings>,
): StructureStudySettings {
  return {
    ...DEFAULT_STRUCTURE_STUDY_SETTINGS,
    ...settings,
    maxLevels: normalizePositiveInteger(
      settings?.maxLevels ?? DEFAULT_STRUCTURE_STUDY_SETTINGS.maxLevels,
      DEFAULT_STRUCTURE_STUDY_SETTINGS.maxLevels,
    ),
    swingStrength: normalizePositiveInteger(
      settings?.swingStrength ?? DEFAULT_STRUCTURE_STUDY_SETTINGS.swingStrength,
      DEFAULT_STRUCTURE_STUDY_SETTINGS.swingStrength,
    ),
    lineWidth: Math.max(
      1,
      Math.min(
        4,
        Math.round(
          settings?.lineWidth ?? DEFAULT_STRUCTURE_STUDY_SETTINGS.lineWidth,
        ),
      ),
    ),
  };
}

function isHighLabel(
  label: MarketStructurePointType | PendingMarketStructurePointType,
): boolean {
  return label === "HH" || label === "LH" || label === "P-HH";
}

function getPointColor(
  label: MarketStructurePointType,
  settings: StructureStudySettings,
): string {
  switch (label) {
    case "HH":
      return settings.bullishHighColor;
    case "HL":
      return settings.bullishLowColor;
    case "LH":
      return settings.bearishHighColor;
    case "LL":
      return settings.bearishLowColor;
  }
}

export function buildStructureStudyLines(
  bars: CleanBar[],
  settingsInput?: Partial<StructureStudySettings>,
): StructureStudyLine[] {
  const settings = normalizeStructureStudySettings(settingsInput);

  if (!settings.enabled || bars.length === 0) return [];

  const structure = buildMarketStructure(bars, settings.swingStrength);
  const visiblePoints = structure.points
    .filter((point) => {
      const high = isHighLabel(point.type);
      return high ? settings.showHighs : settings.showLows;
    })
    .slice(-settings.maxLevels);

  const confirmedLines = visiblePoints.flatMap<StructureStudyLine>((point) => {
    const pointBar = bars[point.index];
    const confirmationBar = bars[point.confirmationIndex];

    if (!pointBar || !confirmationBar) return [];

    const nextIndex = Math.min(
      bars.length - 1,
      Math.max(point.index + 1, point.confirmationIndex),
    );
    const endBar = bars[nextIndex] ?? confirmationBar;

    return [{
      id: point.id,
      side: isHighLabel(point.type) ? "high" as const : "low" as const,
      label: point.type,
      price: point.price,
      pointTime: pointBar.time as Time,
      confirmationTime: confirmationBar.time as Time,
      startTime: pointBar.time as Time,
      endTime: endBar.time as Time,
      color: getPointColor(point.type, settings),
      lineWidth: settings.lineWidth,
      lineStyle: point.breakType === "choch" ? "dashed" : "solid",
      pending: false,
    }];
  });

  const pendingLines = settings.showPending
    ? structure.pendingPoints.flatMap<StructureStudyLine>((point) => {
        const pointBar = bars[point.index];
        const breakBar = bars[point.breakConfirmationIndex];
        const lastBar = bars[bars.length - 1];

        if (!pointBar || !breakBar || !lastBar) return [];

        return [{
          id: point.id,
          side: isHighLabel(point.type) ? "high" as const : "low" as const,
          label: point.type,
          price: point.price,
          pointTime: pointBar.time as Time,
          confirmationTime: breakBar.time as Time,
          startTime: breakBar.time as Time,
          endTime: lastBar.time as Time,
          color: settings.pendingColor,
          lineWidth: Math.max(1, settings.lineWidth - 1),
          lineStyle: "dashed" as const,
          pending: true,
        }];
      })
    : [];

  return [...confirmedLines, ...pendingLines];
}
