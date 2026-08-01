import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { loadHistoricalBars } from "../../../components/chart/LiveDataEngine";
import type { MarketIntelligenceReport } from "../../intelligence/core/IntelligenceTypes";
import { evaluateTradingIntelligence } from "../../intelligence/core/TradingIntelligenceRuntime";
import { buildMarketIntelligenceRequestFromPracticeBars } from "../../intelligence/integration/PracticeBarsIntelligenceAdapter";
import type { DailyPracticeSymbol } from "../DailyPracticeUniverseTypes";
import {
  practiceAnalysisEngine,
  type PracticeAnalysisEngine,
} from "./PracticeAnalysisEngine";
import type {
  PracticeAnalysisBar,
  PracticeSymbolAnalysis,
} from "./PracticeAnalysisTypes";

const DEFAULT_TIMEFRAME = "5m";
const DEFAULT_LIMIT = 4000;
const DEFAULT_CONCURRENCY = 3;

export type PracticeAnalysisRunnerStatus =
  | "idle"
  | "loading"
  | "complete"
  | "error";

export interface PracticeAnalysisRunnerProgress {
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  currentSymbols: string[];
}

export interface PracticeAnalysisRunnerError {
  symbol: string;
  message: string;
}

export interface UsePracticeAnalysisRunnerOptions {
  tradingDate: string;
  symbols: DailyPracticeSymbol[];

  timeframe?: string;
  limit?: number;
  concurrency?: number;

  enabled?: boolean;
  forceRefresh?: boolean;

  engine?: PracticeAnalysisEngine;
}

export interface PracticeAnalysisRunner {
  status: PracticeAnalysisRunnerStatus;
  progress: PracticeAnalysisRunnerProgress;
  errors: PracticeAnalysisRunnerError[];

  isRunning: boolean;
  isComplete: boolean;

  intelligenceReports: Readonly<Record<string, MarketIntelligenceReport>>;
  getIntelligenceReport: (
    symbol: string,
  ) => MarketIntelligenceReport | null;

  run: (
    forceRefresh?: boolean,
  ) => Promise<PracticeSymbolAnalysis[]>;

  cancel: () => void;
  reset: () => void;
}

function normalizeBarTimeToMilliseconds(
  value: unknown,
): number {
  const numeric = Number(value);

  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return numeric > 10_000_000_000
    ? Math.floor(numeric)
    : Math.floor(numeric * 1000);
}

function normalizeAnalysisBars(
  bars: Array<{
    time: unknown;
    open: unknown;
    high: unknown;
    low: unknown;
    close: unknown;
    volume?: unknown;
    vwap?: unknown;
  }>,
): PracticeAnalysisBar[] {
  return bars
    .map((bar) => ({
      time: normalizeBarTimeToMilliseconds(
        bar.time,
      ),
      open: Number(bar.open),
      high: Number(bar.high),
      low: Number(bar.low),
      close: Number(bar.close),
      volume: Number.isFinite(
        Number(bar.volume),
      )
        ? Number(bar.volume)
        : undefined,
      vwap: Number.isFinite(Number(bar.vwap))
        ? Number(bar.vwap)
        : undefined,
    }))
    .filter(
      (bar) =>
        bar.time > 0 &&
        Number.isFinite(bar.open) &&
        Number.isFinite(bar.high) &&
        Number.isFinite(bar.low) &&
        Number.isFinite(bar.close),
    )
    .sort((left, right) => left.time - right.time);
}

function getScannerHitTimes(
  symbol: DailyPracticeSymbol,
): number[] {
  return symbol.scannerSummaries
    .flatMap((summary) => [
      summary.firstSeenAt,
      summary.lastSeenAt,
    ])
    .filter(
      (value) =>
        Number.isFinite(value) && value > 0,
    )
    .sort((left, right) => left - right);
}

function createInitialProgress(
  total = 0,
): PracticeAnalysisRunnerProgress {
  return {
    total,
    completed: 0,
    succeeded: 0,
    failed: 0,
    currentSymbols: [],
  };
}

function createErrorMessage(
  error: unknown,
): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "Unknown analysis error");
}

function normalizeSymbolKey(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export function usePracticeAnalysisRunner(
  options: UsePracticeAnalysisRunnerOptions,
): PracticeAnalysisRunner {
  const {
    tradingDate,
    symbols,
    timeframe = DEFAULT_TIMEFRAME,
    limit = DEFAULT_LIMIT,
    concurrency = DEFAULT_CONCURRENCY,
    enabled = true,
    forceRefresh = false,
    engine = practiceAnalysisEngine,
  } = options;

  const [status, setStatus] =
    useState<PracticeAnalysisRunnerStatus>(
      "idle",
    );

  const [progress, setProgress] =
    useState<PracticeAnalysisRunnerProgress>(
      () => createInitialProgress(),
    );

  const [errors, setErrors] = useState<
    PracticeAnalysisRunnerError[]
  >([]);

  const [intelligenceReports, setIntelligenceReports] =
    useState<Record<string, MarketIntelligenceReport>>({});

  const runIdRef = useRef(0);
  const autoRunKeyRef = useRef("");
  const intelligenceReportsRef = useRef<
    Record<string, MarketIntelligenceReport>
  >({});

  useEffect(() => {
    intelligenceReportsRef.current =
      intelligenceReports;
  }, [intelligenceReports]);

  const normalizedSymbols = useMemo(() => {
    const unique = new Map<
      string,
      DailyPracticeSymbol
    >();

    for (const item of symbols) {
      const symbol = normalizeSymbolKey(
        item.symbol,
      );

      if (!symbol || unique.has(symbol)) {
        continue;
      }

      unique.set(symbol, item);
    }

    return [...unique.values()];
  }, [symbols]);

  const cancel = useCallback(() => {
    runIdRef.current += 1;

    setProgress((current) => ({
      ...current,
      currentSymbols: [],
    }));

    setStatus("idle");
  }, []);

  const reset = useCallback(() => {
    runIdRef.current += 1;
    autoRunKeyRef.current = "";
    intelligenceReportsRef.current = {};

    setStatus("idle");
    setProgress(createInitialProgress());
    setErrors([]);
    setIntelligenceReports({});
  }, []);

  const getIntelligenceReport = useCallback(
    (
      symbol: string,
    ): MarketIntelligenceReport | null => {
      return (
        intelligenceReportsRef.current[
          normalizeSymbolKey(symbol)
        ] ?? null
      );
    },
    [],
  );

  const run = useCallback(
    async (
      requestedForceRefresh = forceRefresh,
    ): Promise<PracticeSymbolAnalysis[]> => {
      const cleanTradingDate =
        tradingDate.trim();
      const cleanTimeframe = timeframe
        .trim()
        .toLowerCase();

      if (
        !cleanTradingDate ||
        normalizedSymbols.length === 0
      ) {
        setStatus("idle");
        setProgress(
          createInitialProgress(
            normalizedSymbols.length,
          ),
        );
        setErrors([]);
        setIntelligenceReports({});
        intelligenceReportsRef.current = {};

        return [];
      }

      const runId = runIdRef.current + 1;
      runIdRef.current = runId;

      const safeConcurrency = Math.max(
        1,
        Math.min(
          Math.floor(concurrency),
          normalizedSymbols.length,
        ),
      );

      const results: PracticeSymbolAnalysis[] =
        [];
      const nextErrors: PracticeAnalysisRunnerError[] =
        [];
      const nextReports: Record<
        string,
        MarketIntelligenceReport
      > = {};

      let nextIndex = 0;

      setStatus("loading");
      setErrors([]);
      setProgress(
        createInitialProgress(
          normalizedSymbols.length,
        ),
      );

      const updateCurrentSymbol = (
        symbol: string,
        active: boolean,
      ) => {
        setProgress((current) => {
          const currentSymbols = active
            ? [
                ...new Set([
                  ...current.currentSymbols,
                  symbol,
                ]),
              ]
            : current.currentSymbols.filter(
                (item) => item !== symbol,
              );

          return {
            ...current,
            currentSymbols,
          };
        });
      };

      const analyzeOne = async (
        universeSymbol: DailyPracticeSymbol,
      ) => {
        const symbol = normalizeSymbolKey(
          universeSymbol.symbol,
        );

        updateCurrentSymbol(symbol, true);

        try {
          const existing =
            engine.getSymbolAnalysis({
              tradingDate: cleanTradingDate,
              symbol,
              timeframe: cleanTimeframe,
            });

          const historicalBars =
            await loadHistoricalBars({
              symbol,
              timeframe: cleanTimeframe,
              date: cleanTradingDate,
              limit,
            });

          if (runIdRef.current !== runId) {
            return;
          }

          const bars = normalizeAnalysisBars(
            historicalBars,
          );

          if (bars.length < 5) {
            throw new Error(
              `Only ${bars.length} historical bars were returned.`,
            );
          }

          const analysis =
            existing &&
            !requestedForceRefresh
              ? existing
              : engine.analyzeSymbol({
                  symbol,
                  tradingDate:
                    cleanTradingDate,
                  timeframe:
                    cleanTimeframe,
                  bars,
                  scannerNames:
                    universeSymbol.scannerNames,
                  scannerHitTimes:
                    getScannerHitTimes(
                      universeSymbol,
                    ),
                  forceRefresh:
                    requestedForceRefresh,
                });

          const previousReport =
            intelligenceReportsRef.current[
              symbol
            ] ?? null;

          const intelligenceRequest =
            buildMarketIntelligenceRequestFromPracticeBars({
              symbol,
              tradingDate:
                cleanTradingDate,
              timeframe:
                cleanTimeframe,
              bars,
              previousReport,
              consumer:
                "practice-center",
              includeCoach: true,
              includeNarrative: true,
              correlationId: [
                "practice",
                cleanTradingDate,
                symbol,
                cleanTimeframe,
              ].join(":"),
              metadata: {
                scannerNames:
                  universeSymbol.scannerNames,
                scannerHitTimes:
                  getScannerHitTimes(
                    universeSymbol,
                  ),
                practiceAnalysisScore:
                  analysis.overallScore,
              },
            });

          const intelligenceResult =
            await evaluateTradingIntelligence(
              intelligenceRequest,
            );

          if (runIdRef.current !== runId) {
            return;
          }

          results.push(analysis);
          nextReports[symbol] =
            intelligenceResult.report;

          setIntelligenceReports(
            (current) => {
              const next = {
                ...current,
                [symbol]:
                  intelligenceResult.report,
              };

              intelligenceReportsRef.current =
                next;

              return next;
            },
          );

          setProgress((current) => ({
            ...current,
            completed:
              current.completed + 1,
            succeeded:
              current.succeeded + 1,
          }));
        } catch (error) {
          const runnerError = {
            symbol,
            message:
              createErrorMessage(error),
          };

          nextErrors.push(runnerError);

          setErrors((current) => [
            ...current,
            runnerError,
          ]);

          setProgress((current) => ({
            ...current,
            completed:
              current.completed + 1,
            failed: current.failed + 1,
          }));

          console.error(
            "[PracticeAnalysisRunner] Symbol analysis failed",
            symbol,
            error,
          );
        } finally {
          updateCurrentSymbol(
            symbol,
            false,
          );
        }
      };

      const worker = async () => {
        while (true) {
          if (runIdRef.current !== runId) {
            return;
          }

          const index = nextIndex;
          nextIndex += 1;

          if (
            index >=
            normalizedSymbols.length
          ) {
            return;
          }

          await analyzeOne(
            normalizedSymbols[index],
          );
        }
      };

      await Promise.all(
        Array.from(
          { length: safeConcurrency },
          () => worker(),
        ),
      );

      if (runIdRef.current !== runId) {
        return results;
      }

      intelligenceReportsRef.current =
        nextReports;
      setIntelligenceReports(nextReports);

      setProgress((current) => ({
        ...current,
        currentSymbols: [],
      }));

      setStatus(
        nextErrors.length ===
          normalizedSymbols.length
          ? "error"
          : "complete",
      );

      return results.sort(
        (left, right) =>
          right.overallScore -
          left.overallScore,
      );
    },
    [
      concurrency,
      engine,
      forceRefresh,
      limit,
      normalizedSymbols,
      timeframe,
      tradingDate,
    ],
  );

  useEffect(() => {
    if (
      !enabled ||
      !tradingDate.trim() ||
      normalizedSymbols.length === 0
    ) {
      return;
    }

    const autoRunKey = [
      tradingDate.trim(),
      timeframe.trim().toLowerCase(),
      normalizedSymbols
        .map((item) =>
          normalizeSymbolKey(
            item.symbol,
          ),
        )
        .sort()
        .join(","),
      forceRefresh ? "force" : "cached",
    ].join("|");

    if (
      autoRunKeyRef.current ===
      autoRunKey
    ) {
      return;
    }

    autoRunKeyRef.current =
      autoRunKey;

    void run(forceRefresh);
  }, [
    enabled,
    forceRefresh,
    normalizedSymbols,
    run,
    timeframe,
    tradingDate,
  ]);

  useEffect(() => {
    return () => {
      runIdRef.current += 1;
    };
  }, []);

  return {
    status,
    progress,
    errors,

    isRunning: status === "loading",
    isComplete: status === "complete",

    intelligenceReports,
    getIntelligenceReport,

    run,
    cancel,
    reset,
  };
}

export default usePracticeAnalysisRunner;
