import type {
  FxAnalysisResult,
  FxAnalysisSettings,
  FxAnalysisToolId,
} from "./AnalysisTypes";

export type FxAnalysisPriceRange = {
  minValue: number;
  maxValue: number;
};

export class AnalysisStore {
  private previewByTool = new Map<FxAnalysisToolId, FxAnalysisResult>();
  private savedResults: FxAnalysisResult[] = [];

  getAll(): FxAnalysisResult[] {
    return [...this.savedResults, ...this.previewByTool.values()];
  }

  getSaved(): FxAnalysisResult[] {
    return [...this.savedResults];
  }

  getPreview(tool: FxAnalysisToolId): FxAnalysisResult | undefined {
    return this.previewByTool.get(tool);
  }

  addResult(result: FxAnalysisResult, saved: boolean): void {
    if (result.tool === "none") return;

    if (!saved) {
      this.previewByTool.set(result.tool, result);
      return;
    }

    // If the user clicks the exact same candle/tool again, update that saved
    // object instead of stacking duplicate series on top of each other.
    const existingIndex = this.savedResults.findIndex((item) => item.id === result.id);

    if (existingIndex >= 0) {
      this.savedResults[existingIndex] = result;
    } else {
      this.savedResults.push(result);
    }

    // Once an item is saved, remove the temporary preview for that same tool so
    // the rendered list does not contain the same analysis twice.
    this.previewByTool.delete(result.tool);
  }

  getAutoScalePriceRange(settings: FxAnalysisSettings): FxAnalysisPriceRange | null {
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;

    for (const result of this.getAll()) {
      if (result.tool === "none") continue;

      const toolSettings = settings[result.tool];
      if (!toolSettings?.enabled) continue;
      if (toolSettings.showLine === false) continue;
      if (toolSettings.includeInAutoScale === false) continue;

      for (const line of result.lines) {
        if (!Number.isFinite(line.price)) continue;
        minValue = Math.min(minValue, line.price);
        maxValue = Math.max(maxValue, line.price);
      }

      if (result.zone) {
        if (Number.isFinite(result.zone.low)) {
          minValue = Math.min(minValue, result.zone.low);
          maxValue = Math.max(maxValue, result.zone.low);
        }

        if (Number.isFinite(result.zone.high)) {
          minValue = Math.min(minValue, result.zone.high);
          maxValue = Math.max(maxValue, result.zone.high);
        }
      }
    }

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      return null;
    }

    if (minValue === maxValue) {
      const padding = Math.max(Math.abs(minValue) * 0.02, 0.01);
      return {
        minValue: minValue - padding,
        maxValue: maxValue + padding,
      };
    }

    return { minValue, maxValue };
  }

  remove(id: string): void {
    this.savedResults = this.savedResults.filter((item) => item.id !== id);

    for (const [tool, result] of this.previewByTool.entries()) {
      if (result.id === id) {
        this.previewByTool.delete(tool);
      }
    }
  }

  clear(): void {
    this.previewByTool.clear();
    this.savedResults = [];
  }
}
