// src/chart/StudyTypes.ts

import type { LineData, Time } from "lightweight-charts";
import type { CleanBar } from "../ChartTypes";
import type { ChartSettings } from "../ChartSettingsTypes";
import type { AutomaticDemandZone } from "../DemandZoneEngine";

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

export type StudyLineSeries = {
  setData(data: LineData<Time>[]): void;
};

export type StudyRenderResult = {
  atrExpansionMarkers: StudyMarkerPoint[];
  demandZones: AutomaticDemandZone[];
};
