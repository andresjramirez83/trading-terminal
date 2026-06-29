// src/chart/SelectionManager.ts

import type { ChartDrawing } from "./DrawingTypes";

export type SelectionTarget =
  | { type: "none" }
  | { type: "drawing"; drawingId: string }
  | { type: "handle"; drawingId: string; handle: "start" | "end" };

export class SelectionManager {
  private selected: SelectionTarget = { type: "none" };

  selectDrawing(drawingId: string): void {
    this.selected = { type: "drawing", drawingId };
  }

  selectHandle(drawingId: string, handle: "start" | "end"): void {
    this.selected = { type: "handle", drawingId, handle };
  }

  clear(): void {
    this.selected = { type: "none" };
  }

  getSelection(): SelectionTarget {
    return this.selected;
  }

  isSelected(drawing: ChartDrawing): boolean {
    if (this.selected.type === "none") return false;
    return this.selected.drawingId === drawing.id;
  }
}