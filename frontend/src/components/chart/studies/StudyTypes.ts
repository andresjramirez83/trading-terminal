// src/chart/StudyTypes.ts

import type { Time } from "lightweight-charts";
import type { CleanBar } from "./ChartTypes";
import type { ChartSettings } from "./ChartSettingsTypes";

export type StudyMarkerDirection = "up" | "down";

export type StudyMarkerPoint = {
  time: Time;
  price: number;
  label: string;
  color: string;
  direction: StudyMarkerDirection;
  dotSize?: number;
};

export type StudyRenderContext = {
  bars: CleanBar[];
  settings: ChartSettings;
};

export type StudyRendererSeries = {
  priceToCoordinate(price: number): number | null;
};

export type StudyRenderResult = {
  atrExpansionMarkers: StudyMarkerPoint[];
};
