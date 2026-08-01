// src/trading/replay/ReplayRuntime.ts

import type { CleanBar } from "../../components/chart/ChartTypes";
import { getReplayExecutionProvider } from "../execution/router/ExecutionProviderRuntime";
import { ReplayMarketDataProvider } from "./ReplayMarketDataProvider";
import {
  getSharedReplaySessionManager,
  type ReplaySession,
} from "./ReplaySessionManager";
import type {
  ReplayListener,
  ReplaySessionConfig,
  ReplaySnapshot,
  ReplaySpeed,
} from "./ReplayTypes";

const DEFAULT_SPEED: ReplaySpeed = 1;

function emptySnapshot(): ReplaySnapshot {
  return {
    mode: "replay",
    state: "idle",

    symbol: "",
    timeframe: "",

    speed: DEFAULT_SPEED,

    bars: [],
    visibleBars: [],

    currentIndex: 0,
    currentBar: null,
    currentTime: null,

    progress: 0,
    error: null,
    session: null,
  };
}

function normalizeTradingDate(
  value: string | undefined,
): string | null {
  const normalized = String(value ?? "").trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(normalized)
    ? normalized
    : null;
}

export class ReplayRuntime {
  private provider = new ReplayMarketDataProvider();
  private executionProvider =
    getReplayExecutionProvider();

  private sessionManager =
    getSharedReplaySessionManager();

  private listeners = new Set<ReplayListener>();
  private snapshot: ReplaySnapshot = emptySnapshot();

  private disconnectProvider:
    | (() => void)
    | null = null;

  private replayStartIndex = 0;
  private currentSession: ReplaySession | null = null;

  subscribe(listener: ReplayListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);

    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): ReplaySnapshot {
    return this.snapshot;
  }

  getSession(): ReplaySession | null {
    return this.currentSession;
  }

  async load(
    config: ReplaySessionConfig,
  ): Promise<ReplaySnapshot> {
    this.disconnectProvider?.();
    this.disconnectProvider = null;

    this.currentSession = null;
    this.executionProvider.resetAccount();

    this.publish({
      ...emptySnapshot(),
      state: "loading",
      symbol: config.symbol.trim().toUpperCase(),
      timeframe: config.timeframe
        .trim()
        .toLowerCase(),
      speed: config.speed ?? DEFAULT_SPEED,
    });

    try {
      const bars =
        await this.provider.loadHistory(config);

      const tradingDate =
        normalizeTradingDate(config.date);

      if (tradingDate) {
        this.currentSession =
          this.sessionManager.createSession(
            bars,
            {
              tradingDate,
              startMode:
                config.startMode ??
                "market-open",
              customStartTime:
                config.customStartTime ??
                null,
            },
          );
      }

      const requestedStartIndex =
        config.startIndex != null
          ? Math.floor(config.startIndex)
          : this.currentSession?.replayStartIndex ??
            Math.min(
              60,
              Math.max(0, bars.length - 1),
            );

      const startIndex = Math.max(
        0,
        Math.min(
          bars.length > 0
            ? bars.length - 1
            : 0,
          requestedStartIndex,
        ),
      );

      this.replayStartIndex = startIndex;

      this.provider.setSpeed(
        config.speed ?? DEFAULT_SPEED,
      );

      this.disconnectProvider =
        this.provider.connect(
          config,
          {
            onStatus: () => {
              // Replay lifecycle is tracked by ReplayRuntime state.
            },

            onBar: (bar) => {
              this.handleBar(bar);
            },

            onError: (error) => {
              this.publish({
                ...this.snapshot,
                state: "error",
                error: error.message,
              });
            },
          },
        );

      this.provider.setNextIndex(
        Math.min(
          this.currentSession?.nextPlaybackIndex ??
            startIndex + 1,
          bars.length,
        ),
      );

      const currentBar =
        bars[startIndex] ?? null;

      this.publish({
        ...this.snapshot,
        state: config.autoplay
          ? "playing"
          : "ready",

        bars,

        visibleBars:
          bars.length > 0
            ? bars.slice(0, startIndex + 1)
            : [],

        currentIndex: startIndex,
        currentBar,

        currentTime:
          currentBar != null
            ? Number(currentBar.time)
            : null,

        progress:
          bars.length > 1
            ? startIndex /
              (bars.length - 1)
            : bars.length === 1
              ? 1
              : 0,

        session: this.currentSession,
      });

      this.executionProvider.setReplayContext(
        this.snapshot.symbol,
        currentBar,
      );

      if (config.autoplay) {
        this.provider.resume();
      }

      return this.snapshot;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Unable to load replay data.";

      this.publish({
        ...this.snapshot,
        state: "error",
        error: message,
      });

      return this.snapshot;
    }
  }

  play(): void {
    if (
      this.snapshot.state === "error" ||
      this.snapshot.state === "loading" ||
      this.snapshot.bars.length === 0 ||
      this.snapshot.currentIndex >=
        this.snapshot.bars.length - 1
    ) {
      return;
    }

    this.publish({
      ...this.snapshot,
      state: "playing",
    });

    this.provider.resume();
  }

  pause(): void {
    this.provider.pause();

    if (
      this.snapshot.state === "playing" ||
      this.snapshot.state === "ready"
    ) {
      this.publish({
        ...this.snapshot,
        state: "paused",
      });
    }
  }

  reset(): void {
    this.pause();
    this.executionProvider.resetAccount();

    if (
      this.snapshot.bars.length === 0
    ) {
      return;
    }

    const safeStartIndex = Math.max(
      0,
      Math.min(
        this.snapshot.bars.length - 1,
        this.replayStartIndex,
      ),
    );

    this.provider.setNextIndex(
      Math.min(
        this.currentSession
          ?.nextPlaybackIndex ??
          safeStartIndex + 1,
        this.snapshot.bars.length,
      ),
    );

    const bar =
      this.snapshot.bars[
        safeStartIndex
      ] ?? null;

    this.executionProvider.setReplayContext(
      this.snapshot.symbol,
      bar,
    );

    this.publish({
      ...this.snapshot,
      state: "ready",

      currentIndex: safeStartIndex,
      currentBar: bar,

      currentTime: bar
        ? Number(bar.time)
        : null,

      visibleBars:
        this.snapshot.bars.slice(
          0,
          safeStartIndex + 1,
        ),

      progress:
        this.snapshot.bars.length > 1
          ? safeStartIndex /
            (
              this.snapshot.bars.length -
              1
            )
          : this.snapshot.bars.length === 1
            ? 1
            : 0,

      session: this.currentSession,
    });
  }

  stepForward(): void {
    this.pause();

    const nextIndex = Math.min(
      this.snapshot.bars.length - 1,
      this.snapshot.currentIndex + 1,
    );

    this.seek(nextIndex);
  }

  stepBackward(): void {
    this.pause();

    const nextIndex = Math.max(
      0,
      this.snapshot.currentIndex - 1,
    );

    this.seek(nextIndex);
  }

  seek(index: number): void {
    if (
      this.snapshot.bars.length === 0
    ) {
      return;
    }

    const safeIndex = Math.max(
      0,
      Math.min(
        this.snapshot.bars.length - 1,
        Math.floor(index),
      ),
    );

    const movingBackward =
      safeIndex <
      this.snapshot.currentIndex;

    if (movingBackward) {
      this.executionProvider.resetAccount();
    }

    this.provider.setNextIndex(
      Math.min(
        safeIndex + 1,
        this.snapshot.bars.length,
      ),
    );

    const bar =
      this.snapshot.bars[
        safeIndex
      ] ?? null;

    if (bar) {
      this.executionProvider.processReplayBar(
        this.snapshot.symbol,
        bar,
      );
    } else {
      this.executionProvider.setReplayContext(
        this.snapshot.symbol,
        null,
      );
    }

    this.publish({
      ...this.snapshot,

      currentIndex: safeIndex,
      currentBar: bar,

      currentTime: bar
        ? Number(bar.time)
        : null,

      visibleBars:
        this.snapshot.bars.slice(
          0,
          safeIndex + 1,
        ),

      progress:
        this.snapshot.bars.length > 1
          ? safeIndex /
            (
              this.snapshot.bars.length -
              1
            )
          : 1,

      state:
        safeIndex >=
        this.snapshot.bars.length - 1
          ? "completed"
          : this.snapshot.state ===
              "playing"
            ? "playing"
            : "paused",

      session: this.currentSession,
    });
  }

  setSpeed(speed: ReplaySpeed): void {
    this.provider.setSpeed(speed);

    this.publish({
      ...this.snapshot,
      speed,
    });
  }

  destroy(): void {
    this.disconnectProvider?.();
    this.disconnectProvider = null;

    this.provider.destroy();
    this.executionProvider.resetAccount();

    this.listeners.clear();
    this.snapshot = emptySnapshot();

    this.replayStartIndex = 0;
    this.currentSession = null;
  }

  private handleBar(bar: CleanBar): void {
    const index =
      this.snapshot.bars.findIndex(
        (candidate) =>
          Number(candidate.time) ===
          Number(bar.time),
      );

    if (index < 0) {
      return;
    }

    this.executionProvider.processReplayBar(
      this.snapshot.symbol,
      bar,
    );

    const completed =
      index >=
      this.snapshot.bars.length - 1;

    this.publish({
      ...this.snapshot,

      state: completed
        ? "completed"
        : "playing",

      currentIndex: index,
      currentBar: bar,
      currentTime: Number(bar.time),

      visibleBars:
        this.snapshot.bars.slice(
          0,
          index + 1,
        ),

      progress:
        this.snapshot.bars.length > 1
          ? index /
            (
              this.snapshot.bars.length -
              1
            )
          : 1,

      session: this.currentSession,
    });
  }

  private publish(
    snapshot: ReplaySnapshot,
  ): void {
    this.snapshot = snapshot;

    for (
      const listener of
      this.listeners
    ) {
      listener(snapshot);
    }
  }
}

let sharedReplayRuntime:
  | ReplayRuntime
  | null = null;

export function getSharedReplayRuntime():
  ReplayRuntime {
  if (!sharedReplayRuntime) {
    sharedReplayRuntime =
      new ReplayRuntime();
  }

  return sharedReplayRuntime;
}

export function resetSharedReplayRuntime():
  void {
  sharedReplayRuntime?.destroy();
  sharedReplayRuntime = null;
}
