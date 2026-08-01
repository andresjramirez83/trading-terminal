// src/components/chart/interaction/tools/MarketStructureTool.ts

import type { ChartPointerPoint } from "../../ChartEngine";
import type { DrawingEngine } from "../../DrawingEngine";
import type {
  DrawingStyle,
  MarketStructureNode,
} from "../../DrawingTypes";
import type {
  ChartTool,
  ChartToolCompletionPayload,
} from "../ChartTool";
import type { ChartMouseEvent } from "../events/ChartMouseEvent";
import type { ToolContext } from "../ToolContext";

const MIN_NODE_DISTANCE_PX = 3;

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

function toNode(point: ChartPointerPoint): MarketStructureNode {
  return {
    ...clonePoint(point),
  };
}

function isSameVisualPoint(
  left: ChartPointerPoint,
  right: ChartPointerPoint,
): boolean {
  const dx = Number(left.x) - Number(right.x);
  const dy = Number(left.y) - Number(right.y);
  return Math.hypot(dx, dy) <= MIN_NODE_DISTANCE_PX;
}

export class MarketStructureTool implements ChartTool {
  readonly id = "market-structure";
  readonly label = "Market Structure";

  private readonly drawingEngine: DrawingEngine;
  private readonly getStyle: () => DrawingStyle;

  private nodes: ChartPointerPoint[] = [];
  private currentPoint: ChartPointerPoint | null = null;
  private completed = false;
  private completionPayload: ChartToolCompletionPayload | null = null;

  constructor(
    drawingEngine: DrawingEngine,
    getStyle: () => DrawingStyle,
  ) {
    this.drawingEngine = drawingEngine;
    this.getStyle = getStyle;
  }

  activate(context: ToolContext): void {
    this.resetCompletion();
    context.setCursor("crosshair");
    context.setChartNavigationEnabled?.(false);
    context.requestOverlayRender();
  }

  deactivate(context: ToolContext): void {
    this.resetDrawing();
    this.resetCompletion();
    context.setCursor(null);
    context.setChartNavigationEnabled?.(true);
    context.clearOverlay();
  }

  onClick(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (event.button !== 0) return false;

    event.nativeEvent?.preventDefault();

    const nextPoint = clonePoint(event.point);
    const lastPoint = this.nodes[this.nodes.length - 1];

    if (!lastPoint || !isSameVisualPoint(lastPoint, nextPoint)) {
      this.nodes.push(nextPoint);
    }

    this.currentPoint = nextPoint;
    this.drawingEngine.selectDrawing(null);
    context.setCursor("crosshair");
    context.requestOverlayRender();
    return true;
  }

  onMouseMove(event: ChartMouseEvent, context: ToolContext): boolean | void {
    if (this.nodes.length === 0) return false;

    this.currentPoint = clonePoint(event.point);
    context.setCursor("crosshair");
    context.requestOverlayRender();
    return true;
  }

  onDoubleClick(
    event: ChartMouseEvent,
    context: ToolContext,
  ): boolean | void {
    if (event.button !== 0 || this.nodes.length === 0) return false;

    event.nativeEvent?.preventDefault();

    const finishPoint = clonePoint(event.point);
    const lastPoint = this.nodes[this.nodes.length - 1];

    if (!lastPoint || !isSameVisualPoint(lastPoint, finishPoint)) {
      this.nodes.push(finishPoint);
    }

    return this.finish(context);
  }

  onContextMenu(
    event: ChartMouseEvent,
    context: ToolContext,
  ): boolean | void {
    if (this.nodes.length === 0) return false;

    event.nativeEvent?.preventDefault();
    return this.finish(context);
  }

  onKeyDown(
    event: KeyboardEvent,
    context: ToolContext,
  ): boolean | void {
    if (event.key !== "Escape") return false;
    if (this.nodes.length === 0) return false;

    event.preventDefault();

    if (this.nodes.length >= 2) {
      return this.finish(context);
    }

    this.cancel(context);
    return true;
  }

  onCancel(context: ToolContext): boolean | void {
    if (this.nodes.length === 0) return false;

    if (this.nodes.length >= 2) {
      return this.finish(context);
    }

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

  drawOverlay(
    ctx: CanvasRenderingContext2D,
    _context: ToolContext,
  ): void {
    if (this.nodes.length === 0) return;

    const style = this.getStyle();
    const previewNodes = [...this.nodes];

    if (this.currentPoint) {
      const lastNode = previewNodes[previewNodes.length - 1];
      if (!lastNode || !isSameVisualPoint(lastNode, this.currentPoint)) {
        previewNodes.push(this.currentPoint);
      }
    }

    if (previewNodes.length === 0) return;

    ctx.save();
    ctx.lineWidth = Math.max(1, Math.min(5, Number(style.width) || 2));
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    if (previewNodes.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(previewNodes[0].x, previewNodes[0].y);

      for (let index = 1; index < previewNodes.length; index += 1) {
        ctx.lineTo(previewNodes[index].x, previewNodes[index].y);
      }

      ctx.stroke();
    }

    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index];

      ctx.beginPath();
      ctx.arc(node.x, node.y, 4, 0, Math.PI * 2);
      ctx.fill();

      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(17, 19, 21, 0.95)";
      ctx.stroke();
      ctx.strokeStyle = style.color;
      ctx.lineWidth = Math.max(1, Math.min(5, Number(style.width) || 2));
    }

    if (this.currentPoint && this.nodes.length > 0) {
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.arc(this.currentPoint.x, this.currentPoint.y, 4, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  private finish(context: ToolContext): boolean {
    if (this.nodes.length < 2) {
      this.cancel(context);
      return true;
    }

    const created = this.drawingEngine.createMarketStructureFromNodes(
      this.nodes.map(toNode),
      this.getStyle(),
    );

    this.resetDrawing();

    if (created) {
      this.drawingEngine.selectDrawing(created.id);
      this.completed = true;
      this.completionPayload = {
        drawingId: created.id,
      };
    } else {
      this.resetCompletion();
    }

    context.setCursor("crosshair");
    context.clearOverlay();
    context.requestOverlayRender();
    return true;
  }

  private cancel(context: ToolContext): void {
    this.resetDrawing();
    this.resetCompletion();
    this.drawingEngine.cancelPendingDrawing();
    context.setCursor("crosshair");
    context.clearOverlay();
    context.requestOverlayRender();
  }

  private resetDrawing(): void {
    this.nodes = [];
    this.currentPoint = null;
  }
}