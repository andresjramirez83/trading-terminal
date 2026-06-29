// src/components/ChartPanelV2/DrawingTypes.ts

import type { CleanBar } from "../../chart/ChartTypes";

export type DrawingTool =
  | "cursor"
  | "trendline"
  | "horizontal"
  | "ray"
  | "rectangle"
  | "priceRange"
  | "dateRange"
  | "text"
  | "magnet"
  | "eraser";

export type SnapTargetKind = "high" | "low" | "open" | "close" | null;

export type DrawingPoint = {
  time: number;
  price: number;
  rawPrice?: number;
  x?: number;
  y?: number;
  snappedTo?: SnapTargetKind;
  bar?: CleanBar | null;
};

export type DrawingPointerEvent = DrawingPoint & {
  nativeEvent?: PointerEvent | MouseEvent;
};

export type DrawingStyle = {
  color: string;
  width: number;
  extendRight: boolean;
};

export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
  color: "#2563eb",
  width: 2,
  extendRight: true,
};

export type HorizontalLineDrawing = {
  id: string;
  type: "horizontal";
  price: number;
  style: DrawingStyle;
};

export type TrendlineDrawing = {
  id: string;
  type: "trendline";
  p1: DrawingPoint;
  p2: DrawingPoint;
  style: DrawingStyle;
  selected?: boolean;
};

export type ChartDrawing = HorizontalLineDrawing | TrendlineDrawing;
