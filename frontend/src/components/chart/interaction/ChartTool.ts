// src/components/chart/interaction/ChartTool.ts

import type { ChartMouseEvent } from "./events/ChartMouseEvent";
import type { ToolContext } from "./ToolContext";

export type ChartToolId =
  | "select"
  | "focus-box"
  | "trendline"
  | "horizontal-line"
  | "rectangle"
  | "ray"
  | "price-range"
  | "long-position"
  | string;

export type ChartToolCompletionPayload = {
  drawingId?: string;
  [key: string]: unknown;
};

export type ChartToolCompletionEvent = {
  toolId: ChartToolId;
  payload: ChartToolCompletionPayload | null;
};

export const CHART_TOOL_COMPLETED_EVENT =
  "trading-terminal:chart-tool-completed";

export interface ChartTool {
  readonly id: ChartToolId;
  readonly label: string;

  activate?(context: ToolContext): void;
  deactivate?(context: ToolContext): void;

  onMouseDown?(event: ChartMouseEvent, context: ToolContext): boolean | void;
  onMouseMove?(event: ChartMouseEvent, context: ToolContext): boolean | void;
  onMouseUp?(event: ChartMouseEvent, context: ToolContext): boolean | void;
  onClick?(event: ChartMouseEvent, context: ToolContext): boolean | void;
  onDoubleClick?(event: ChartMouseEvent, context: ToolContext): boolean | void;
  onContextMenu?(event: ChartMouseEvent, context: ToolContext): boolean | void;
  onKeyDown?(event: KeyboardEvent, context: ToolContext): boolean | void;
  onCancel?(context: ToolContext): boolean | void;

  isComplete?(): boolean;
  getCompletionPayload?(): ChartToolCompletionPayload | null;
  resetCompletion?(): void;

  drawOverlay?(ctx: CanvasRenderingContext2D, context: ToolContext): void;
}
