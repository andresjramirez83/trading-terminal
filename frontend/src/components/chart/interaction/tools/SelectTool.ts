// src/components/chart/interaction/tools/SelectTool.ts

import type { ChartTool } from "../ChartTool";
import type { ChartMouseEvent } from "../events/ChartMouseEvent";
import type { ToolContext } from "../ToolContext";
import type { DrawingEngine } from "../../DrawingEngine";

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
}

export class SelectTool implements ChartTool {
  readonly id = "select";
  readonly label = "Select";

  private readonly drawingEngine?: DrawingEngine;
  private dragging = false;

  constructor(drawingEngine?: DrawingEngine) {
    this.drawingEngine = drawingEngine;
  }

  activate(context: ToolContext): void {
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.clearOverlay();
  }

  deactivate(context: ToolContext): void {
    this.dragging = false;
    this.drawingEngine?.handlePointerUp();
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.clearOverlay();
  }

  onMouseDown(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!this.drawingEngine) return false;
    if (event.button !== 0) return false;

    const handled = this.drawingEngine.handlePointerDown(event.point);

    if (handled) {
      this.dragging = true;
      context.setCursor("grabbing");
      context.setChartNavigationEnabled?.(false);
      context.requestOverlayRender();
      return true;
    }

    this.dragging = false;
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.requestOverlayRender();
    return false;
  }

  onMouseMove(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!this.drawingEngine || !this.dragging) return false;

    const handled = this.drawingEngine.handlePointerMove(event.point);
    if (!handled) return false;

    context.setCursor("grabbing");
    context.setChartNavigationEnabled?.(false);
    context.requestOverlayRender();
    return true;
  }

  onMouseUp(_event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!this.drawingEngine || !this.dragging) return false;

    this.dragging = false;
    const handled = this.drawingEngine.handlePointerUp();

    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.requestOverlayRender();
    return handled;
  }

  onKeyDown(event: KeyboardEvent, context: ToolContext): boolean | void {
    if (!this.drawingEngine) return false;
    if (isTypingTarget(event.target)) return false;

    if (event.key === "Escape") {
      this.dragging = false;
      this.drawingEngine.selectDrawing(null);
      this.drawingEngine.handlePointerUp();
      context.setCursor(null);
      context.setChartNavigationEnabled?.(true);
      context.requestOverlayRender();
      return true;
    }

    if (event.key !== "Delete" && event.key !== "Backspace") return false;

    const removed = this.drawingEngine.removeSelectedDrawing();
    if (!removed) return false;

    this.dragging = false;
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.requestOverlayRender();
    return true;
  }

  onCancel(context: ToolContext): boolean | void {
    if (!this.drawingEngine) return false;

    this.dragging = false;
    this.drawingEngine.selectDrawing(null);
    this.drawingEngine.handlePointerUp();
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.requestOverlayRender();
    return true;
  }
}
