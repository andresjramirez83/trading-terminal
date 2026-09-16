// src/trading/execution/router/ExecutionModeRuntime.ts

export type ExecutionMode = "paper" | "live" | "practice";

export type ExecutionModeListener = (
  mode: ExecutionMode,
  previousMode: ExecutionMode,
) => void;

// LIVE is intentionally the startup default on every fresh app/page load.
// PAPER is a deliberate current-session choice only.

function loadInitialMode(): ExecutionMode {
  return "live";
}

export class ExecutionModeRuntime {
  private mode: ExecutionMode;
  private listeners = new Set<ExecutionModeListener>();

  constructor(initialMode: ExecutionMode = loadInitialMode()) {
    this.mode = initialMode;
  }

  getMode(): ExecutionMode {
    return this.mode;
  }

  isPractice(): boolean {
    return this.mode === "practice";
  }

  isPaper(): boolean {
    return this.mode === "paper";
  }

  isLive(): boolean {
    return this.mode === "live";
  }

  usesAlpaca(): boolean {
    return this.mode === "paper" || this.mode === "live";
  }

  setMode(nextMode: ExecutionMode): void {
    if (nextMode === this.mode) {
      return;
    }

    const previousMode = this.mode;
    this.mode = nextMode;

    for (const listener of this.listeners) {
      listener(nextMode, previousMode);
    }
  }

  subscribe(listener: ExecutionModeListener): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.setMode("live");
  }

  destroy(): void {
    this.listeners.clear();
  }
}

let sharedExecutionModeRuntime: ExecutionModeRuntime | null = null;

export function getSharedExecutionModeRuntime(): ExecutionModeRuntime {
  if (!sharedExecutionModeRuntime) {
    sharedExecutionModeRuntime = new ExecutionModeRuntime();
  }

  return sharedExecutionModeRuntime;
}

export function resetSharedExecutionModeRuntime(): void {
  sharedExecutionModeRuntime?.destroy();
  sharedExecutionModeRuntime = null;
}