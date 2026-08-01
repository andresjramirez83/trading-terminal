import {
  useCallback,
  useMemo,
  useSyncExternalStore,
} from "react";

import {
  practiceAnalysisEngine,
  type PracticeAnalysisEngine,
} from "./PracticeAnalysisEngine";

import type {
  PracticeAnalysisRequest,
  PracticeAnalysisStorage,
  PracticeDayAnalysis,
  PracticeRecommendationCategory,
  PracticeReplayRecommendation,
  PracticeSetupType,
  PracticeSymbolAnalysis,
} from "./PracticeAnalysisTypes";

const EMPTY_STORAGE: PracticeAnalysisStorage = {
  version: 1,
  updatedAt: 0,
  days: {},
};

export interface UsePracticeAnalysisStoreOptions {
  tradingDate?: string;
  symbol?: string;
  timeframe?: string;
  engine?: PracticeAnalysisEngine;
}

export interface PracticeAnalysisStore {
  storage: PracticeAnalysisStorage;

  tradingDate?: string;
  day?: PracticeDayAnalysis;
  symbolAnalysis?: PracticeSymbolAnalysis;

  symbols: PracticeSymbolAnalysis[];
  recommendations: PracticeReplayRecommendation[];

  analyzedSymbolCount: number;
  recommendationCount: number;

  topOverall?: PracticeSymbolAnalysis;
  topTrend?: PracticeSymbolAnalysis;
  topOpeningRangeBreak?: PracticeSymbolAnalysis;
  topIfvg?: PracticeSymbolAnalysis;
  topLiquiditySweep?: PracticeSymbolAnalysis;
  topReversal?: PracticeSymbolAnalysis;
  topMomentum?: PracticeSymbolAnalysis;

  analyzeSymbol: (
    request: PracticeAnalysisRequest,
  ) => PracticeSymbolAnalysis;

  analyzeMany: (
    requests: PracticeAnalysisRequest[],
  ) => PracticeSymbolAnalysis[];

  getSymbolAnalysis: (params: {
    tradingDate: string;
    symbol: string;
    timeframe: string;
  }) => PracticeSymbolAnalysis | undefined;

  getRecommendationsByCategory: (
    category: PracticeRecommendationCategory,
  ) => PracticeReplayRecommendation[];

  getSymbolsBySetup: (
    setupType: PracticeSetupType,
  ) => PracticeSymbolAnalysis[];

  removeDay: (tradingDate: string) => void;
  clear: () => void;
}

function normalizeSymbol(symbol?: string): string {
  return String(symbol ?? "").trim().toUpperCase();
}

function normalizeTimeframe(timeframe?: string): string {
  return String(timeframe ?? "").trim().toLowerCase();
}

function findSymbolByName(
  symbols: PracticeSymbolAnalysis[],
  symbol?: string,
): PracticeSymbolAnalysis | undefined {
  const normalized = normalizeSymbol(symbol);

  if (!normalized) {
    return undefined;
  }

  return symbols.find(
    (analysis) => analysis.symbol === normalized,
  );
}

function findRecommendedSymbol(
  day: PracticeDayAnalysis | undefined,
  symbol?: string,
): PracticeSymbolAnalysis | undefined {
  if (!day || !symbol) {
    return undefined;
  }

  return findSymbolByName(day.symbols, symbol);
}

export function usePracticeAnalysisStore(
  options: UsePracticeAnalysisStoreOptions = {},
): PracticeAnalysisStore {
  const engine = options.engine ?? practiceAnalysisEngine;

  const subscribe = useCallback(
    (listener: () => void) => engine.subscribe(listener),
    [engine],
  );

  const getSnapshot = useCallback(
    () => engine.getStorageSnapshot(),
    [engine],
  );

  const getServerSnapshot = useCallback(
    () => EMPTY_STORAGE,
    [],
  );

  const storage = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const tradingDate = options.tradingDate;
  const day = tradingDate
    ? storage.days[tradingDate]
    : undefined;

  const symbols = useMemo(
    () =>
      [...(day?.symbols ?? [])].sort(
        (left, right) =>
          right.overallScore - left.overallScore,
      ),
    [day],
  );

  const recommendations = useMemo(
    () =>
      [...(day?.recommendations ?? [])].sort(
        (left, right) => right.score - left.score,
      ),
    [day],
  );

  const requestedSymbol = normalizeSymbol(options.symbol);
  const requestedTimeframe = normalizeTimeframe(
    options.timeframe,
  );

  const symbolAnalysis = useMemo(() => {
    if (!day || !requestedSymbol) {
      return undefined;
    }

    if (requestedTimeframe) {
      return day.symbols.find(
        (analysis) =>
          analysis.symbol === requestedSymbol &&
          analysis.timeframe === requestedTimeframe,
      );
    }

    return day.symbols.find(
      (analysis) => analysis.symbol === requestedSymbol,
    );
  }, [day, requestedSymbol, requestedTimeframe]);

  const getSymbolAnalysis = useCallback(
    (params: {
      tradingDate: string;
      symbol: string;
      timeframe: string;
    }) => engine.getSymbolAnalysis(params),
    [engine],
  );

  const getRecommendationsByCategory = useCallback(
    (
      category: PracticeRecommendationCategory,
    ): PracticeReplayRecommendation[] => {
      return recommendations.filter(
        (recommendation) =>
          recommendation.category === category,
      );
    },
    [recommendations],
  );

  const getSymbolsBySetup = useCallback(
    (
      setupType: PracticeSetupType,
    ): PracticeSymbolAnalysis[] => {
      return symbols.filter((analysis) =>
        analysis.setups.some(
          (setup) => setup.type === setupType,
        ),
      );
    },
    [symbols],
  );

  const analyzeSymbol = useCallback(
    (
      request: PracticeAnalysisRequest,
    ): PracticeSymbolAnalysis =>
      engine.analyzeSymbol(request),
    [engine],
  );

  const analyzeMany = useCallback(
    (
      requests: PracticeAnalysisRequest[],
    ): PracticeSymbolAnalysis[] =>
      engine.analyzeMany(requests),
    [engine],
  );

  const removeDay = useCallback(
    (date: string) => engine.removeDay(date),
    [engine],
  );

  const clear = useCallback(
    () => engine.clear(),
    [engine],
  );

  return {
    storage,

    tradingDate,
    day,
    symbolAnalysis,

    symbols,
    recommendations,

    analyzedSymbolCount:
      day?.analyzedSymbolCount ?? symbols.length,
    recommendationCount: recommendations.length,

    topOverall:
      findRecommendedSymbol(
        day,
        day?.topOverallSymbol,
      ) ?? symbols[0],

    topTrend: findRecommendedSymbol(
      day,
      day?.topTrendSymbol,
    ),

    topOpeningRangeBreak: findRecommendedSymbol(
      day,
      day?.topOpeningRangeBreakSymbol,
    ),

    topIfvg: findRecommendedSymbol(
      day,
      day?.topIfvgSymbol,
    ),

    topLiquiditySweep: findRecommendedSymbol(
      day,
      day?.topLiquiditySweepSymbol,
    ),

    topReversal: findRecommendedSymbol(
      day,
      day?.topReversalSymbol,
    ),

    topMomentum: findRecommendedSymbol(
      day,
      day?.topMomentumSymbol,
    ),

    analyzeSymbol,
    analyzeMany,
    getSymbolAnalysis,
    getRecommendationsByCategory,
    getSymbolsBySetup,
    removeDay,
    clear,
  };
}