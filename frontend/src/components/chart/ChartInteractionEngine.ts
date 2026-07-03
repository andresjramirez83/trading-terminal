// src/chart/ChartInteractionEngine.ts

import type { ChartPointerPoint, ChartEngine } from "./ChartEngine";
import { DrawingEngine } from "./DrawingEngine";
import type { ChartDrawing, DrawingStyle, DrawingTool } from "./DrawingTypes";
import { ContextMenuManager } from "./ContextMenuManager";

export type ChartInteractionEngineOptions = {
  onDrawingCreated?: (drawing: ChartDrawing) => void;
  onDrawingsChanged?: (drawings: ChartDrawing[]) => void;
  onToolChanged?: (tool: DrawingTool) => void;
};

/**
 * ChartInteractionEngine owns chart-level user interaction.
 *
 * ChartEngine owns Lightweight Charts + market data.
 * DrawingEngine owns drawing behavior.
 * ChartInteractionEngine connects pointer/click events to drawing behavior.
 */
export class ChartInteractionEngine {
  private chartEngine: ChartEngine;
  private drawingEngine: DrawingEngine;
  private options: ChartInteractionEngineOptions;
  private contextMenu: ContextMenuManager;
  private unsubscribers: Array<() => void> = [];

  constructor(chartEngine: ChartEngine, options: ChartInteractionEngineOptions = {}) {
    this.chartEngine = chartEngine;
    this.options = options;

    this.drawingEngine = new DrawingEngine(
      chartEngine.chart,
      chartEngine.series.candles
    );

    this.contextMenu = new ContextMenuManager(chartEngine.getContainer());

    this.bindEvents();
  }

  setTool(tool: DrawingTool): void {
    this.drawingEngine.setTool(tool);
    this.chartEngine.setDrawingMode(tool !== "cursor");
    this.options.onToolChanged?.(tool);
  }

  getTool(): DrawingTool {
    return this.drawingEngine.getTool();
  }

  setDefaultStyle(style: DrawingStyle): void {
    this.drawingEngine.setDefaultStyle(style);
  }

  clearDrawings(): void {
    this.drawingEngine.clear();
    this.emitDrawingsChanged();
  }

  getDrawings(): ChartDrawing[] {
    return this.drawingEngine.getDrawings();
  }

  getDrawingEngine(): DrawingEngine {
    return this.drawingEngine;
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }

    this.unsubscribers = [];
    this.contextMenu.destroy();
    this.drawingEngine.clear();
  }

  private bindEvents(): void {
    this.unsubscribers.push(
      this.chartEngine.subscribeClick((point) => this.handleClick(point))
    );

    this.unsubscribers.push(
      this.chartEngine.subscribePointerDown((point) => this.handlePointerDown(point))
    );

    this.unsubscribers.push(
      this.chartEngine.subscribePointerMove((point) => this.handlePointerMove(point))
    );

    this.unsubscribers.push(
      this.chartEngine.subscribePointerUp((point) => this.handlePointerUp(point))
    );

    this.unsubscribers.push(
      this.chartEngine.subscribeContextMenu((point) => this.handleContextMenu(point))
    );
  }

  private handleClick(point: ChartPointerPoint): void {
    const created = this.drawingEngine.handleClick(point);

    if (!created) return;

    this.options.onDrawingCreated?.(created);
    this.emitDrawingsChanged();
  }

  private handlePointerDown(point: ChartPointerPoint): void {
    const changed = this.drawingEngine.handlePointerDown(point);
    if (changed) this.emitDrawingsChanged();
  }

  private handlePointerMove(point: ChartPointerPoint): void {
    const changed = this.drawingEngine.handlePointerMove(point);
    if (changed) this.emitDrawingsChanged();
  }

  private handlePointerUp(point: ChartPointerPoint): void {
    const changed = this.drawingEngine.handlePointerUp(point);
    if (changed) this.emitDrawingsChanged();
  }


  private handleContextMenu(point: ChartPointerPoint): void {
    const event = point.nativeEvent;
    event?.preventDefault();

    const hit = this.drawingEngine.hitTestAt(point);
    if (!hit) {
      this.drawingEngine.selectDrawing(null);
      this.emitDrawingsChanged();
      return;
    }

    this.drawingEngine.selectDrawing(hit.drawingId);
    this.emitDrawingsChanged();

    this.contextMenu.show(event?.clientX ?? point.x, event?.clientY ?? point.y, [
      {
        id: "duplicate",
        label: "Duplicate",
        onClick: () => {
          this.drawingEngine.duplicateSelectedDrawing();
          this.emitDrawingsChanged();
        },
      },
      {
        id: "delete",
        label: "Delete",
        danger: true,
        onClick: () => {
          this.drawingEngine.removeSelectedDrawing();
          this.emitDrawingsChanged();
        },
      },
    ]);
  }

  private emitDrawingsChanged(): void {
    this.options.onDrawingsChanged?.(this.drawingEngine.getDrawings());
  }
}
