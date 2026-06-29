// src/components/ChartPanelV2/DrawingStore.ts

import type { ChartDrawing } from "./DrawingTypes";

function cloneDrawing<T extends ChartDrawing>(drawing: T): T {
  return JSON.parse(JSON.stringify(drawing)) as T;
}

export class DrawingStore {
  private drawings: ChartDrawing[] = [];

  getAll(): ChartDrawing[] {
    return this.drawings;
  }

  get(id: string): ChartDrawing | undefined {
    return this.drawings.find((drawing) => drawing.id === id);
  }

  add(drawing: ChartDrawing): void {
    this.drawings.push(drawing);
  }

  update(updated: ChartDrawing): void {
    const index = this.drawings.findIndex((drawing) => drawing.id === updated.id);

    if (index >= 0) {
      this.drawings[index] = updated;
    }
  }

  remove(id: string): void {
    this.drawings = this.drawings.filter((drawing) => drawing.id !== id);
  }

  clear(): void {
    this.drawings = [];
  }

  setAll(drawings: ChartDrawing[]): void {
    this.drawings = drawings.map(cloneDrawing);
  }
}
