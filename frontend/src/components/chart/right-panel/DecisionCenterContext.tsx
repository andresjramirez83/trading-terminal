// src/components/chart/right-panel/DecisionCenterContext.tsx

import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import type { ChartState } from "../ChartState";
import type { MarketIntelligenceReport } from "../../../trading/intelligence/core/IntelligenceTypes";
import { getSharedMarketIntelligenceStore } from "../../../trading/intelligence/integration/MarketIntelligenceStore";
import type { MarketMemorySnapshot } from "../../../trading/memory/MarketMemoryTypes";
import type { MarketMemoryEngineResult } from "../../../trading/memory/MarketMemoryEngine";
import type { MarketStory } from "../../../trading/memory/MarketStoryBuilder";
import type { DecisionCenterState } from "./DecisionCenterTypes";
import { buildDecisionCenterState } from "./DecisionCenterBuilder";

export type DecisionCenterIntelligenceStatus =
  | "idle"
  | "evaluating"
  | "ready"
  | "error";

export interface DecisionCenterIntelligenceState {
  report: MarketIntelligenceReport | null;
  previousReport: MarketIntelligenceReport | null;
  memory: MarketMemorySnapshot | null;
  memoryResult: MarketMemoryEngineResult | null;
  marketStory: MarketStory | null;
  status: DecisionCenterIntelligenceStatus;
  error: string | null;
  evaluatedAt: number | null;
  isEvaluating: boolean;
}

export type DecisionCenterContextValue = DecisionCenterState &
  DecisionCenterIntelligenceState & {
    state: DecisionCenterState;
    intelligence: DecisionCenterIntelligenceState;
  };

const DecisionCenterContext =
  createContext<DecisionCenterContextValue | null>(null);

type DecisionCenterProviderProps = {
  children: ReactNode;
  chartState?: ChartState | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function isMemoryEngineResult(value: unknown): value is MarketMemoryEngineResult {
  if (!isObject(value)) return false;

  return (
    isObject(value.memory) &&
    isObject(value.story) &&
    isObject(value.session) &&
    isObject(value.regime)
  );
}

function isMemorySnapshot(value: unknown): value is MarketMemorySnapshot {
  if (!isObject(value)) return false;

  return (
    Array.isArray(value.events) &&
    Array.isArray(value.sequences)
  );
}

function isMarketStory(value: unknown): value is MarketStory {
  if (!isObject(value)) return false;

  return (
    typeof value.headline === "string" &&
    typeof value.summary === "string"
  );
}

function readMemoryResult(
  report: MarketIntelligenceReport,
): MarketMemoryEngineResult | null {
  const metadata = report.metadata;
  if (!metadata) return null;

  const candidates: unknown[] = [
    metadata.marketMemoryResult,
    metadata.marketMemoryEngineResult,
  ];

  for (const candidate of candidates) {
    if (isMemoryEngineResult(candidate)) return candidate;
  }

  return null;
}

function readMemorySnapshot(
  report: MarketIntelligenceReport,
  memoryResult: MarketMemoryEngineResult | null,
): MarketMemorySnapshot | null {
  if (memoryResult?.memory) return memoryResult.memory;

  const metadata = report.metadata;
  if (!metadata) return null;

  const candidates: unknown[] = [
    metadata.marketMemory,
    metadata.marketMemorySnapshot,
    metadata.memorySnapshot,
  ];

  for (const candidate of candidates) {
    if (isMemorySnapshot(candidate)) return candidate;
  }

  return null;
}

function readMarketStory(
  report: MarketIntelligenceReport,
  memoryResult: MarketMemoryEngineResult | null,
): MarketStory | null {
  if (memoryResult?.story) return memoryResult.story;

  const metadata = report.metadata;
  if (!metadata) return null;

  const candidates: unknown[] = [
    metadata.marketStory,
    metadata.marketMemoryStory,
  ];

  for (const candidate of candidates) {
    if (isMarketStory(candidate)) return candidate;
  }

  return null;
}

const EMPTY_INTELLIGENCE: DecisionCenterIntelligenceState = {
  report: null,
  previousReport: null,
  memory: null,
  memoryResult: null,
  marketStory: null,
  status: "idle",
  error: null,
  evaluatedAt: null,
  isEvaluating: false,
};

export function DecisionCenterProvider({
  children,
  chartState,
}: DecisionCenterProviderProps) {
  const store = getSharedMarketIntelligenceStore();
  const snapshot = useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getSnapshot(),
    () => store.getSnapshot(),
  );

  const intelligence = useMemo<DecisionCenterIntelligenceState>(() => {
    const report = snapshot.report;
    if (!report) {
      return {
        ...EMPTY_INTELLIGENCE,
        status: snapshot.status,
        error: snapshot.error,
        evaluatedAt: snapshot.evaluatedAt,
        isEvaluating: snapshot.status === "evaluating",
      };
    }

    const memoryResult = readMemoryResult(report);

    return {
      report,
      previousReport: snapshot.previousReport,
      memory: readMemorySnapshot(report, memoryResult),
      memoryResult,
      marketStory: readMarketStory(report, memoryResult),
      status: snapshot.status,
      error: snapshot.error,
      evaluatedAt: snapshot.evaluatedAt,
      isEvaluating: snapshot.status === "evaluating",
    };
  }, [snapshot]);

  /**
   * One shared Decision Center view model.
   *
   * The completed MarketIntelligenceReport is authoritative whenever one is
   * available. During the first evaluation only, the builder falls back to the
   * legacy chart snapshot so the panel remains populated instead of flashing
   * empty.
   */
  const state = useMemo(
    () => buildDecisionCenterState(chartState, intelligence.report),
    [chartState, intelligence.report],
  );

  const value = useMemo<DecisionCenterContextValue>(
    () => ({
      ...state,
      ...intelligence,
      state,
      intelligence,
    }),
    [state, intelligence],
  );

  return (
    <DecisionCenterContext.Provider value={value}>
      {children}
    </DecisionCenterContext.Provider>
  );
}

export function useDecisionCenter(): DecisionCenterContextValue {
  const context = useContext(DecisionCenterContext);

  if (!context) {
    throw new Error(
      "useDecisionCenter must be used inside DecisionCenterProvider",
    );
  }

  return context;
}
