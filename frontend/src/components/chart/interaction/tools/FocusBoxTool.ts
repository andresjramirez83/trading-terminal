// src/components/chart/interaction/tools/FocusBoxTool.ts

import type { ChartTool } from "../ChartTool";
import type { ChartMouseEvent } from "../events/ChartMouseEvent";
import type { ToolContext } from "../ToolContext";
import type { ChartPointerPoint } from "../../ChartEngine";

type FocusBoxState = {
  start: ChartPointerPoint;
  current: ChartPointerPoint;
};

const MIN_FOCUS_WIDTH_PX = 12;
const MIN_FOCUS_HEIGHT_PX = 12;

export class FocusBoxTool implements ChartTool {
  readonly id = "focus-box";
  readonly label = "Focus Box";

  private state: FocusBoxState | null = null;

  onMouseDown(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!event.shiftKey || event.button !== 0) return false;

    event.nativeEvent?.preventDefault();
    this.state = {
      start: event.point,
      current: event.point,
    };

    context.setCursor("crosshair");
    context.requestOverlayRender();
    return true;
  }

  onMouseMove(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!this.state) return false;

    event.nativeEvent?.preventDefault();
    this.state = {
      ...this.state,
      current: event.point,
    };

    context.setCursor("crosshair");
    context.requestOverlayRender();
    return true;
  }

  onMouseUp(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!this.state) return false;

    event.nativeEvent?.preventDefault();

    const start = this.state.start;
    const end = event.point;
    this.state = null;
    context.setCursor(null);
    context.clearOverlay();

    const leftX = Math.min(start.x, end.x);
    const rightX = Math.max(start.x, end.x);
    if (
      Math.abs(rightX - leftX) >= MIN_FOCUS_WIDTH_PX &&
      Math.abs(start.y - end.y) >= MIN_FOCUS_HEIGHT_PX
    ) {
      context.focusSelection?.({
        leftX,
        rightX,
      });
    }

    context.requestOverlayRender();
    return true;
  }

  onDoubleClick(event: ChartMouseEvent, context: ToolContext): boolean | void {
    event.nativeEvent?.preventDefault();
    this.state = null;
    context.setCursor(null);
    context.clearOverlay();
    context.resetFocus?.();
    context.requestOverlayRender();
    return true;
  }

  onKeyDown(event: KeyboardEvent, context: ToolContext): boolean | void {
    if (event.key !== "Escape") return false;
    return this.onCancel(context);
  }

  onCancel(context: ToolContext): boolean | void {
    if (!this.state) return false;

    this.state = null;
    context.setCursor(null);
    context.clearOverlay();
    context.requestOverlayRender();
    return true;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.state) return;

    const start = this.state.start;
    const current = this.state.current;
    const left = Math.min(start.x, current.x);
    const top = Math.min(start.y, current.y);
    const width = Math.abs(current.x - start.x);
    const height = Math.abs(current.y - start.y);

    if (width <= 0 || height <= 0) return;

    ctx.save();
    ctx.fillStyle = "rgba(56, 189, 248, 0.14)";
    ctx.strokeStyle = "rgba(56, 189, 248, 0.95)";
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    ctx.fillRect(left, top, width, height);
    ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, width - 1), Math.max(0, height - 1));
    ctx.restore();
  }
}