// src/trading/execution/router/ExecutionRouter.ts

import type { ExecutionProvider } from "../providers/ExecutionProvider";
import {
  getSharedExecutionModeRuntime,
  type ExecutionMode,
  type ExecutionModeListener,
} from "./ExecutionModeRuntime";

type ProviderFactory = () => ExecutionProvider;

export class ExecutionRouter {
  private providers = new Map<ExecutionMode, ExecutionProvider>();
  private factories = new Map<ExecutionMode, ProviderFactory>();
  private modeRuntime = getSharedExecutionModeRuntime();
  private unsubscribeMode: (() => void) | null = null;

  constructor() {
    this.unsubscribeMode = this.modeRuntime.subscribe(
      this.handleModeChange,
    );
  }

  registerProvider(
    mode: ExecutionMode,
    factory: ProviderFactory,
  ): void {
    this.factories.set(mode, factory);
  }

  hasProvider(mode: ExecutionMode): boolean {
    return (
      this.providers.has(mode) ||
      this.factories.has(mode)
    );
  }

  getMode(): ExecutionMode {
    return this.modeRuntime.getMode();
  }

  setMode(mode: ExecutionMode): void {
    this.modeRuntime.setMode(mode);
  }

  getActiveProvider(): ExecutionProvider {
    return this.getProvider(this.getMode());
  }

  getProvider(mode: ExecutionMode): ExecutionProvider {
    const existing = this.providers.get(mode);
    if (existing) return existing;

    const factory = this.factories.get(mode);

    if (!factory) {
      throw new Error(
        `No execution provider registered for mode "${mode}".`,
      );
    }

    const provider = factory();
    this.providers.set(mode, provider);

    return provider;
  }

  async initializeActiveProvider(): Promise<ExecutionProvider> {
    const provider = this.getActiveProvider();
    await provider.initialize();
    return provider;
  }

  async switchMode(
    mode: ExecutionMode,
  ): Promise<ExecutionProvider> {
    const previousMode = this.getMode();

    if (mode === previousMode) {
      return this.initializeActiveProvider();
    }

    const previousProvider = this.providers.get(previousMode);

    if (previousProvider) {
      await previousProvider.shutdown();
    }

    this.setMode(mode);

    const nextProvider = this.getProvider(mode);
    await nextProvider.initialize();

    return nextProvider;
  }

  subscribeMode(
    listener: ExecutionModeListener,
  ): () => void {
    return this.modeRuntime.subscribe(listener);
  }

  async shutdownAll(): Promise<void> {
    const providers = Array.from(this.providers.values());

    await Promise.allSettled(
      providers.map((provider) => provider.shutdown()),
    );
  }

  async destroy(): Promise<void> {
    this.unsubscribeMode?.();
    this.unsubscribeMode = null;

    await this.shutdownAll();

    this.providers.clear();
    this.factories.clear();
  }

  private handleModeChange: ExecutionModeListener = (
    nextMode,
    previousMode,
  ) => {
    if (nextMode === previousMode) return;

    const previousProvider = this.providers.get(previousMode);

    if (previousProvider) {
      void previousProvider.shutdown();
    }

    const nextProvider = this.providers.get(nextMode);

    if (nextProvider) {
      void nextProvider.initialize();
    }
  };
}

let sharedExecutionRouter: ExecutionRouter | null = null;

export function getSharedExecutionRouter(): ExecutionRouter {
  if (!sharedExecutionRouter) {
    sharedExecutionRouter = new ExecutionRouter();
  }

  return sharedExecutionRouter;
}

export async function resetSharedExecutionRouter(): Promise<void> {
  if (!sharedExecutionRouter) return;

  await sharedExecutionRouter.destroy();
  sharedExecutionRouter = null;
}