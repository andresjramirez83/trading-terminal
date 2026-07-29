// src/components/chart/DrawingStore.ts

import { API_BASE_URL } from "../../config";
import type { ChartDrawing } from "./DrawingTypes";

const STORAGE_PREFIX = "chart.drawings.v1";
const MARKET_STRUCTURE_STORAGE_PREFIX = "chart.market-structure.v1";
const SHARED_SCOPE = "shared";
const REMOTE_POLL_MS = 15_000;
const REMOTE_SAVE_DELAY_MS = 180;

type DrawingScope = "timeframe" | "shared";

type RemoteDrawingDocument = {
  drawings: ChartDrawing[];
  exists: boolean;
  revision: number;
  updatedAt: number | string | null;
};

type PendingMutation =
  | { kind: "upsert"; drawing: ChartDrawing }
  | { kind: "remove"; id: string; scope: DrawingScope }
  | { kind: "clear"; scope: DrawingScope | "all" }
  | { kind: "replace"; drawings: ChartDrawing[] };

type DrawingStoreListener = (drawings: ChartDrawing[]) => void;

function safeKeyPart(value: string): string {
  return String(value || "default")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "_");
}

function makeStorageKey(symbol: string, timeframe: string): string {
  return `${STORAGE_PREFIX}.${safeKeyPart(symbol)}.${safeKeyPart(timeframe)}`;
}

function makeMarketStructureStorageKey(symbol: string): string {
  return `${MARKET_STRUCTURE_STORAGE_PREFIX}.${safeKeyPart(symbol)}`;
}

function cloneDrawing<T extends ChartDrawing>(drawing: T): T {
  return JSON.parse(JSON.stringify(drawing)) as T;
}

function cloneDrawings(drawings: ChartDrawing[]): ChartDrawing[] {
  return drawings.map((drawing) => cloneDrawing(drawing));
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function isValidDrawing(value: unknown): value is ChartDrawing {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

function parseStoredDrawings(
  storageKey: string,
  allowed: (drawing: ChartDrawing) => boolean,
): ChartDrawing[] {
  if (!canUseLocalStorage()) return [];

  const saved = window.localStorage.getItem(storageKey);
  if (!saved) return [];

  try {
    const parsed = JSON.parse(saved) as unknown;

    if (!Array.isArray(parsed)) return [];

    return cloneDrawings(
      parsed.filter(isValidDrawing).filter(allowed),
    );
  } catch (error) {
    console.warn("[DrawingStore] failed to load drawings", {
      storageKey,
      error,
    });
    return [];
  }
}

function scopeForDrawing(drawing: ChartDrawing): DrawingScope {
  return drawing.type === "marketStructure" ? "shared" : "timeframe";
}

function drawingsForScope(
  drawings: ChartDrawing[],
  scope: DrawingScope,
): ChartDrawing[] {
  return drawings.filter((drawing) => scopeForDrawing(drawing) === scope);
}

function drawingsEqual(a: ChartDrawing[], b: ChartDrawing[]): boolean {
  if (a.length !== b.length) return false;

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function mergeScopes(
  timeframeDrawings: ChartDrawing[],
  sharedDrawings: ChartDrawing[],
): ChartDrawing[] {
  const seenIds = new Set<string>();
  const merged: ChartDrawing[] = [];

  for (const drawing of [...timeframeDrawings, ...sharedDrawings]) {
    if (seenIds.has(drawing.id)) continue;
    seenIds.add(drawing.id);
    merged.push(cloneDrawing(drawing));
  }

  return merged;
}

function applyMutation(
  drawings: ChartDrawing[],
  mutation: PendingMutation,
): ChartDrawing[] {
  if (mutation.kind === "replace") {
    return cloneDrawings(mutation.drawings);
  }

  if (mutation.kind === "clear") {
    if (mutation.scope === "all") return [];
    return drawings.filter(
      (drawing) => scopeForDrawing(drawing) !== mutation.scope,
    );
  }

  if (mutation.kind === "remove") {
    return drawings.filter(
      (drawing) =>
        !(
          drawing.id === mutation.id &&
          scopeForDrawing(drawing) === mutation.scope
        ),
    );
  }

  const next = cloneDrawings(drawings);
  const index = next.findIndex((drawing) => drawing.id === mutation.drawing.id);

  if (index >= 0) {
    next[index] = cloneDrawing(mutation.drawing);
  } else {
    next.push(cloneDrawing(mutation.drawing));
  }

  return next;
}

function mutationScopes(mutation: PendingMutation): DrawingScope[] {
  if (mutation.kind === "replace") {
    return ["timeframe", "shared"];
  }

  if (mutation.kind === "clear") {
    return mutation.scope === "all"
      ? ["timeframe", "shared"]
      : [mutation.scope];
  }

  if (mutation.kind === "upsert") {
    return [scopeForDrawing(mutation.drawing)];
  }

  return [mutation.scope];
}

export class DrawingStore {
  private drawings: ChartDrawing[] = [];
  private symbol = "SPY";
  private timeframe = "5m";
  private storageKey = makeStorageKey(this.symbol, this.timeframe);
  private marketStructureStorageKey =
    makeMarketStructureStorageKey(this.symbol);

  private listeners = new Set<DrawingStoreListener>();
  private workspaceGeneration = 0;
  private remoteInitialized = false;
  private remoteRevision: Record<DrawingScope, number> = {
    timeframe: 0,
    shared: 0,
  };
  private pendingMutations: PendingMutation[] = [];
  private dirtyScopes = new Set<DrawingScope>();
  private saveTimer: number | null = null;
  private pollTimer: number | null = null;
  private refreshInFlight = false;
  private refreshRequestedInitial = false;
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

  constructor(symbol = "SPY", timeframe = "5m") {
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

    this.setWorkspace(symbol, timeframe);
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

  subscribe(listener: DrawingStoreListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  setWorkspace(symbol: string, timeframe: string): void {
    if (
      this.remoteInitialized &&
      this.dirtyScopes.size > 0 &&
      !this.saveInFlight
    ) {
      void this.persistRemote();
    }

    this.symbol = String(symbol || "SPY").trim().toUpperCase();
    this.timeframe = String(timeframe || "5m").trim().toLowerCase();
    this.storageKey = makeStorageKey(this.symbol, this.timeframe);
    this.marketStructureStorageKey =
      makeMarketStructureStorageKey(this.symbol);

    this.workspaceGeneration += 1;
    this.remoteInitialized = false;
    this.remoteRevision = { timeframe: 0, shared: 0 };
    this.pendingMutations = [];
    this.dirtyScopes.clear();

    if (this.saveTimer != null && typeof window !== "undefined") {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    this.loadLocal();
    void this.refreshFromBackend(true);
  }

  getWorkspace(): {
    symbol: string;
    timeframe: string;
    storageKey: string;
    marketStructureStorageKey: string;
  } {
    return {
      symbol: this.symbol,
      timeframe: this.timeframe,
      storageKey: this.storageKey,
      marketStructureStorageKey: this.marketStructureStorageKey,
    };
  }

  getAll(): ChartDrawing[] {
    return this.drawings;
  }

  get(id: string): ChartDrawing | undefined {
    return this.drawings.find((drawing) => drawing.id === id);
  }

  add(drawing: ChartDrawing): void {
    const existingIndex = this.drawings.findIndex(
      (item) => item.id === drawing.id,
    );

    if (existingIndex >= 0) {
      const previousScope = scopeForDrawing(this.drawings[existingIndex]);
      const nextScope = scopeForDrawing(drawing);
      this.drawings[existingIndex] = cloneDrawing(drawing);

      if (previousScope !== nextScope) {
        this.recordMutation({
          kind: "remove",
          id: drawing.id,
          scope: previousScope,
        });
      }
    } else {
      this.drawings.push(cloneDrawing(drawing));
    }

    this.recordMutation({ kind: "upsert", drawing: cloneDrawing(drawing) });
    this.saveLocal();
    this.scheduleRemoteSave();
  }

  update(updated: ChartDrawing): void {
    const index = this.drawings.findIndex(
      (drawing) => drawing.id === updated.id,
    );

    if (index < 0) return;

    const previousScope = scopeForDrawing(this.drawings[index]);
    const nextScope = scopeForDrawing(updated);
    this.drawings[index] = cloneDrawing(updated);

    if (previousScope !== nextScope) {
      this.recordMutation({
        kind: "remove",
        id: updated.id,
        scope: previousScope,
      });
    }

    this.recordMutation({ kind: "upsert", drawing: cloneDrawing(updated) });
    this.saveLocal();
    this.scheduleRemoteSave();
  }

  remove(id: string): void {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing) return;

    this.drawings = this.drawings.filter((item) => item.id !== id);
    this.recordMutation({
      kind: "remove",
      id,
      scope: scopeForDrawing(drawing),
    });
    this.saveLocal();
    this.scheduleRemoteSave();
  }

  clear(): void {
    this.drawings = [];
    this.recordMutation({ kind: "clear", scope: "all" });
    this.saveLocal();
    this.scheduleRemoteSave();
  }

  setAll(drawings: ChartDrawing[]): void {
    this.drawings = cloneDrawings(drawings);
    this.recordMutation({
      kind: "replace",
      drawings: cloneDrawings(drawings),
    });
    this.saveLocal();
    this.scheduleRemoteSave();
  }

  reload(): void {
    this.loadLocal();
    this.notifyListeners();
    void this.refreshFromBackend(true);
  }

  private recordMutation(mutation: PendingMutation): void {
    if (!this.remoteInitialized) {
      this.pendingMutations.push(mutation);
      return;
    }

    for (const scope of mutationScopes(mutation)) {
      this.dirtyScopes.add(scope);
    }
  }

  private loadLocal(): void {
    if (!canUseLocalStorage()) {
      this.drawings = [];
      return;
    }

    const timeframeDrawings = parseStoredDrawings(
      this.storageKey,
      (drawing) => drawing.type !== "marketStructure",
    );

    const symbolMarketStructures = parseStoredDrawings(
      this.marketStructureStorageKey,
      (drawing) => drawing.type === "marketStructure",
    );

    this.drawings = mergeScopes(
      timeframeDrawings,
      symbolMarketStructures,
    );
  }

  private saveLocal(): void {
    if (!canUseLocalStorage()) return;

    const timeframeDrawings = drawingsForScope(
      this.drawings,
      "timeframe",
    );
    const symbolMarketStructures = drawingsForScope(
      this.drawings,
      "shared",
    );

    try {
      window.localStorage.setItem(
        this.storageKey,
        JSON.stringify(timeframeDrawings),
      );

      window.localStorage.setItem(
        this.marketStructureStorageKey,
        JSON.stringify(symbolMarketStructures),
      );
    } catch (error) {
      console.warn("[DrawingStore] failed to save drawings", {
        storageKey: this.storageKey,
        marketStructureStorageKey: this.marketStructureStorageKey,
        error,
      });
    }
  }

  private remoteScopeName(scope: DrawingScope): string {
    return scope === "shared" ? SHARED_SCOPE : this.timeframe;
  }

  private remoteUrl(
    symbol: string,
    scopeName: string,
  ): string {
    return `${API_BASE_URL}/chart/drawings/${encodeURIComponent(symbol)}/${encodeURIComponent(scopeName)}`;
  }

  private async fetchRemoteScope(
    symbol: string,
    scopeName: string,
    scope: DrawingScope,
  ): Promise<RemoteDrawingDocument> {
    const response = await fetch(this.remoteUrl(symbol, scopeName), {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    if (!response.ok) {
      throw new Error(
        `Drawing load failed (${response.status}) for ${symbol}/${scopeName}`,
      );
    }

    const payload = await response.json() as Record<string, unknown>;
    const raw = Array.isArray(payload.drawings)
      ? payload.drawings
      : Array.isArray(payload.items)
        ? payload.items
        : [];

    const drawings = cloneDrawings(
      raw
        .filter(isValidDrawing)
        .filter((drawing) => scopeForDrawing(drawing) === scope),
    );

    const revisionValue = Number(payload.revision ?? 0);

    return {
      drawings,
      exists: payload.exists === true,
      revision: Number.isFinite(revisionValue)
        ? Math.max(0, revisionValue)
        : 0,
      updatedAt:
        typeof payload.updatedAt === "number" ||
        typeof payload.updatedAt === "string"
          ? payload.updatedAt
          : null,
    };
  }

  private async putRemoteScope(
    symbol: string,
    scopeName: string,
    drawings: ChartDrawing[],
  ): Promise<number> {
    const response = await fetch(this.remoteUrl(symbol, scopeName), {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ drawings: cloneDrawings(drawings) }),
    });

    if (!response.ok) {
      throw new Error(
        `Drawing save failed (${response.status}) for ${symbol}/${scopeName}`,
      );
    }

    const payload = await response.json() as Record<string, unknown>;
    const revisionValue = Number(payload.revision ?? 0);
    return Number.isFinite(revisionValue)
      ? Math.max(0, revisionValue)
      : 0;
  }

  private async refreshFromBackend(initial: boolean): Promise<void> {
    if (this.destroyed) return;

    if (this.refreshInFlight) {
      if (initial) this.refreshRequestedInitial = true;
      return;
    }

    if (
      !initial &&
      (!this.remoteInitialized ||
        this.saveInFlight ||
        this.dirtyScopes.size > 0)
    ) {
      return;
    }

    const generation = this.workspaceGeneration;
    const symbol = this.symbol;
    const timeframeScope = this.timeframe;
    const localSnapshot = cloneDrawings(this.drawings);

    this.refreshInFlight = true;

    try {
      const [timeframeRemote, sharedRemote] = await Promise.all([
        this.fetchRemoteScope(
          symbol,
          timeframeScope,
          "timeframe",
        ),
        this.fetchRemoteScope(symbol, SHARED_SCOPE, "shared"),
      ]);

      if (
        this.destroyed ||
        generation !== this.workspaceGeneration ||
        symbol !== this.symbol ||
        timeframeScope !== this.timeframe
      ) {
        return;
      }

      if (initial || !this.remoteInitialized) {
        const localTimeframe = drawingsForScope(
          localSnapshot,
          "timeframe",
        );
        const localShared = drawingsForScope(localSnapshot, "shared");

        let next = mergeScopes(
          timeframeRemote.exists
            ? timeframeRemote.drawings
            : localTimeframe,
          sharedRemote.exists
            ? sharedRemote.drawings
            : localShared,
        );

        for (const mutation of this.pendingMutations) {
          next = applyMutation(next, mutation);
          for (const scope of mutationScopes(mutation)) {
            this.dirtyScopes.add(scope);
          }
        }

        if (!timeframeRemote.exists && localTimeframe.length > 0) {
          this.dirtyScopes.add("timeframe");
        }

        if (!sharedRemote.exists && localShared.length > 0) {
          this.dirtyScopes.add("shared");
        }

        const changed = !drawingsEqual(this.drawings, next);
        this.drawings = cloneDrawings(next);
        this.pendingMutations = [];
        this.remoteInitialized = true;
        this.remoteRevision = {
          timeframe: timeframeRemote.revision,
          shared: sharedRemote.revision,
        };
        this.saveLocal();

        if (changed) {
          this.notifyListeners();
        }

        this.scheduleRemoteSave();
        return;
      }

      let nextTimeframe = drawingsForScope(
        this.drawings,
        "timeframe",
      );
      let nextShared = drawingsForScope(this.drawings, "shared");
      let changed = false;

      if (
        timeframeRemote.exists &&
        timeframeRemote.revision !== this.remoteRevision.timeframe
      ) {
        nextTimeframe = timeframeRemote.drawings;
        this.remoteRevision.timeframe = timeframeRemote.revision;
        changed = true;
      }

      if (
        sharedRemote.exists &&
        sharedRemote.revision !== this.remoteRevision.shared
      ) {
        nextShared = sharedRemote.drawings;
        this.remoteRevision.shared = sharedRemote.revision;
        changed = true;
      }

      if (changed) {
        const next = mergeScopes(nextTimeframe, nextShared);
        const actuallyChanged = !drawingsEqual(this.drawings, next);
        this.drawings = next;
        this.saveLocal();

        if (actuallyChanged) {
          this.notifyListeners();
        }
      }
    } catch (error) {
      console.warn("[DrawingStore] backend drawing sync failed", {
        symbol,
        timeframe: timeframeScope,
        error,
      });
    } finally {
      this.refreshInFlight = false;

      if (this.refreshRequestedInitial && !this.destroyed) {
        this.refreshRequestedInitial = false;
        void this.refreshFromBackend(true);
      }
    }
  }

  private scheduleRemoteSave(): void {
    if (
      this.destroyed ||
      !this.remoteInitialized ||
      this.dirtyScopes.size === 0 ||
      typeof window === "undefined"
    ) {
      return;
    }

    if (this.saveTimer != null) {
      window.clearTimeout(this.saveTimer);
    }

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
      this.dirtyScopes.size === 0
    ) {
      return;
    }

    const generation = this.workspaceGeneration;
    const symbol = this.symbol;
    const timeframe = this.timeframe;
    const scopes = Array.from(this.dirtyScopes);
    const snapshot = cloneDrawings(this.drawings);

    for (const scope of scopes) {
      this.dirtyScopes.delete(scope);
    }

    this.saveInFlight = true;

    try {
      const results = await Promise.all(
        scopes.map(async (scope) => {
          const scopeName = scope === "shared" ? SHARED_SCOPE : timeframe;
          const revision = await this.putRemoteScope(
            symbol,
            scopeName,
            drawingsForScope(snapshot, scope),
          );
          return { scope, revision };
        }),
      );

      if (
        generation === this.workspaceGeneration &&
        symbol === this.symbol &&
        timeframe === this.timeframe
      ) {
        for (const result of results) {
          this.remoteRevision[result.scope] = result.revision;
        }
      }
    } catch (error) {
      if (
        generation === this.workspaceGeneration &&
        symbol === this.symbol &&
        timeframe === this.timeframe
      ) {
        for (const scope of scopes) {
          this.dirtyScopes.add(scope);
        }
      }

      console.warn("[DrawingStore] backend drawing save failed", {
        symbol,
        timeframe,
        scopes,
        error,
      });
    } finally {
      this.saveInFlight = false;

      if (
        generation === this.workspaceGeneration &&
        this.dirtyScopes.size > 0
      ) {
        this.scheduleRemoteSave();
      }
    }
  }

  private notifyListeners(): void {
    const snapshot = cloneDrawings(this.drawings);

    for (const listener of this.listeners) {
      listener(snapshot);
    }
  }
}
