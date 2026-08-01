// src/trading/hooks/useDailyPracticeUniverseStore.ts

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  dailyPracticeUniverseEngine,
  type DailyPracticeUniverseEvent,
} from "../practice/DailyPracticeUniverseEngine";
import {
  normalizePracticeTradingDate,
  readSelectedPracticeTradingDate,
  saveSelectedPracticeTradingDate,
  subscribeToSelectedPracticeTradingDate,
} from "../practice/PracticeReplayLauncher";
import type {
  DailyPracticeSymbol,
  DailyPracticeUniverse,
  RecordManualWatchlistInput,
  RecordScannerHitInput,
  RemoveManualWatchlistInput,
} from "../practice/DailyPracticeUniverseTypes";

const MARKET_TIME_ZONE = "America/New_York";

function getTradingDate(timestamp = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: MARKET_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestamp));
}

function getInitialTradingDate(
  initialTradingDate: string | undefined,
  todayTradingDate: string,
): string {
  const requestedDate = normalizePracticeTradingDate(
    initialTradingDate ?? "",
  );

  if (requestedDate) {
    return requestedDate;
  }

  const savedDate = readSelectedPracticeTradingDate();

  return savedDate || todayTradingDate;
}

export type DailyPracticeUniverseStore = {
  selectedTradingDate: string;
  todayTradingDate: string;

  universe: DailyPracticeUniverse | null;
  todayUniverse: DailyPracticeUniverse | null;
  universes: DailyPracticeUniverse[];
  availableTradingDates: string[];
  symbols: DailyPracticeSymbol[];

  totalUniqueSymbolCount: number;
  scannerHitCount: number;
  uniqueScannerSymbolCount: number;
  manualWatchlistSymbolCount: number;

  setSelectedTradingDate: (tradingDate: string) => void;
  selectToday: () => void;

  recordScannerHit: (
    input: RecordScannerHitInput,
  ) => DailyPracticeSymbol | null;

  recordManualWatchlistSymbol: (
    input: RecordManualWatchlistInput,
  ) => DailyPracticeSymbol | null;

  removeManualWatchlistSymbol: (
    input: RemoveManualWatchlistInput,
  ) => DailyPracticeSymbol | null;

  markTraded: (
    tradingDate: string,
    symbol: string,
    wasTraded?: boolean,
  ) => DailyPracticeSymbol | null;

  markPracticed: (
    tradingDate: string,
    symbol: string,
  ) => DailyPracticeSymbol | null;

  clearTradingDate: (tradingDate: string) => void;
  refresh: () => void;
};

export function useDailyPracticeUniverseStore(
  initialTradingDate?: string,
): DailyPracticeUniverseStore {
  const todayTradingDate = getTradingDate();

  const [selectedTradingDate, setSelectedTradingDateState] = useState(
    () =>
      getInitialTradingDate(
        initialTradingDate,
        todayTradingDate,
      ),
  );

  const [revision, setRevision] = useState(0);

  useEffect(() => {
    return dailyPracticeUniverseEngine.subscribe(
      (_event: DailyPracticeUniverseEvent) => {
        setRevision((current) => current + 1);
      },
    );
  }, []);

  useEffect(() => {
    return subscribeToSelectedPracticeTradingDate(
      (tradingDate) => {
        setSelectedTradingDateState(tradingDate);
      },
    );
  }, []);

  useEffect(() => {
    const normalizedInitialDate =
      normalizePracticeTradingDate(
        initialTradingDate ?? "",
      );

    if (!normalizedInitialDate) {
      return;
    }

    setSelectedTradingDateState(
      normalizedInitialDate,
    );
    saveSelectedPracticeTradingDate(
      normalizedInitialDate,
    );
  }, [initialTradingDate]);

  const refresh = useCallback(() => {
    setRevision((current) => current + 1);
  }, []);

  const setSelectedTradingDate = useCallback(
    (tradingDate: string) => {
      const normalized =
        normalizePracticeTradingDate(tradingDate);

      if (!normalized) return;

      setSelectedTradingDateState(normalized);
      saveSelectedPracticeTradingDate(normalized);
    },
    [],
  );

  const selectToday = useCallback(() => {
    const tradingDate = getTradingDate();

    setSelectedTradingDateState(tradingDate);
    saveSelectedPracticeTradingDate(tradingDate);
  }, []);

  const recordScannerHit = useCallback(
    (input: RecordScannerHitInput) =>
      dailyPracticeUniverseEngine.recordScannerHit(input),
    [],
  );

  const recordManualWatchlistSymbol = useCallback(
    (input: RecordManualWatchlistInput) =>
      dailyPracticeUniverseEngine.recordManualWatchlistSymbol(input),
    [],
  );

  const removeManualWatchlistSymbol = useCallback(
    (input: RemoveManualWatchlistInput) =>
      dailyPracticeUniverseEngine.removeManualWatchlistSymbol(input),
    [],
  );

  const markTraded = useCallback(
    (
      tradingDate: string,
      symbol: string,
      wasTraded = true,
    ) =>
      dailyPracticeUniverseEngine.markTraded(
        tradingDate,
        symbol,
        wasTraded,
      ),
    [],
  );

  const markPracticed = useCallback(
    (tradingDate: string, symbol: string) =>
      dailyPracticeUniverseEngine.markPracticed(
        tradingDate,
        symbol,
      ),
    [],
  );

  const clearTradingDate = useCallback(
    (tradingDate: string) => {
      dailyPracticeUniverseEngine.clearTradingDate(
        tradingDate,
      );
    },
    [],
  );

  return useMemo(() => {
    const universes =
      dailyPracticeUniverseEngine.getUniverses();

    const universe =
      dailyPracticeUniverseEngine.getUniverse(
        selectedTradingDate,
      );

    const todayUniverse =
      dailyPracticeUniverseEngine.getUniverse(
        todayTradingDate,
      );

    return {
      selectedTradingDate,
      todayTradingDate,

      universe,
      todayUniverse,
      universes,
      availableTradingDates: universes.map(
        (item) => item.tradingDate,
      ),
      symbols: universe?.symbols ?? [],

      totalUniqueSymbolCount:
        universe?.totalUniqueSymbolCount ?? 0,
      scannerHitCount:
        universe?.scannerHitCount ?? 0,
      uniqueScannerSymbolCount:
        universe?.uniqueScannerSymbolCount ?? 0,
      manualWatchlistSymbolCount:
        universe?.manualWatchlistSymbolCount ?? 0,

      setSelectedTradingDate,
      selectToday,

      recordScannerHit,
      recordManualWatchlistSymbol,
      removeManualWatchlistSymbol,
      markTraded,
      markPracticed,
      clearTradingDate,
      refresh,
    };
  }, [
    clearTradingDate,
    markPracticed,
    markTraded,
    recordManualWatchlistSymbol,
    recordScannerHit,
    removeManualWatchlistSymbol,
    revision,
    selectedTradingDate,
    selectToday,
    setSelectedTradingDate,
    todayTradingDate,
    refresh,
  ]);
}

export default useDailyPracticeUniverseStore;
