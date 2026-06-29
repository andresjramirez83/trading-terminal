// src/chart/ChartSettingsTypes.ts

export type ChartSessionBandKey = "premarket" | "regular" | "afterHours";

export type ChartSettings = {
  gridVisible: boolean;
  crosshairVisible: boolean;

  sessionBands: {
    enabled: boolean;
    premarket: boolean;
    regular: boolean;
    afterHours: boolean;
    opacity: number;
  };

  atrExpansion: {
    enabled: boolean;
    length: number;
    multiplier: number;
    color: string;
  };
};

export const DEFAULT_CHART_SETTINGS: ChartSettings = {
  gridVisible: true,
  crosshairVisible: true,

  sessionBands: {
    enabled: false,
    premarket: true,
    regular: false,
    afterHours: true,
    opacity: 0.08,
  },

  atrExpansion: {
    enabled: false,
    length: 14,
    multiplier: 1.5,
    color: "#f59e0b",
  },
};

export function normalizeChartSettings(
  value: Partial<ChartSettings> | null | undefined,
): ChartSettings {
  return {
    ...DEFAULT_CHART_SETTINGS,
    ...(value ?? {}),
    sessionBands: {
      ...DEFAULT_CHART_SETTINGS.sessionBands,
      ...(value?.sessionBands ?? {}),
    },
    atrExpansion: {
      ...DEFAULT_CHART_SETTINGS.atrExpansion,
      ...(value?.atrExpansion ?? {}),
    },
  };
}
