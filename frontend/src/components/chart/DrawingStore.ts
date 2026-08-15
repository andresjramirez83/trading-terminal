// src/components/chart/DrawingStore.ts

import { API_BASE } from "../../services/api";
import type { ChartDrawing } from "./DrawingTypes";

const STORAGE_PREFIX = "chart.drawings.v1";
const MARKET_STRUCTURE_STORAGE_PREFIX = "chart.market-structure.v1";
const SHARED_SCOPE = "shared";
const REMOTE_POLL_MS = 10_000;
const REMOTE_SAVE_DELAY_MS = 120;

type DrawingScope = "timeframe" | "shared";

type RemoteDrawingDocument = {
  drawings: ChartDrawing[];
  exists: boolean;
  revision: number;
  updatedAt: number | string | null;
};

type DrawingMutation =
  | { kind: "upsert"; drawing: ChartDrawing }
  | { kind: "remove"; id: string; scope: DrawingScope }
  | { kind: "clear"; scope: DrawingScope | "all" }
  | { kind: "replace"; drawings: ChartDrawing[] };

type ScopedRemoteMutation =
  | { kind: "upsert"; scope: DrawingScope; drawing: ChartDrawing }
  | { kind: "remove"; scope: DrawingScope; id: string }
  | { kind: "clear"; scope: DrawingScope };

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

    return cloneDrawings(parsed.filter(isValidDrawing).filter(allowed));
  } catch (error) {
    console.warn("[DrawingStore] failed to load local drawings", {
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

function mergeScopes(
  timeframeDrawings: ChartDrawing[],
  sharedDrawings: ChartDrawing[],
): ChartDrawing[] {
  const byId = new Map<string, ChartDrawing>();

  for (const drawing of [...timeframeDrawings, ...sharedDrawings]) {
    byId.set(drawing.id, cloneDrawing(drawing));
  }

  return Array.from(byId.values());
}

function drawingsEqual(a: ChartDrawing[], b: ChartDrawing[]): boolean {
  if (a.length !== b.length) return false;

  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function applyMutation(
  drawings: ChartDrawing[],
  mutation: DrawingMutation,
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
  const index = next.findIndex(
    (drawing) => drawing.id === mutation.drawing.id,
  );

  if (index >= 0) {
    next[index] = cloneDrawing(mutation.drawing);
  } else {
    next.push(cloneDrawing(mutation.drawing));
  }

  return next;
}

function expandRemoteMutations(
  mutation: DrawingMutation,
): ScopedRemoteMutation[] {
  if (mutation.kind === "upsert") {
    return [
      {
        kind: "upsert",
        scope: scopeForDrawing(mutation.drawing),
        drawing: cloneDrawing(mutation.drawing),
      },
    ];
  }

  if (mutation.kind === "remove") {
    return [{ kind: "remove", scope: mutation.scope, id: mutation.id }];
  }

  if (mutation.kind === "clear") {
    return mutation.scope === "all"
      ? [
          { kind: "clear", scope: "timeframe" },
          { kind: "clear", scope: "shared" },
        ]
      : [{ kind: "clear", scope: mutation.scope }];
  }

  return [
    { kind: "clear", scope: "timeframe" },
    { kind: "clear", scope: "shared" },
    ...mutation.drawings.map(
      (drawing): ScopedRemoteMutation => ({
        kind: "upsert",
        scope: scopeForDrawing(drawing),
        drawing: cloneDrawing(drawing),
      }),
    ),
  ];
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
  private pendingBeforeInitialLoad: DrawingMutation[] = [];
  private remoteQueue: ScopedRemoteMutation[] = [];
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
    return () => this.listeners.delete(listener);
  }

  setWorkspace(symbol: string, timeframe: string): void {
    if (
      this.remoteInitialized &&
      this.remoteQueue.length > 0 &&
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
    this.pendingBeforeInitialLoad = [];
    this.remoteQueue = [];

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

      if (previousScope !== nextScope) {
        this.commitMutation({
          kind: "remove",
          id: drawing.id,
          scope: previousScope,
        });
      }
    }

    this.commitMutation({ kind: "upsert", drawing: cloneDrawing(drawing) });
  }

  update(updated: ChartDrawing): void {
    const existing = this.drawings.find(
      (drawing) => drawing.id === updated.id,
    );
    if (!existing) return;

    const previousScope = scopeForDrawing(existing);
    const nextScope = scopeForDrawing(updated);

    if (previousScope !== nextScope) {
      this.commitMutation({
        kind: "remove",
        id: updated.id,
        scope: previousScope,
      });
    }

    this.commitMutation({ kind: "upsert", drawing: cloneDrawing(updated) });
  }

  remove(id: string): void {
    const drawing = this.drawings.find((item) => item.id === id);
    if (!drawing) return;

    this.commitMutation({
      kind: "remove",
      id,
      scope: scopeForDrawing(drawing),
    });
  }

  clear(): void {
    this.commitMutation({ kind: "clear", scope: "all" });
  }

  setAll(drawings: ChartDrawing[]): void {
    this.commitMutation({
      kind: "replace",
      drawings: cloneDrawings(drawings),
    });
  }

  reload(): void {
    this.loadLocal();
    this.notifyListeners();
    void this.refreshFromBackend(true);
  }

  private commitMutation(mutation: DrawingMutation): void {
    this.drawings = applyMutation(this.drawings, mutation);
    this.saveLocal();

    if (this.remoteInitialized) {
      this.remoteQueue.push(...expandRemoteMutations(mutation));
      this.compactRemoteQueue();
      this.scheduleRemoteSave(
        mutation.kind === "remove" || mutation.kind === "clear",
      );
    } else {
      this.pendingBeforeInitialLoad.push(mutation);
    }
  }

  private loadLocal(): void {
    const timeframeDrawings = parseStoredDrawings(
      this.storageKey,
      (drawing) => drawing.type !== "marketStructure",
    );
    const sharedDrawings = parseStoredDrawings(
      this.marketStructureStorageKey,
      (drawing) => drawing.type === "marketStructure",
    );

    this.drawings = mergeScopes(timeframeDrawings, sharedDrawings);
  }

  private saveLocal(): void {
    if (!canUseLocalStorage()) return;

    try {
      window.localStorage.setItem(
        this.storageKey,
        JSON.stringify(drawingsForScope(this.drawings, "timeframe")),
      );
      window.localStorage.setItem(
        this.marketStructureStorageKey,
        JSON.stringify(drawingsForScope(this.drawings, "shared")),
      );
    } catch (error) {
      console.warn("[DrawingStore] failed to save local drawings", {
        storageKey: this.storageKey,
        marketStructureStorageKey: this.marketStructureStorageKey,
        error,
      });
    }
  }

  private remoteScopeName(scope: DrawingScope): string {
    return scope === "shared" ? SHARED_SCOPE : this.timeframe;
  }

  private remoteUrl(symbol: string, scopeName: string): string {
    return `${API_BASE}/chart/drawings/${encodeURIComponent(symbol)}/${encodeURIComponent(scopeName)}`;
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

    return this.parseRemoteDocument(await response.json(), scope);
  }

  private parseRemoteDocument(
    payload: unknown,
    scope: DrawingScope,
  ): RemoteDrawingDocument {
    const record =
      payload != null && typeof payload === "object"
        ? (payload as Record<string, unknown>)
        : {};
    const raw = Array.isArray(record.drawings)
      ? record.drawings
      : Array.isArray(record.items)
        ? record.items
        : [];
    const revision = Number(record.revision ?? 0);

    return {
      drawings: cloneDrawings(
        raw
          .filter(isValidDrawing)
          .filter((drawing) => scopeForDrawing(drawing) === scope),
      ),
      exists: record.exists !== false,
      revision: Number.isFinite(revision) ? Math.max(0, revision) : 0,
      updatedAt:
        typeof record.updatedAt === "number" ||
        typeof record.updatedAt === "string"
          ? record.updatedAt
          : null,
    };
  }

  private async sendAtomicMutation(
    symbol: string,
    timeframe: string,
    mutation: ScopedRemoteMutation,
  ): Promise<number> {
    const scopeName =
      mutation.scope === "shared" ? SHARED_SCOPE : timeframe;
    const baseUrl = this.remoteUrl(symbol, scopeName);

    let response: Response;

    if (mutation.kind === "upsert") {
      response = await fetch(`${baseUrl}/upsert`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ drawing: cloneDrawing(mutation.drawing) }),
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
        `Drawing ${mutation.kind} failed (${response.status}) for ${symbol}/${scopeName}: ${detail}`,
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
    const timeframe = this.timeframe;
    const localSnapshot = cloneDrawings(this.drawings);

    this.refreshInFlight = true;

    try {
      const [timeframeRemote, sharedRemote] = await Promise.all([
        this.fetchRemoteScope(symbol, timeframe, "timeframe"),
        this.fetchRemoteScope(symbol, SHARED_SCOPE, "shared"),
      ]);

      if (
        this.destroyed ||
        generation !== this.workspaceGeneration ||
        symbol !== this.symbol ||
        timeframe !== this.timeframe
      ) {
        return;
      }

      if (initial || !this.remoteInitialized) {
        const localTimeframe = drawingsForScope(localSnapshot, "timeframe");
        const localShared = drawingsForScope(localSnapshot, "shared");

        let next = mergeScopes(
          timeframeRemote.exists
            ? timeframeRemote.drawings
            : localTimeframe,
          sharedRemote.exists ? sharedRemote.drawings : localShared,
        );

        for (const mutation of this.pendingBeforeInitialLoad) {
          next = applyMutation(next, mutation);
          this.remoteQueue.push(...expandRemoteMutations(mutation));
        }

        if (!timeframeRemote.exists) {
          for (const drawing of localTimeframe) {
            this.remoteQueue.push({
              kind: "upsert",
              scope: "timeframe",
              drawing: cloneDrawing(drawing),
            });
          }
        }

        if (!sharedRemote.exists) {
          for (const drawing of localShared) {
            this.remoteQueue.push({
              kind: "upsert",
              scope: "shared",
              drawing: cloneDrawing(drawing),
            });
          }
        }

        const changed = !drawingsEqual(this.drawings, next);
        this.drawings = cloneDrawings(next);
        this.pendingBeforeInitialLoad = [];
        this.remoteInitialized = true;
        this.remoteRevision = {
          timeframe: timeframeRemote.revision,
          shared: sharedRemote.revision,
        };
        this.compactRemoteQueue();
        this.saveLocal();

        if (changed) this.notifyListeners();
        this.scheduleRemoteSave();
        return;
      }

      if (this.remoteQueue.length > 0) return;

      const currentTimeframe = drawingsForScope(
        this.drawings,
        "timeframe",
      );
      const currentShared = drawingsForScope(this.drawings, "shared");
      let nextTimeframe = currentTimeframe;
      let nextShared = currentShared;
      let revisionChanged = false;

      if (timeframeRemote.revision !== this.remoteRevision.timeframe) {
        nextTimeframe = timeframeRemote.drawings;
        this.remoteRevision.timeframe = timeframeRemote.revision;
        revisionChanged = true;
      }

      if (sharedRemote.revision !== this.remoteRevision.shared) {
        nextShared = sharedRemote.drawings;
        this.remoteRevision.shared = sharedRemote.revision;
        revisionChanged = true;
      }

      if (revisionChanged) {
        const next = mergeScopes(nextTimeframe, nextShared);
        const changed = !drawingsEqual(this.drawings, next);
        this.drawings = next;
        this.saveLocal();
        if (changed) this.notifyListeners();
      }
    } catch (error) {
      console.warn("[DrawingStore] backend drawing sync failed", {
        symbol,
        timeframe,
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
    const compacted: ScopedRemoteMutation[] = [];

    for (const mutation of this.remoteQueue) {
      if (mutation.kind === "clear") {
        for (let index = compacted.length - 1; index >= 0; index -= 1) {
          if (compacted[index].scope === mutation.scope) {
            compacted.splice(index, 1);
          }
        }
        compacted.push(mutation);
        continue;
      }

      const id = mutation.kind === "upsert" ? mutation.drawing.id : mutation.id;
      for (let index = compacted.length - 1; index >= 0; index -= 1) {
        const existing = compacted[index];
        if (existing.scope !== mutation.scope || existing.kind === "clear") {
          continue;
        }
        const existingId =
          existing.kind === "upsert" ? existing.drawing.id : existing.id;
        if (existingId === id) {
          compacted.splice(index, 1);
          break;
        }
      }
      compacted.push(mutation);
    }

    this.remoteQueue = compacted;
  }

  private scheduleRemoteSave(immediate = false): void {
    if (
      this.destroyed ||
      !this.remoteInitialized ||
      this.remoteQueue.length === 0 ||
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
    }, immediate ? 0 : REMOTE_SAVE_DELAY_MS);
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
    const timeframe = this.timeframe;
    const batch = this.remoteQueue.splice(0, this.remoteQueue.length);
    this.saveInFlight = true;

    try {
      for (const mutation of batch) {
        const revision = await this.sendAtomicMutation(
          symbol,
          timeframe,
          mutation,
        );

        if (
          generation === this.workspaceGeneration &&
          symbol === this.symbol &&
          timeframe === this.timeframe
        ) {
          this.remoteRevision[mutation.scope] = revision;
        }
      }
    } catch (error) {
      if (
        generation === this.workspaceGeneration &&
        symbol === this.symbol &&
        timeframe === this.timeframe
      ) {
        this.remoteQueue.unshift(...batch);
        this.compactRemoteQueue();
      }

      console.warn("[DrawingStore] backend drawing save failed", {
        symbol,
        timeframe,
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
    const snapshot = cloneDrawings(this.drawings);
    for (const listener of this.listeners) listener(snapshot);
  }
}
