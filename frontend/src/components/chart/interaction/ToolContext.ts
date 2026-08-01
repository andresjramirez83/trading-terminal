// src/components/chart/interaction/ToolContext.ts

import type { IChartApi, ISeriesApi, MouseEventParams, Time } from "lightweight-charts";
import type { ChartPointerPoint } from "../ChartEngine";
import type { CleanBar } from "../ChartTypes";
import type {
  ChartToolCompletionPayload,
  ChartToolId,
} from "./ChartTool";

export type FocusSelection = {
  leftX: number;
  rightX: number;
};

export type ToolContext = {
  container: HTMLDivElement;
  chart: IChartApi;
  candleSeries?: ISeriesApi<"Candlestick">;
  getBars?: () => CleanBar[];
  requestOverlayRender: () => void;
  clearOverlay: () => void;
  setCursor: (cursor: string | null) => void;
  focusSelection?: (selection: FocusSelection) => void;
  resetFocus?: () => void;
  setChartNavigationEnabled?: (enabled: boolean) => void;
  onToolCompleted?: (
    toolId: ChartToolId,
    payload: ChartToolCompletionPayload | null,
  ) => void;
};

export type ChartPointBuilder = {
  buildPointFromClick: (
    param: MouseEventParams<Time>,
  ) => ChartPointerPoint | null;
  buildPointFromPointerEvent: (
    event: PointerEvent,
  ) => ChartPointerPoint | null;
  buildFallbackPointFromMouseEvent: (
    event: PointerEvent | MouseEvent,
  ) => ChartPointerPoint | null;
};