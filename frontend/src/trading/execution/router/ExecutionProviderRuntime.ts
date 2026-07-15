// src/trading/execution/router/ExecutionProviderRuntime.ts

import { AlpacaExecutionProvider } from "../providers/AlpacaExecutionProvider";
import { ReplayExecutionProvider } from "../providers/ReplayExecutionProvider";
import {
  getSharedExecutionRouter,
  type ExecutionRouter,
} from "./ExecutionRouter";
import type { ExecutionMode } from "./ExecutionModeRuntime";

let providersConfigured = false;

export function configureExecutionProviders(
  router: ExecutionRouter = getSharedExecutionRouter(),
): ExecutionRouter {
  if (providersConfigured) {
    return router;
  }

  router.registerProvider(
    "paper",
    () => new AlpacaExecutionProvider("paper"),
  );

  router.registerProvider(
    "live",
    () => new AlpacaExecutionProvider("live"),
  );

  router.registerProvider(
    "practice",
    () => new ReplayExecutionProvider(),
  );

  providersConfigured = true;

  return router;
}

export function getConfiguredExecutionRouter(): ExecutionRouter {
  return configureExecutionProviders(
    getSharedExecutionRouter(),
  );
}

export function getExecutionProviderForMode(
  mode: ExecutionMode,
) {
  return getConfiguredExecutionRouter().getProvider(mode);
}

export function getReplayExecutionProvider(): ReplayExecutionProvider {
  const provider = getConfiguredExecutionRouter().getProvider("practice");

  if (!(provider instanceof ReplayExecutionProvider)) {
    throw new Error(
      'The "practice" execution provider is not a ReplayExecutionProvider.',
    );
  }

  return provider;
}

export async function initializeExecutionProviders(): Promise<void> {
  const router = getConfiguredExecutionRouter();
  await router.initializeActiveProvider();
}

export async function switchExecutionMode(
  mode: ExecutionMode,
) {
  const router = getConfiguredExecutionRouter();
  return router.switchMode(mode);
}

export function resetExecutionProviderConfiguration(): void {
  providersConfigured = false;
}