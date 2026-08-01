// src/trading/intelligence/core/TradingIntelligenceRuntime.ts

/**
 * Application-wide lifecycle owner for the Trading OS intelligence pipeline.
 *
 * The runtime guarantees that the default pipeline is created only once, even
 * when several React providers or services request it during startup. It also
 * provides a single access point for Live Trading, Replay, Practice Center,
 * Scanner, Journal, and future intelligence consumers.
 */

import {
  createDefaultIntelligencePipeline,
  type DefaultIntelligenceBootstrapOptions,
  type DefaultIntelligencePipeline,
} from "./DefaultIntelligenceBootstrap";
import type {
  MarketIntelligenceBuildResult,
  MarketIntelligenceRequest,
} from "./IntelligenceTypes";
import type {
  MasterIntelligenceEngine,
  MasterIntelligenceRunOptions,
} from "./MasterIntelligenceEngine";

export type TradingIntelligenceRuntimeStatus =
  | "idle"
  | "initializing"
  | "ready"
  | "failed"
  | "disposing";

export interface TradingIntelligenceRuntimeSnapshot {
  status: TradingIntelligenceRuntimeStatus;
  initialized: boolean;
  error?: string;
  registrySize: number;
}

export type TradingIntelligenceRuntimeListener = (
  snapshot: TradingIntelligenceRuntimeSnapshot,
) => void;

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string"
    ? error
    : "Unknown intelligence runtime error";
}

export class TradingIntelligenceRuntime {
  private pipeline?: DefaultIntelligencePipeline;
  private initializationPromise?: Promise<DefaultIntelligencePipeline>;
  private disposalPromise?: Promise<void>;
  private status: TradingIntelligenceRuntimeStatus = "idle";
  private error?: string;
  private readonly listeners =
    new Set<TradingIntelligenceRuntimeListener>();

  public get isReady(): boolean {
    return this.status === "ready" && Boolean(this.pipeline);
  }

  public get currentStatus(): TradingIntelligenceRuntimeStatus {
    return this.status;
  }

  public get master(): MasterIntelligenceEngine {
    return this.requirePipeline().master;
  }

  public getPipeline(): DefaultIntelligencePipeline | undefined {
    return this.pipeline;
  }

  public requirePipeline(): DefaultIntelligencePipeline {
    if (!this.pipeline || this.status !== "ready") {
      throw new Error(
        "Trading intelligence has not finished initializing. Use initializeTradingIntelligence() or evaluateTradingIntelligence().",
      );
    }

    return this.pipeline;
  }

  public async initialize(
    options: DefaultIntelligenceBootstrapOptions = {},
  ): Promise<DefaultIntelligencePipeline> {
    if (this.pipeline && this.status === "ready") {
      return this.pipeline;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    if (this.disposalPromise) {
      await this.disposalPromise;
    }

    this.setState("initializing");

    this.initializationPromise = (async () => {
      try {
        const pipeline =
          await createDefaultIntelligencePipeline(options);

        await pipeline.master.initialize();

        this.pipeline = pipeline;
        this.error = undefined;
        this.setState("ready");

        return pipeline;
      } catch (error) {
        this.pipeline = undefined;
        this.error = toErrorMessage(error);
        this.setState("failed");
        throw error;
      } finally {
        this.initializationPromise = undefined;
      }
    })();

    return this.initializationPromise;
  }

  /**
   * Safe application entry point.
   *
   * Consumers may call this during startup, chart mounting, Practice Center
   * analysis, or replay without coordinating initialization themselves.
   */
  public async evaluate(
    request: MarketIntelligenceRequest,
    runOptions: MasterIntelligenceRunOptions = {},
    bootstrapOptions: DefaultIntelligenceBootstrapOptions = {},
  ): Promise<MarketIntelligenceBuildResult> {
    const pipeline = this.isReady
      ? this.requirePipeline()
      : await this.initialize(bootstrapOptions);

    return pipeline.master.evaluateAsync(request, runOptions);
  }

  public async dispose(): Promise<void> {
    if (this.disposalPromise) {
      return this.disposalPromise;
    }

    const pipeline = this.pipeline;

    if (!pipeline && !this.initializationPromise) {
      this.error = undefined;
      this.setState("idle");
      return;
    }

    this.disposalPromise = (async () => {
      this.setState("disposing");

      try {
        if (this.initializationPromise) {
          try {
            await this.initializationPromise;
          } catch {
            // Initialization failure is already represented by runtime state.
          }
        }

        const activePipeline = this.pipeline ?? pipeline;

        if (activePipeline) {
          await activePipeline.master.dispose();
        }
      } finally {
        this.pipeline = undefined;
        this.initializationPromise = undefined;
        this.disposalPromise = undefined;
        this.error = undefined;
        this.setState("idle");
      }
    })();

    return this.disposalPromise;
  }

  public subscribe(
    listener: TradingIntelligenceRuntimeListener,
  ): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());

    return () => {
      this.listeners.delete(listener);
    };
  }

  public snapshot(): TradingIntelligenceRuntimeSnapshot {
    return Object.freeze({
      status: this.status,
      initialized: this.isReady,
      error: this.error,
      registrySize: this.pipeline?.registry.size ?? 0,
    });
  }

  private setState(
    status: TradingIntelligenceRuntimeStatus,
  ): void {
    this.status = status;
    const snapshot = this.snapshot();

    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A UI listener must never break the intelligence runtime lifecycle.
      }
    }
  }
}

export const tradingIntelligenceRuntime =
  new TradingIntelligenceRuntime();

export function initializeTradingIntelligence(
  options: DefaultIntelligenceBootstrapOptions = {},
): Promise<DefaultIntelligencePipeline> {
  return tradingIntelligenceRuntime.initialize(options);
}

export function evaluateTradingIntelligence(
  request: MarketIntelligenceRequest,
  runOptions: MasterIntelligenceRunOptions = {},
  bootstrapOptions: DefaultIntelligenceBootstrapOptions = {},
): Promise<MarketIntelligenceBuildResult> {
  return tradingIntelligenceRuntime.evaluate(
    request,
    runOptions,
    bootstrapOptions,
  );
}

export function getTradingIntelligencePipeline(): DefaultIntelligencePipeline {
  return tradingIntelligenceRuntime.requirePipeline();
}

export function getMasterIntelligenceEngine(): MasterIntelligenceEngine {
  return tradingIntelligenceRuntime.master;
}

export function disposeTradingIntelligence(): Promise<void> {
  return tradingIntelligenceRuntime.dispose();
}
