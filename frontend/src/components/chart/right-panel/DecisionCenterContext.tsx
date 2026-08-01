// src/components/chart/right-panel/DecisionCenterContext.tsx

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import type { ChartState } from "../ChartState";
import type { MarketIntelligenceReport } from "../../../trading/intelligence/core/IntelligenceTypes";
import { evaluateTradingIntelligence } from "../../../trading/intelligence/core/TradingIntelligenceRuntime";
import { buildMarketIntelligenceRequestFromChartState } from "../../../trading/intelligence/integration/ChartStateIntelligenceAdapter";
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string"
    ? error
    : "Unable to evaluate trading intelligence.";
}

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
  const [intelligence, setIntelligence] =
    useState<DecisionCenterIntelligenceState>(EMPTY_INTELLIGENCE);

  const latestReportRef = useRef<MarketIntelligenceReport | null>(null);
  const evaluationVersionRef = useRef(0);

  useEffect(() => {
    const version = ++evaluationVersionRef.current;

    if (!chartState || (!chartState.lastBar && chartState.bars.length === 0)) {
      latestReportRef.current = null;
      setIntelligence(EMPTY_INTELLIGENCE);
      return;
    }

    let cancelled = false;

    setIntelligence((current) => ({
      ...current,
      status: "evaluating",
      error: null,
      isEvaluating: true,
    }));

    const evaluate = async (): Promise<void> => {
      try {
        const request = buildMarketIntelligenceRequestFromChartState(
          chartState,
          {
            source: "decision-center",
            consumer: "decision-center",
            previousReport: latestReportRef.current,
            includeCoach: true,
            includeNarrative: true,
            metadata: {
              surface: "chart-right-panel",
            },
          },
        );

        const result = await evaluateTradingIntelligence(request);

        if (cancelled || version !== evaluationVersionRef.current) {
          return;
        }

        const report = result.report;
        const previousReport = latestReportRef.current;
        const memoryResult = readMemoryResult(report);
        const memory = readMemorySnapshot(report, memoryResult);
        const marketStory = readMarketStory(report, memoryResult);

        latestReportRef.current = report;

        setIntelligence({
          report,
          previousReport,
          memory,
          memoryResult,
          marketStory,
          status: "ready",
          error: null,
          evaluatedAt: Date.now(),
          isEvaluating: false,
        });
      } catch (error) {
        if (cancelled || version !== evaluationVersionRef.current) {
          return;
        }

        setIntelligence((current) => ({
          ...current,
          status: "error",
          error: errorMessage(error),
          isEvaluating: false,
        }));
      }
    };

    void evaluate();

    return () => {
      cancelled = true;
    };
  }, [chartState]);

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
