import type {
  FxAnalysisResult,
  FxAnalysisSettings,
  FxAnalysisToolId,
} from "./AnalysisTypes";

export type FxAnalysisPriceRange = {
  minValue: number;
  maxValue: number;
};

export type FxAnalysisHit = {
  resultId: string;
  objectId: string;
  kind: "zone" | "line";
};

const STORAGE_PREFIX = "chart.fxAnalysis.v1";

function normalizeSymbol(symbol?: string): string {
  return String(symbol || "SPY")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "_");
}

function makeStorageKey(symbol?: string, _timeframe?: string): string {
  // FX zones/support/resistance are intentionally symbol-wide so they appear
  // across 1m / 5m / 15m / 1h for the same ticker.
  return `${STORAGE_PREFIX}.${normalizeSymbol(symbol)}.ALL_TIMEFRAMES`;
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function cloneResult(result: FxAnalysisResult): FxAnalysisResult {
  return JSON.parse(JSON.stringify(result)) as FxAnalysisResult;
}

function getPriceTolerance(price: number, override?: number): number {
  if (override != null && Number.isFinite(override)) return Math.max(override, 0.0001);
  return Math.max(0.02, Math.abs(price) * 0.003);
}

export class AnalysisStore {
  private previewByTool = new Map<FxAnalysisToolId, FxAnalysisResult>();
  private savedResults: FxAnalysisResult[] = [];
  private selectedResultId: string | null = null;
  private storageKey = makeStorageKey("SPY", "5m");

  setWorkspace(symbol?: string, timeframe?: string): void {
    this.storageKey = makeStorageKey(symbol, timeframe);
    this.previewByTool.clear();
    this.selectedResultId = null;
    this.load();
  }

  getAll(): FxAnalysisResult[] {
    return [
      ...this.savedResults.map(cloneResult),
      ...[...this.previewByTool.values()].map(cloneResult),
    ];
  }

  getSaved(): FxAnalysisResult[] {
    return this.savedResults.map(cloneResult);
  }

  getPreview(tool: FxAnalysisToolId): FxAnalysisResult | undefined {
    const result = this.previewByTool.get(tool);
    return result ? cloneResult(result) : undefined;
  }

  getSelectedId(): string | null {
    return this.selectedResultId;
  }

  select(id: string | null): void {
    this.selectedResultId = id;
  }

  addResult(result: FxAnalysisResult, saved: boolean): void {
    if (result.tool === "none") return;

    if (!saved) {
      this.previewByTool.set(result.tool, cloneResult(result));
      this.selectedResultId = result.id;
      return;
    }

    const existingIndex = this.savedResults.findIndex((item) => item.id === result.id);

    if (existingIndex >= 0) {
      this.savedResults[existingIndex] = cloneResult(result);
    } else {
      this.savedResults.push(cloneResult(result));
    }

    this.previewByTool.delete(result.tool);
    this.selectedResultId = result.id;
    this.save();
  }

  hitTestAt(params: {
    time: number;
    price: number;
    priceTolerance?: number;
  }): FxAnalysisHit | null {
    const time = Number(params.time);
    const price = Number(params.price);

    if (!Number.isFinite(time) || !Number.isFinite(price)) return null;

    const tolerance = getPriceTolerance(price, params.priceTolerance);
    const results = this.getAll();

    for (let index = results.length - 1; index >= 0; index -= 1) {
      const result = results[index];
      if (!result || result.tool === "none") continue;

      const anchorTime = Number(result.anchorTime);
      const isToRightOfAnchor = !Number.isFinite(anchorTime) || time >= anchorTime;

      if (result.zone && isToRightOfAnchor) {
        const low = Number(result.zone.low);
        const high = Number(result.zone.high);

        if (Number.isFinite(low) && Number.isFinite(high)) {
          const bottom = Math.min(low, high);
          const top = Math.max(low, high);

          if (price >= bottom - tolerance && price <= top + tolerance) {
            return {
              resultId: result.id,
              objectId: result.zone.id,
              kind: "zone",
            };
          }
        }
      }

      for (const line of [...(result.lines ?? [])].reverse()) {
        const linePrice = Number(line.price);
        if (!Number.isFinite(linePrice)) continue;

        if (Math.abs(price - linePrice) <= tolerance) {
          return {
            resultId: result.id,
            objectId: line.id,
            kind: "line",
          };
        }
      }
    }

    return null;
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

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return null;

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

    if (this.selectedResultId === id) {
      this.selectedResultId = null;
    }

    this.save();
  }

  removeSelected(): boolean {
    if (!this.selectedResultId) return false;

    this.remove(this.selectedResultId);
    return true;
  }

  clear(): void {
    this.previewByTool.clear();
    this.savedResults = [];
    this.selectedResultId = null;
    this.save();
  }

  private load(): void {
    this.savedResults = [];

    if (!canUseLocalStorage()) return;

    const saved = window.localStorage.getItem(this.storageKey);
    if (!saved) return;

    try {
      const parsed = JSON.parse(saved) as FxAnalysisResult[];
      if (!Array.isArray(parsed)) return;

      this.savedResults = parsed
        .filter((item) => item?.id && item.tool && item.tool !== "none")
        .map(cloneResult);
    } catch (error) {
      console.warn("[AnalysisStore] failed to load FX analysis", error);
    }
  }

  private save(): void {
    if (!canUseLocalStorage()) return;

    try {
      window.localStorage.setItem(this.storageKey, JSON.stringify(this.savedResults));
    } catch (error) {
      console.warn("[AnalysisStore] failed to save FX analysis", error);
    }
  }
}
