// src/components/chart/interaction/tools/PriceRangeTool.ts

import type { ChartTool } from "../ChartTool";
import type { ChartMouseEvent } from "../events/ChartMouseEvent";
import type { ToolContext } from "../ToolContext";
import type { ChartPointerPoint } from "../../ChartEngine";
import type { DrawingEngine } from "../../DrawingEngine";
import type { DrawingStyle } from "../../DrawingTypes";

function clonePoint(point: ChartPointerPoint): ChartPointerPoint {
  return {
    ...point,
    time: Number(point.time),
    price: Number(point.price),
    rawPrice: Number(point.rawPrice),
    x: Number(point.x),
    y: Number(point.y),
    snappedTo: point.snappedTo ?? null,
    bar: point.bar ?? null,
  };
}

function lineWidth(width: number): number {
  if (width <= 1) return 1;
  if (width === 2) return 2;
  if (width === 3) return 3;
  return 4;
}

export class PriceRangeTool implements ChartTool {
  readonly id = "price-range";
  readonly label = "Price Range";

  private readonly drawingEngine: DrawingEngine;
  private readonly getStyle: () => DrawingStyle;
  private startPoint: ChartPointerPoint | null = null;
  private currentPoint: ChartPointerPoint | null = null;

  constructor(drawingEngine: DrawingEngine, getStyle: () => DrawingStyle) {
    this.drawingEngine = drawingEngine;
    this.getStyle = getStyle;
  }

  activate(context: ToolContext): void {
    context.setCursor("crosshair");
    context.setChartNavigationEnabled?.(false);
  }

  deactivate(context: ToolContext): void {
    this.startPoint = null;
    this.currentPoint = null;
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.clearOverlay();
  }

  onClick(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (event.button !== 0) return false;

    event.nativeEvent?.preventDefault();

    if (!this.startPoint) {
      this.startPoint = clonePoint(event.point);
      this.currentPoint = clonePoint(event.point);
      this.drawingEngine.selectDrawing(null);
      context.setCursor("crosshair");
      context.requestOverlayRender();
      return true;
    }

    const start = this.startPoint;
    const end = clonePoint(event.point);

    this.startPoint = null;
    this.currentPoint = null;

    const created = this.drawingEngine.createPriceRangeFromPoints(
      start,
      end,
      this.getStyle(),
    );

    if (created) {
      this.drawingEngine.selectDrawing(created.id);
    }

    context.setCursor("crosshair");
    context.clearOverlay();
    context.requestOverlayRender();
    return true;
  }

  onMouseMove(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!this.startPoint) return false;

    this.currentPoint = clonePoint(event.point);
    context.setCursor("crosshair");
    context.requestOverlayRender();
    return true;
  }

  onContextMenu(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (!this.startPoint) return false;

    event.nativeEvent?.preventDefault();
    this.cancel(context);
    return true;
  }

  onKeyDown(event: KeyboardEvent, context: ToolContext): boolean | void {
    if (event.key !== "Escape") return false;
    return this.onCancel(context);
  }

  onCancel(context: ToolContext): boolean | void {
    if (!this.startPoint && !this.currentPoint) return false;
    this.cancel(context);
    return true;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.startPoint || !this.currentPoint) return;

    const style = this.getStyle();
    const start = this.startPoint;
    const end = this.currentPoint;
    const left = Math.min(start.x, end.x);
    const top = Math.min(start.y, end.y);
    const width = Math.abs(end.x - start.x);
    const height = Math.abs(end.y - start.y);

    ctx.save();
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.globalAlpha = 1;
    ctx.lineWidth = lineWidth(style.width);
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(left, top, width, height);

    ctx.globalAlpha = 0.1;
    ctx.fillRect(left, top, width, height);

    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(start.x, start.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private cancel(context: ToolContext): void {
    this.startPoint = null;
    this.currentPoint = null;
    this.drawingEngine.cancelPendingDrawing();
    context.setCursor("crosshair");
    context.clearOverlay();
    context.requestOverlayRender();
  }
}
