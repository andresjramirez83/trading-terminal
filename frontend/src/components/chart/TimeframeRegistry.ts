// src/components/ChartPanelV2/TimeframeRegistry.ts

export type TimeframeGroup = "Favorites" | "Intraday" | "Hourly" | "Daily";

export type TimeframeOption = {
  id: string;
  label: string;
  shortLabel: string;
  group: Exclude<TimeframeGroup, "Favorites">;
  search: string;
};

export const DEFAULT_TIMEFRAME_FAVORITES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

export const TIMEFRAME_OPTIONS: TimeframeOption[] = [
  { id: "1m", label: "1 Minute", shortLabel: "1M", group: "Intraday", search: "1m 1 min minute" },
  { id: "2m", label: "2 Minute", shortLabel: "2M", group: "Intraday", search: "2m 2 min minute" },
  { id: "3m", label: "3 Minute", shortLabel: "3M", group: "Intraday", search: "3m 3 min minute" },
  { id: "5m", label: "5 Minute", shortLabel: "5M", group: "Intraday", search: "5m 5 min minute" },
  { id: "10m", label: "10 Minute", shortLabel: "10M", group: "Intraday", search: "10m 10 min minute" },
  { id: "15m", label: "15 Minute", shortLabel: "15M", group: "Intraday", search: "15m 15 min minute" },
  { id: "20m", label: "20 Minute", shortLabel: "20M", group: "Intraday", search: "20m 20 min minute" },
  { id: "30m", label: "30 Minute", shortLabel: "30M", group: "Intraday", search: "30m 30 min minute" },
  { id: "45m", label: "45 Minute", shortLabel: "45M", group: "Intraday", search: "45m 45 min minute" },

  { id: "1h", label: "1 Hour", shortLabel: "1H", group: "Hourly", search: "1h 1 hour hourly" },
  { id: "2h", label: "2 Hour", shortLabel: "2H", group: "Hourly", search: "2h 2 hour hourly" },
  { id: "4h", label: "4 Hour", shortLabel: "4H", group: "Hourly", search: "4h 4 hour hourly" },
  { id: "6h", label: "6 Hour", shortLabel: "6H", group: "Hourly", search: "6h 6 hour hourly" },
  { id: "8h", label: "8 Hour", shortLabel: "8H", group: "Hourly", search: "8h 8 hour hourly" },
  { id: "12h", label: "12 Hour", shortLabel: "12H", group: "Hourly", search: "12h 12 hour hourly" },

  { id: "1d", label: "1 Day", shortLabel: "1D", group: "Daily", search: "1d 1 day daily" },
  { id: "2d", label: "2 Day", shortLabel: "2D", group: "Daily", search: "2d 2 day daily" },
  { id: "3d", label: "3 Day", shortLabel: "3D", group: "Daily", search: "3d 3 day daily" },
  { id: "1w", label: "1 Week", shortLabel: "1W", group: "Daily", search: "1w 1 week weekly" },
  { id: "1mo", label: "1 Month", shortLabel: "1MO", group: "Daily", search: "1mo 1 month monthly" },
];

export const TIMEFRAME_GROUPS: Array<Exclude<TimeframeGroup, "Favorites">> = [
  "Intraday",
  "Hourly",
  "Daily",
];

export function normalizeTimeframeId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === "1month" || trimmed.toLowerCase() === "1mon") return "1mo";
  if (trimmed === "1M") return "1mo";
  return trimmed.toLowerCase();
}

export function getTimeframeOption(value: string): TimeframeOption | undefined {
  const id = normalizeTimeframeId(value);
  return TIMEFRAME_OPTIONS.find((option) => option.id === id);
}

export function getTimeframeShortLabel(value: string): string {
  return getTimeframeOption(value)?.shortLabel ?? value.toUpperCase();
}
