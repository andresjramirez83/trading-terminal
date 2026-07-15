// src/components/chart/interaction/tools/HorizontalLineTool.ts

import type { ChartTool } from "../ChartTool";
import type { ChartMouseEvent } from "../events/ChartMouseEvent";
import type { ToolContext } from "../ToolContext";
import type { DrawingEngine } from "../../DrawingEngine";
import type { DrawingStyle } from "../../DrawingTypes";

export class HorizontalLineTool implements ChartTool {
  readonly id = "horizontal-line";
  readonly label = "Horizontal Line";

  private readonly drawingEngine: DrawingEngine;
  private readonly getStyle: () => DrawingStyle;

  constructor(drawingEngine: DrawingEngine, getStyle: () => DrawingStyle) {
    this.drawingEngine = drawingEngine;
    this.getStyle = getStyle;
  }

  activate(context: ToolContext): void {
    context.setCursor("crosshair");
    context.setChartNavigationEnabled?.(false);
  }

  deactivate(context: ToolContext): void {
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.clearOverlay();
  }

  onClick(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (event.button !== 0) return false;

    event.nativeEvent?.preventDefault();

    const created = this.drawingEngine.createHorizontalAtPoint(
      event.point,
      this.getStyle(),
    );

    this.drawingEngine.selectDrawing(created.id);
    context.setCursor("crosshair");
    context.clearOverlay();
    context.requestOverlayRender();
    return true;
  }

  onKeyDown(event: KeyboardEvent, context: ToolContext): boolean | void {
    if (event.key !== "Escape") return false;
    return this.onCancel(context);
  }

  onCancel(context: ToolContext): boolean | void {
    this.drawingEngine.cancelPendingDrawing();
    context.setCursor("crosshair");
    context.clearOverlay();
    context.requestOverlayRender();
    return true;
  }
}
