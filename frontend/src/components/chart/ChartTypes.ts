// src/chart/ChartTypes.ts

import type {
  IChartApi,
  ISeriesApi,
  Time,
  UTCTimestamp,
} from "lightweight-charts";

import type { Candle } from "../types/market";

export type LiveStatus = "connecting" | "live" | "connected" | "disconnected" | "error";

export type CleanBar = {
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export interface CrosshairInfo {
  time: Time | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  range: number | null;
}

export interface StudyVisibility {
  vwap: boolean;
  ema9: boolean;
  ema20: boolean;
  volume: boolean;
}

export type ChartSeriesBundle = {
  candles: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  vwap: ISeriesApi<"Line">;
};

export type PriceLineKind =
  | "entry"
  | "stop"
  | "target"
  | "projection"
  | "manual";

export interface PriceLineModel {
  id: string;
  kind: PriceLineKind;
  price: number;
  color: string;
  title?: string;
  visible: boolean;
}

export interface TrendlinePoint {
  time: UTCTimestamp;
  price: number;
}

export interface TrendlineModel {
  id: string;
  start: TrendlinePoint;
  end: TrendlinePoint;
  selected: boolean;
  color: string;
  width: number;
  extendLeft: boolean;
  extendRight: boolean;
}

export interface RectangleModel {
  id: string;
  startTime: UTCTimestamp;
  endTime: UTCTimestamp;
  top: number;
  bottom: number;
  color: string;
  fill: string;
  visible: boolean;
}

export interface DemandZone extends RectangleModel {
  candleTime: UTCTimestamp;
}

export interface ProjectionModel {
  id: string;
  fromTime: UTCTimestamp;
  toTime: UTCTimestamp;
  price: number;
  label: string;
}

export interface OverlayState {
  demandZones: DemandZone[];
  supplyZones: RectangleModel[];
  projections: ProjectionModel[];
  trendlines: TrendlineModel[];
  priceLines: PriceLineModel[];
}

export interface HoverState {
  candle: Candle | null;
  time: Time | null;
  x: number;
  y: number;
}

export interface LiveBarState {
  current: Candle | null;
  previous: Candle | null;
}

export interface ChartContext {
  chart: IChartApi;
  candleSeries: ISeriesApi<"Candlestick">;
}

export interface Engine {
  attach(ctx: ChartContext): void;
  detach(): void;
  render(): void;
}