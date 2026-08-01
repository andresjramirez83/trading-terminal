import type {
  FxAnalysisResult,
  FxAnalysisSettings,
  FxAnalysisToolId,
} from "./AnalysisTypes";
import { API_BASE } from "../../../services/api";

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
const REMOTE_SCOPE = "analysis";
const REMOTE_POLL_MS = 3_000;
const REMOTE_SAVE_DELAY_MS = 120;

type RemoteAnalysisDocument = {
  items: FxAnalysisResult[];
  exists: boolean;
  revision: number;
};

type SavedAnalysisMutation =
  | { kind: "upsert"; item: FxAnalysisResult }
  | { kind: "remove"; id: string }
  | { kind: "clear" };

type AnalysisStoreListener = () => void;

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

function cloneResults(results: FxAnalysisResult[]): FxAnalysisResult[] {
  return results.map(cloneResult);
}

function isValidResult(value: unknown): value is FxAnalysisResult {
  if (value == null || typeof value !== "object") return false;

  const result = value as Partial<FxAnalysisResult>;
  return (
    typeof result.id === "string" &&
    (result.tool === "supportPrediction" ||
      result.tool === "resistancePrediction" ||
      result.tool === "demandZone")
  );
}

function resultsEqual(
  left: FxAnalysisResult[],
  right: FxAnalysisResult[],
): boolean {
  if (left.length !== right.length) return false;

  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function applySavedMutation(
  results: FxAnalysisResult[],
  mutation: SavedAnalysisMutation,
): FxAnalysisResult[] {
  if (mutation.kind === "clear") return [];

  if (mutation.kind === "remove") {
    return results.filter((item) => item.id !== mutation.id);
  }

  const next = cloneResults(results);
  const index = next.findIndex((item) => item.id === mutation.item.id);

  if (index >= 0) {
    next[index] = cloneResult(mutation.item);
  } else {
    next.push(cloneResult(mutation.item));
  }

  return next;
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
  private symbol = "SPY";
  private listeners = new Set<AnalysisStoreListener>();
  private workspaceGeneration = 0;
  private remoteInitialized = false;
  private remoteRevision = 0;
  private pendingBeforeInitialLoad: SavedAnalysisMutation[] = [];
  private remoteQueue: SavedAnalysisMutation[] = [];
  private saveTimer: number | null = null;
  private pollTimer: number | null = null;
  private refreshInFlight = false;
  private refreshRequested = false;
  private saveInFlight = false;
  private destroyed = false;

  private readonly handleFocus = (): void => {
    void this.refreshFromBackend(false);
  };

  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") {
      void this.refreshFromBackend(false);
    }
  };

  constructor() {
    if (typeof window !== "undefined") {
      window.addEventListener("focus", this.handleFocus);
      document.addEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );

      this.pollTimer = window.setInterval(() => {
        void this.refreshFromBackend(false);
      }, REMOTE_POLL_MS);
    }

    this.setWorkspace("SPY", "5m");
  }

  destroy(): void {
    this.destroyed = true;

    if (typeof window !== "undefined") {
      window.removeEventListener("focus", this.handleFocus);
      document.removeEventListener(
        "visibilitychange",
        this.handleVisibilityChange,
      );

      if (this.pollTimer != null) {
        window.clearInterval(this.pollTimer);
        this.pollTimer = null;
      }

      if (this.saveTimer != null) {
        window.clearTimeout(this.saveTimer);
        this.saveTimer = null;
      }
    }

    this.listeners.clear();
  }

  subscribe(listener: AnalysisStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setWorkspace(symbol?: string, timeframe?: string): void {
    if (
      this.remoteInitialized &&
      this.remoteQueue.length > 0 &&
      !this.saveInFlight
    ) {
      void this.persistRemote();
    }

    this.symbol = String(symbol || "SPY").trim().toUpperCase();
    this.storageKey = makeStorageKey(symbol, timeframe);
    this.previewByTool.clear();
    this.selectedResultId = null;
    this.workspaceGeneration += 1;
    this.remoteInitialized = false;
    this.remoteRevision = 0;
    this.pendingBeforeInitialLoad = [];
    this.remoteQueue = [];

    if (this.saveTimer != null && typeof window !== "undefined") {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    this.load();
    this.notifyListeners();
    void this.refreshFromBackend(true);
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
    this.notifyListeners();
  }

  addResult(result: FxAnalysisResult, saved: boolean): void {
    if (result.tool === "none") return;

    if (!saved) {
      this.previewByTool.set(result.tool, cloneResult(result));
      this.selectedResultId = result.id;
      this.notifyListeners();
      return;
    }

    this.previewByTool.delete(result.tool);
    this.selectedResultId = result.id;
    this.commitSavedMutation({ kind: "upsert", item: cloneResult(result) });
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
    const hadSavedResult = this.savedResults.some((item) => item.id === id);

    for (const [tool, result] of this.previewByTool.entries()) {
      if (result.id === id) {
        this.previewByTool.delete(tool);
      }
    }

    if (this.selectedResultId === id) {
      this.selectedResultId = null;
    }

    if (hadSavedResult) {
      this.commitSavedMutation({ kind: "remove", id });
    } else {
      this.notifyListeners();
    }
  }

  removeSelected(): boolean {
    if (!this.selectedResultId) return false;

    this.remove(this.selectedResultId);
    return true;
  }

  clear(): void {
    this.previewByTool.clear();
    this.selectedResultId = null;
    this.commitSavedMutation({ kind: "clear" });
  }

  private commitSavedMutation(mutation: SavedAnalysisMutation): void {
    this.savedResults = applySavedMutation(this.savedResults, mutation);
    this.save();
    this.notifyListeners();

    if (this.remoteInitialized) {
      this.remoteQueue.push(mutation);
      this.compactRemoteQueue();
      this.scheduleRemoteSave();
    } else {
      this.pendingBeforeInitialLoad.push(mutation);
    }
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
        .filter(isValidResult)
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

  private remoteUrl(symbol: string): string {
    return `${API_BASE}/chart/projections/${encodeURIComponent(symbol)}/${REMOTE_SCOPE}`;
  }

  private async fetchRemote(symbol: string): Promise<RemoteAnalysisDocument> {
    const response = await fetch(this.remoteUrl(symbol), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `FX analysis load failed (${response.status}) for ${symbol}`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const raw = Array.isArray(payload.projections)
      ? payload.projections
      : Array.isArray(payload.items)
        ? payload.items
        : [];
    const revision = Number(payload.revision ?? 0);

    return {
      items: cloneResults(raw.filter(isValidResult)),
      exists: payload.exists !== false,
      revision: Number.isFinite(revision) ? Math.max(0, revision) : 0,
    };
  }

  private async sendRemoteMutation(
    symbol: string,
    mutation: SavedAnalysisMutation,
  ): Promise<number> {
    const baseUrl = this.remoteUrl(symbol);
    let response: Response;

    if (mutation.kind === "upsert") {
      response = await fetch(`${baseUrl}/upsert`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ item: cloneResult(mutation.item) }),
      });
    } else if (mutation.kind === "remove") {
      response = await fetch(`${baseUrl}/remove`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: mutation.id }),
      });
    } else {
      response = await fetch(`${baseUrl}/clear`, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
    }

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `FX analysis ${mutation.kind} failed (${response.status}) for ${symbol}: ${detail}`,
      );
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const revision = Number(payload.revision ?? 0);
    return Number.isFinite(revision) ? Math.max(0, revision) : 0;
  }

  private async refreshFromBackend(initial: boolean): Promise<void> {
    if (this.destroyed) return;

    if (this.refreshInFlight) {
      this.refreshRequested = true;
      return;
    }

    if (!initial && (!this.remoteInitialized || this.saveInFlight)) return;

    const generation = this.workspaceGeneration;
    const symbol = this.symbol;
    const localSnapshot = cloneResults(this.savedResults);
    this.refreshInFlight = true;

    try {
      const remote = await this.fetchRemote(symbol);

      if (
        this.destroyed ||
        generation !== this.workspaceGeneration ||
        symbol !== this.symbol
      ) {
        return;
      }

      if (initial || !this.remoteInitialized) {
        let next = remote.exists ? remote.items : localSnapshot;

        for (const mutation of this.pendingBeforeInitialLoad) {
          next = applySavedMutation(next, mutation);
          this.remoteQueue.push(mutation);
        }

        if (!remote.exists) {
          for (const item of localSnapshot) {
            this.remoteQueue.push({ kind: "upsert", item: cloneResult(item) });
          }
        }

        const changed = !resultsEqual(this.savedResults, next);
        this.savedResults = cloneResults(next);
        this.pendingBeforeInitialLoad = [];
        this.remoteInitialized = true;
        this.remoteRevision = remote.revision;
        this.compactRemoteQueue();
        this.save();

        if (changed) this.notifyListeners();
        this.scheduleRemoteSave();
        return;
      }

      if (
        this.remoteQueue.length === 0 &&
        remote.revision !== this.remoteRevision
      ) {
        const changed = !resultsEqual(this.savedResults, remote.items);
        this.savedResults = cloneResults(remote.items);
        this.remoteRevision = remote.revision;
        this.save();
        if (changed) this.notifyListeners();
      }
    } catch (error) {
      console.warn("[AnalysisStore] backend FX analysis sync failed", {
        symbol,
        error,
      });
    } finally {
      this.refreshInFlight = false;

      if (this.refreshRequested && !this.destroyed) {
        this.refreshRequested = false;
        void this.refreshFromBackend(false);
      }
    }
  }

  private compactRemoteQueue(): void {
    const compacted: SavedAnalysisMutation[] = [];

    for (const mutation of this.remoteQueue) {
      if (mutation.kind === "clear") {
        compacted.length = 0;
        compacted.push(mutation);
        continue;
      }

      const id = mutation.kind === "upsert" ? mutation.item.id : mutation.id;
      for (let index = compacted.length - 1; index >= 0; index -= 1) {
        const queued = compacted[index];
        if (queued.kind === "clear") break;
        const queuedId = queued.kind === "upsert" ? queued.item.id : queued.id;
        if (queuedId === id) compacted.splice(index, 1);
      }
      compacted.push(mutation);
    }

    this.remoteQueue = compacted;
  }

  private scheduleRemoteSave(): void {
    if (
      !this.remoteInitialized ||
      this.remoteQueue.length === 0 ||
      this.saveInFlight ||
      typeof window === "undefined"
    ) {
      return;
    }

    if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.persistRemote();
    }, REMOTE_SAVE_DELAY_MS);
  }

  private async persistRemote(): Promise<void> {
    if (
      this.destroyed ||
      !this.remoteInitialized ||
      this.saveInFlight ||
      this.remoteQueue.length === 0
    ) {
      return;
    }

    const generation = this.workspaceGeneration;
    const symbol = this.symbol;
    const batch = this.remoteQueue.splice(0, this.remoteQueue.length);
    this.saveInFlight = true;

    try {
      for (const mutation of batch) {
        const revision = await this.sendRemoteMutation(symbol, mutation);

        if (
          generation === this.workspaceGeneration &&
          symbol === this.symbol
        ) {
          this.remoteRevision = revision;
        }
      }
    } catch (error) {
      if (
        generation === this.workspaceGeneration &&
        symbol === this.symbol
      ) {
        this.remoteQueue.unshift(...batch);
        this.compactRemoteQueue();
      }

      console.warn("[AnalysisStore] backend FX analysis save failed", {
        symbol,
        error,
      });
    } finally {
      this.saveInFlight = false;

      if (
        generation === this.workspaceGeneration &&
        this.remoteQueue.length > 0
      ) {
        this.scheduleRemoteSave();
      } else if (generation === this.workspaceGeneration) {
        void this.refreshFromBackend(false);
      }
    }
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }
}
