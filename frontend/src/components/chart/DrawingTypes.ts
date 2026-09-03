// src/components/chart/DrawingTypes.ts

import type { CleanBar } from "./ChartTypes";

export type DrawingTool =
  | "cursor"
  | "trendline"
  | "marketStructure"
  | "horizontal"
  | "ray"
  | "rectangle"
  | "priceRange"
  | "fibonacci"
  | "longPosition"
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

export type MarketStructureNodeClassification =
  | "high"
  | "low"
  | "hh"
  | "hl"
  | "lh"
  | "ll";

export type MarketStructureNode = DrawingPoint & {
  classification?: MarketStructureNodeClassification;
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

export type MarketStructureDrawing = {
  id: string;
  type: "marketStructure";
  nodes: MarketStructureNode[];
  style: DrawingStyle;
  selected?: boolean;
  selectedNodeIndex?: number | null;
};

export type RectangleDrawing = {
  id: string;
  type: "rectangle";
  p1: DrawingPoint;
  p2: DrawingPoint;
  style: DrawingStyle;
  selected?: boolean;
};

export type PriceRangeDrawing = {
  id: string;
  type: "priceRange";
  p1: DrawingPoint;
  p2: DrawingPoint;
  style: DrawingStyle;
  selected?: boolean;
};

export type FibonacciDrawing = {
  id: string;
  type: "fibonacci";
  p1: DrawingPoint;
  p2: DrawingPoint;
  style: DrawingStyle;
  selected?: boolean;
};

export type LongPositionDrawing = {
  id: string;
  type: "longPosition";
  tradeId?: string | null;
  entry: DrawingPoint;
  stop: DrawingPoint;
  target: DrawingPoint;
  style: DrawingStyle;
  selected?: boolean;
};

export type ChartDrawing =
  | HorizontalLineDrawing
  | TrendlineDrawing
  | MarketStructureDrawing
  | RectangleDrawing
  | PriceRangeDrawing
  | FibonacciDrawing
  | LongPositionDrawing;