// src/components/chart/interaction/tools/LongPositionTool.ts

import type { ChartTool, ChartToolCompletionPayload } from "../ChartTool";
import type { ChartMouseEvent } from "../events/ChartMouseEvent";
import type { ToolContext } from "../ToolContext";
import type { ChartPointerPoint } from "../../ChartEngine";
import type { DrawingEngine } from "../../DrawingEngine";
import type { DrawingStyle } from "../../DrawingTypes";

type LongPositionStep = "entry" | "stop" | "target";

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

function formatPrice(value: number): string {
  if (!Number.isFinite(value)) return "--";
  if (Math.abs(value) >= 100) return value.toFixed(2);
  if (Math.abs(value) >= 10) return value.toFixed(3);
  return value.toFixed(4);
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "--";
  return `${value.toFixed(2)}%`;
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  color: string,
): void {
  ctx.save();
  ctx.font = "700 11px Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(17,19,21,.94)";
  ctx.fillStyle = color;
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
  ctx.restore();
}

export class LongPositionTool implements ChartTool {
  readonly id = "long-position";
  readonly label = "Long Position";

  private readonly drawingEngine: DrawingEngine;
  private readonly getStyle: () => DrawingStyle;
  private step: LongPositionStep = "entry";
  private entryPoint: ChartPointerPoint | null = null;
  private stopPoint: ChartPointerPoint | null = null;
  private currentPoint: ChartPointerPoint | null = null;
  private completed = false;
  private completionPayload: ChartToolCompletionPayload | null = null;

  constructor(drawingEngine: DrawingEngine, getStyle: () => DrawingStyle) {
    this.drawingEngine = drawingEngine;
    this.getStyle = getStyle;
  }

  activate(context: ToolContext): void {
    this.resetCompletion();
    context.setCursor("crosshair");
    context.setChartNavigationEnabled?.(false);
  }

  deactivate(context: ToolContext): void {
    this.reset();
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.clearOverlay();
  }

  onClick(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (event.button !== 0) return false;

    event.nativeEvent?.preventDefault();

    if (this.step === "entry") {
      this.entryPoint = clonePoint(event.point);
      this.currentPoint = clonePoint(event.point);
      this.step = "stop";
      this.drawingEngine.selectDrawing(null);
      context.setCursor("crosshair");
      context.requestOverlayRender();
      return true;
    }

    if (this.step === "stop") {
      this.stopPoint = clonePoint(event.point);
      this.currentPoint = clonePoint(event.point);
      this.step = "target";
      context.setCursor("crosshair");
      context.requestOverlayRender();
      return true;
    }

    if (!this.entryPoint || !this.stopPoint) {
      this.reset();
      context.clearOverlay();
      context.requestOverlayRender();
      return true;
    }

    const targetPoint = clonePoint(event.point);
    const created = this.drawingEngine.createLongPositionFromPoints(
      this.entryPoint,
      this.stopPoint,
      targetPoint,
      this.getStyle(),
    );

    this.reset();

    if (created) {
      this.drawingEngine.selectDrawing(created.id);
      this.completed = true;
      this.completionPayload = {
        drawingId: created.id,
      };
    }

    context.clearOverlay();
    context.requestOverlayRender();
    return true;
  }

  onMouseMove(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (this.step === "entry") return false;

    this.currentPoint = clonePoint(event.point);
    context.setCursor("crosshair");
    context.requestOverlayRender();
    return true;
  }

  onContextMenu(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (this.step === "entry") return false;

    event.nativeEvent?.preventDefault();
    this.cancel(context);
    return true;
  }

  onKeyDown(event: KeyboardEvent, context: ToolContext): boolean | void {
    if (event.key !== "Escape") return false;
    return this.onCancel(context);
  }

  onCancel(context: ToolContext): boolean | void {
    if (this.step === "entry") return false;
    this.cancel(context);
    return true;
  }

  isComplete(): boolean {
    return this.completed;
  }

  getCompletionPayload(): ChartToolCompletionPayload | null {
    return this.completionPayload;
  }

  resetCompletion(): void {
    this.completed = false;
    this.completionPayload = null;
  }

  drawOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.entryPoint) return;

    const style = this.getStyle();
    const entry = this.entryPoint;
    const stop = this.stopPoint ?? this.currentPoint;
    const target = this.step === "target" ? this.currentPoint : null;

    if (!stop) return;

    const left = Math.min(entry.x, stop.x, target?.x ?? stop.x);
    const right = Math.max(entry.x, stop.x, target?.x ?? stop.x);
    const width = Math.max(1, right - left);

    ctx.save();
    ctx.lineWidth = Math.max(1, Math.min(4, style.width));
    ctx.setLineDash([6, 4]);

    if (target) {
      const rewardTop = Math.min(entry.y, target.y);
      const rewardBottom = Math.max(entry.y, target.y);
      ctx.fillStyle = "rgba(34,197,94,.16)";
      ctx.strokeStyle = "rgba(34,197,94,.9)";
      ctx.fillRect(left, rewardTop, width, Math.max(1, rewardBottom - rewardTop));
      ctx.strokeRect(left, rewardTop, width, Math.max(1, rewardBottom - rewardTop));
    }

    const riskTop = Math.min(entry.y, stop.y);
    const riskBottom = Math.max(entry.y, stop.y);
    ctx.fillStyle = "rgba(239,68,68,.16)";
    ctx.strokeStyle = "rgba(239,68,68,.9)";
    ctx.fillRect(left, riskTop, width, Math.max(1, riskBottom - riskTop));
    ctx.strokeRect(left, riskTop, width, Math.max(1, riskBottom - riskTop));

    ctx.setLineDash([]);
    for (const level of [
      { point: entry, label: "Entry", color: style.color },
      { point: stop, label: "Stop", color: "#ef4444" },
      ...(target ? [{ point: target, label: "Target", color: "#22c55e" }] : []),
    ]) {
      ctx.strokeStyle = level.color;
      ctx.beginPath();
      ctx.moveTo(left, level.point.y);
      ctx.lineTo(right, level.point.y);
      ctx.stroke();
      drawLabel(
        ctx,
        `${level.label} ${formatPrice(level.point.price)}`,
        right + 6,
        level.point.y + 4,
        level.color,
      );
    }

    if (target) {
      const entryPrice = Number(entry.price);
      const stopPrice = Number(stop.price);
      const targetPrice = Number(target.price);
      const risk = Math.abs(entryPrice - stopPrice);
      const reward = Math.abs(targetPrice - entryPrice);
      const rr = risk > 0 ? reward / risk : 0;
      const riskPercent = Math.abs(entryPrice) > 0 ? (risk / Math.abs(entryPrice)) * 100 : 0;
      const rewardPercent = Math.abs(entryPrice) > 0 ? (reward / Math.abs(entryPrice)) * 100 : 0;

      drawLabel(
        ctx,
        `Reward ${formatPrice(reward)} / ${formatPercent(rewardPercent)}`,
        left + 6,
        Math.min(entry.y, target.y) + 14,
        "#22c55e",
      );
      drawLabel(
        ctx,
        `Risk ${formatPrice(risk)} / ${formatPercent(riskPercent)} | R:R ${rr.toFixed(2)}`,
        left + 6,
        Math.max(entry.y, stop.y) - 6,
        "#ef4444",
      );
    }

    ctx.restore();
  }

  private cancel(context: ToolContext): void {
    this.reset();
    this.resetCompletion();
    this.drawingEngine.cancelPendingDrawing();
    context.setCursor("crosshair");
    context.clearOverlay();
    context.requestOverlayRender();
  }

  private reset(): void {
    this.step = "entry";
    this.entryPoint = null;
    this.stopPoint = null;
    this.currentPoint = null;
  }
}
