// src/components/chart/right-panel/workspaces/trading/DailyPracticeUniverseWidget.tsx

import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type CSSProperties,
} from "react";
import { useDailyPracticeUniverseStore } from "../../../../../trading/hooks/useDailyPracticeUniverseStore";
import type {
  DailyPracticeSymbol,
  PracticeUniverseSourceType,
} from "../../../../../trading/practice/DailyPracticeUniverseTypes";
import {
  launchPracticeReplay,
  readSavedPracticeReplayRequest,
} from "../../../../../trading/practice/PracticeReplayLauncher";
import type { ReplayStartMode } from "../../../../../trading/replay/ReplaySessionManager";
import { usePracticeAnalysisRunner } from "../../../../../trading/practice/analysis/usePracticeAnalysisRunner";
import {
  practiceSessionManager,
  type PracticeSession,
  type PracticeSessionProgress,
} from "../../../../../trading/practice/PracticeSessionManager";
import PracticeIntelligenceWidget from "./PracticeIntelligenceWidget";

type UniverseFilter = "all" | PracticeUniverseSourceType;

type DailyPracticeUniverseWidgetProps = {
  onSelectSymbol?: (symbol: string) => void;
};

function formatTradingDate(value: string): string {
  if (!value) return "No date selected";

  const [year, month, day] = value.split("-").map(Number);

  if (!year || !month || !day) return value;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(year, month - 1, day));
}

function formatTime(value: number | null): string {
  if (!value || !Number.isFinite(value)) return "—";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 0,
  });
}

function formatPrice(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";

  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: value < 10 ? 2 : 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  });
}

function formatPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";

  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function sourceLabel(source: PracticeUniverseSourceType): string {
  return source === "scanner" ? "Scanner" : "Manual";
}

function getLatestScannerValue(
  symbol: DailyPracticeSymbol,
  key:
    | "latestPrice"
    | "latestPercentChange"
    | "latestVolume",
): number | null {
  const summaries = [...symbol.scannerSummaries].sort(
    (a, b) => b.lastSeenAt - a.lastSeenAt,
  );

  for (const summary of summaries) {
    const value = summary[key];

    if (value != null && Number.isFinite(value)) {
      return value;
    }
  }

  return null;
}

export default function DailyPracticeUniverseWidget({
  onSelectSymbol,
}: DailyPracticeUniverseWidgetProps) {
  const store = useDailyPracticeUniverseStore();
  const savedReplayRequest =
    readSavedPracticeReplayRequest();

  const [filter, setFilter] =
    useState<UniverseFilter>("all");
  const [search, setSearch] = useState("");

  const [replayTimeframe, setReplayTimeframe] =
    useState(
      savedReplayRequest?.timeframe ?? "5m",
    );

  const [replayStartMode, setReplayStartMode] =
    useState<ReplayStartMode>(
      savedReplayRequest?.startMode ??
        "market-open",
    );

  const [
    replayCustomStartTime,
    setReplayCustomStartTime,
  ] = useState(
    savedReplayRequest?.customStartTime ??
      "09:30",
  );

  const [session, setSession] =
    useState<PracticeSession | null>(() => {
      if (!store.selectedTradingDate) return null;
      return practiceSessionManager.getSession(
        store.selectedTradingDate,
      );
    });

  const [progress, setProgress] =
    useState<PracticeSessionProgress>(() => {
      if (!store.selectedTradingDate) {
        return {
          total: 0,
          completed: 0,
          skipped: 0,
          remaining: 0,
          currentIndex: 0,
          percentComplete: 0,
        };
      }

      return practiceSessionManager.getProgress(
        store.selectedTradingDate,
      );
    });

  useEffect(() => {
    if (!store.selectedTradingDate) {
      setSession(null);
      setProgress({
        total: 0,
        completed: 0,
        skipped: 0,
        remaining: 0,
        currentIndex: 0,
        percentComplete: 0,
      });
      return;
    }

    const nextSession =
      practiceSessionManager.createOrRefreshSession(
        store.selectedTradingDate,
        store.symbols,
        {
          timeframe: replayTimeframe,
          startMode: replayStartMode,
          customStartTime:
            replayStartMode === "custom"
              ? replayCustomStartTime
              : null,
        },
      );

    setSession(nextSession);
    setProgress(
      practiceSessionManager.getProgress(
        store.selectedTradingDate,
      ),
    );
  }, [
    replayCustomStartTime,
    replayStartMode,
    replayTimeframe,
    store.selectedTradingDate,
    store.symbols,
  ]);

  useEffect(() => {
    return practiceSessionManager.subscribe(
      (nextSession) => {
        if (
          nextSession &&
          nextSession.tradingDate !==
            store.selectedTradingDate
        ) {
          return;
        }

        setSession(nextSession);

        if (store.selectedTradingDate) {
          setProgress(
            practiceSessionManager.getProgress(
              store.selectedTradingDate,
            ),
          );
        }
      },
    );
  }, [store.selectedTradingDate]);

  const sessionSymbolByTicker = useMemo(
    () =>
      new Map(
        session?.symbols.map((symbol) => [
          symbol.symbol,
          symbol,
        ]) ?? [],
      ),
    [session],
  );

  const skippedSymbols = useMemo(
    () =>
      new Set(
        session?.symbols
          .filter((symbol) => symbol.status === "skipped")
          .map((symbol) => symbol.symbol) ?? [],
      ),
    [session],
  );

  const completedCount = progress.completed;
  const skippedCount = progress.skipped;
  const remainingCount = progress.remaining;

  const activeSymbol = useMemo(() => {
    if (!session?.activeSymbol) return null;

    return (
      store.symbols.find(
        (symbol) =>
          symbol.symbol === session.activeSymbol,
      ) ?? null
    );
  }, [session?.activeSymbol, store.symbols]);

  const activeSymbolIndex = session?.activeSymbol
    ? session.symbols.findIndex(
        (symbol) =>
          symbol.symbol === session.activeSymbol,
      )
    : -1;

  const orderedSymbolCount = session?.symbols.length ?? 0;

  const analysisRunner = usePracticeAnalysisRunner({
    tradingDate: store.selectedTradingDate,
    symbols: store.symbols,
    timeframe: replayTimeframe,
    enabled:
      Boolean(store.selectedTradingDate) &&
      store.symbols.length > 0,
  });

  const activeIntelligenceReport = activeSymbol
    ? analysisRunner.getIntelligenceReport(
        activeSymbol.symbol,
      )
    : null;

  const filteredSymbols = useMemo(() => {
    const normalizedSearch = search.trim().toUpperCase();

    return store.symbols.filter((symbol) => {
      if (
        filter !== "all" &&
        !symbol.sourceTypes.includes(filter)
      ) {
        return false;
      }

      if (
        normalizedSearch &&
        !symbol.symbol.includes(normalizedSearch) &&
        !symbol.scannerNames.some((name) =>
          name.toUpperCase().includes(normalizedSearch),
        ) &&
        !symbol.setups.some((setup) =>
          setup.toUpperCase().includes(normalizedSearch),
        )
      ) {
        return false;
      }

      return true;
    });
  }, [filter, search, store.symbols]);

  const handleTradingDateChange = (
    event: ChangeEvent<HTMLSelectElement>,
  ) => {
    store.setSelectedTradingDate(event.target.value);
  };

  const handleLaunchReplay = (
    symbol: DailyPracticeSymbol,
  ) => {
    if (store.selectedTradingDate) {
      practiceSessionManager.setActiveSymbol(
        store.selectedTradingDate,
        symbol.symbol,
      );
    }

    const request = launchPracticeReplay({
      symbol: symbol.symbol,
      tradingDate: store.selectedTradingDate,
      timeframe: replayTimeframe,
      startMode: replayStartMode,
      customStartTime:
        replayStartMode === "custom"
          ? replayCustomStartTime
          : null,
      source: "universe",
    });

    onSelectSymbol?.(request.symbol);
  };

  const refreshSessionState = (
    nextSession: PracticeSession | null,
  ) => {
    setSession(nextSession);

    if (store.selectedTradingDate) {
      setProgress(
        practiceSessionManager.getProgress(
          store.selectedTradingDate,
        ),
      );
    }
  };

  const moveToNextSymbol = () => {
    if (!store.selectedTradingDate) return;

    refreshSessionState(
      practiceSessionManager.moveNext(
        store.selectedTradingDate,
      ),
    );
  };

  const moveToPreviousSymbol = () => {
    if (!store.selectedTradingDate) return;

    refreshSessionState(
      practiceSessionManager.movePrevious(
        store.selectedTradingDate,
      ),
    );
  };

  const handleLaunchActiveSymbol = () => {
    if (!activeSymbol) return;
    handleLaunchReplay(activeSymbol);
  };

  const handleCompleteAndNext = () => {
    if (!activeSymbol || !store.selectedTradingDate) return;

    store.markPracticed(
      store.selectedTradingDate,
      activeSymbol.symbol,
    );

    refreshSessionState(
      practiceSessionManager.completeActiveSymbol(
        store.selectedTradingDate,
      ),
    );
  };

  const handleSkipAndNext = () => {
    if (!activeSymbol || !store.selectedTradingDate) return;

    refreshSessionState(
      practiceSessionManager.skipActiveSymbol(
        store.selectedTradingDate,
      ),
    );
  };

  const handleResetSession = () => {
    if (!store.selectedTradingDate) return;

    refreshSessionState(
      practiceSessionManager.resetSession(
        store.selectedTradingDate,
      ),
    );
  };

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Practice Center</div>
          <div style={styles.title}>Practice Dashboard</div>
          <div style={styles.subtitle}>
            Work through every scanner and watchlist setup from the selected trading day.
          </div>
        </div>

        <div style={styles.progressBadge}>
          {completedCount}/{progress.total}
        </div>
      </div>

      <div style={styles.dashboardGrid}>
        <Metric
          label="Universe"
          value={String(progress.total)}
        />
        <Metric
          label="Completed"
          value={String(completedCount)}
        />
        <Metric
          label="Remaining"
          value={String(remainingCount)}
        />
        <Metric
          label="Skipped"
          value={String(skippedCount)}
        />
        <Metric
          label="Scanner Hits"
          value={String(store.scannerHitCount)}
        />
        <Metric
          label="Manual"
          value={String(store.manualWatchlistSymbolCount)}
        />
      </div>

      <div style={styles.progressTrack}>
        <div
          style={{
            ...styles.progressFill,
            width:
              progress.total > 0
                ? `${Math.min(
                    100,
                    ((completedCount + skippedCount) /
                      progress.total) *
                      100,
                  )}%`
                : "0%",
          }}
        />
      </div>

      {activeSymbol ? (
        <div style={styles.nextSetupCard}>
          <div style={styles.nextSetupTop}>
            <div>
              <div style={styles.nextSetupKicker}>
                Next Setup
              </div>
              <div style={styles.nextSetupSymbol}>
                {activeSymbol.symbol}
              </div>
              <div style={styles.nextSetupMeta}>
                {activeSymbol.scannerNames[0] ??
                  (activeSymbol.wasOnManualWatchlist
                    ? "Manual Watchlist"
                    : "Practice Symbol")}
                {" · "}
                {activeSymbol.scannerHitCount} scanner hit
                {activeSymbol.scannerHitCount === 1
                  ? ""
                  : "s"}
              </div>
            </div>

            <div style={styles.setupCounter}>
              {activeSymbolIndex + 1}/
              {orderedSymbolCount}
            </div>
          </div>

          <div style={styles.nextSetupActions}>
            <button
              type="button"
              onClick={moveToPreviousSymbol}
              disabled={activeSymbolIndex === 0}
              style={{
                ...styles.navigationButton,
                opacity:
                  activeSymbolIndex === 0
                    ? 0.45
                    : 1,
              }}
            >
              Previous
            </button>

            <button
              type="button"
              onClick={handleLaunchActiveSymbol}
              style={styles.primaryReplayButton}
            >
              Open Replay
            </button>

            <button
              type="button"
              onClick={handleCompleteAndNext}
              style={styles.completeButton}
            >
              Done
            </button>

            <button
              type="button"
              onClick={handleSkipAndNext}
              style={styles.skipButton}
            >
              Skip
            </button>

            <button
              type="button"
              onClick={moveToNextSymbol}
              disabled={
                activeSymbolIndex >=
                orderedSymbolCount - 1
              }
              style={{
                ...styles.navigationButton,
                opacity:
                  activeSymbolIndex >=
                  orderedSymbolCount - 1
                    ? 0.45
                    : 1,
              }}
            >
              Next
            </button>
          </div>
        </div>
      ) : null}

      {activeSymbol ? (
        <PracticeIntelligenceWidget
          report={activeIntelligenceReport}
          symbol={activeSymbol.symbol}
          loading={analysisRunner.isRunning}
        />
      ) : null}

      {analysisRunner.errors.length > 0 ? (
        <div style={styles.analysisError}>
          Intelligence analysis failed for {analysisRunner.errors.length}{" "}
          symbol{analysisRunner.errors.length === 1 ? "" : "s"}.
        </div>
      ) : null}

      <div style={styles.dateRow}>
        <label style={styles.fieldLabel}>
          Trading Day
          <select
            value={store.selectedTradingDate}
            onChange={handleTradingDateChange}
            style={styles.select}
          >
            {!store.availableTradingDates.includes(
              store.selectedTradingDate,
            ) && (
              <option value={store.selectedTradingDate}>
                {formatTradingDate(store.selectedTradingDate)}
              </option>
            )}

            {store.availableTradingDates.map((tradingDate) => (
              <option key={tradingDate} value={tradingDate}>
                {formatTradingDate(tradingDate)}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          onClick={store.selectToday}
          style={styles.todayButton}
        >
          Today
        </button>

        <button
          type="button"
          onClick={handleResetSession}
          disabled={progress.total === 0}
          style={{
            ...styles.todayButton,
            opacity: progress.total === 0 ? 0.45 : 1,
          }}
        >
          Reset Session
        </button>
      </div>

      <div style={styles.replayControls}>
        <label style={styles.fieldLabel}>
          Timeframe
          <select
            value={replayTimeframe}
            onChange={(event) =>
              setReplayTimeframe(
                event.target.value,
              )
            }
            style={styles.select}
          >
            <option value="1m">1 Minute</option>
            <option value="5m">5 Minute</option>
            <option value="15m">15 Minute</option>
            <option value="1h">1 Hour</option>
          </select>
        </label>

        <label style={styles.fieldLabel}>
          Start At
          <select
            value={replayStartMode}
            onChange={(event) =>
              setReplayStartMode(
                event.target
                  .value as ReplayStartMode,
              )
            }
            style={styles.select}
          >
            <option value="previous-close">
              Previous Close
            </option>
            <option value="after-hours">
              After Hours
            </option>
            <option value="overnight">
              Overnight
            </option>
            <option value="premarket">
              Premarket
            </option>
            <option value="market-open">
              Market Open
            </option>
            <option value="seven-am-pacific">
              7:00 AM Pacific
            </option>
            <option value="custom">
              Custom Time
            </option>
          </select>
        </label>

        {replayStartMode === "custom" && (
          <label style={styles.fieldLabel}>
            Custom Time
            <input
              type="time"
              value={replayCustomStartTime}
              onChange={(event) =>
                setReplayCustomStartTime(
                  event.target.value,
                )
              }
              style={styles.select}
            />
          </label>
        )}
      </div>

      <div style={styles.sessionNote}>
        Market Open loads through 6:29 AM Pacific.
        Press Play to begin with the 6:30 AM candle.
      </div>

      <div style={styles.toolbar}>
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search symbol, scanner, or setup"
          style={styles.search}
        />

        <div style={styles.filterRow}>
          {(
            [
              ["all", "All"],
              ["scanner", "Scanner"],
              ["manual_watchlist", "Manual"],
            ] as const
          ).map(([id, label]) => {
            const active = filter === id;

            return (
              <button
                key={id}
                type="button"
                onClick={() => setFilter(id)}
                style={{
                  ...styles.filterButton,
                  color: active ? "#ffffff" : "#94a3b8",
                  borderColor: active
                    ? "rgba(96,165,250,.55)"
                    : "rgba(148,163,184,.18)",
                  background: active
                    ? "rgba(37,99,235,.22)"
                    : "rgba(15,23,42,.72)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      {filteredSymbols.length === 0 ? (
        <div style={styles.empty}>
          {store.universe
            ? "No symbols match the selected filter."
            : "No scanner or manual-watchlist symbols have been saved for this day yet."}
        </div>
      ) : (
        <div style={styles.list}>
          {filteredSymbols.map((symbol) => {
            const latestPrice = getLatestScannerValue(
              symbol,
              "latestPrice",
            );
            const latestPercentChange = getLatestScannerValue(
              symbol,
              "latestPercentChange",
            );
            const latestVolume = getLatestScannerValue(
              symbol,
              "latestVolume",
            );

            return (
              <article key={symbol.id} style={styles.symbolCard}>
                <div style={styles.symbolHeader}>
                  <div>
                    <button
                      type="button"
                      onClick={() =>
                        handleLaunchReplay(symbol)
                      }
                      style={styles.symbolButton}
                      title={`Launch ${symbol.symbol} replay`}
                    >
                      {symbol.symbol}
                    </button>

                    <div style={styles.timeText}>
                      First {formatTime(symbol.firstSeenAt)} · Last{" "}
                      {formatTime(symbol.lastSeenAt)}
                    </div>
                  </div>

                  <div style={styles.symbolActions}>
                    <div style={styles.hitBadge}>
                      {symbol.scannerHitCount} hit
                      {symbol.scannerHitCount === 1 ? "" : "s"}
                    </div>

                    <button
                      type="button"
                      onClick={() =>
                        handleLaunchReplay(symbol)
                      }
                      style={styles.replayButton}
                    >
                      Replay
                    </button>
                  </div>
                </div>

                <div style={styles.sourceRow}>
                  {symbol.sourceTypes.map((source) => (
                    <span
                      key={source}
                      style={{
                        ...styles.sourceBadge,
                        color:
                          source === "scanner"
                            ? "#bfdbfe"
                            : "#ddd6fe",
                        borderColor:
                          source === "scanner"
                            ? "rgba(96,165,250,.38)"
                            : "rgba(167,139,250,.38)",
                        background:
                          source === "scanner"
                            ? "rgba(37,99,235,.12)"
                            : "rgba(124,58,237,.12)",
                      }}
                    >
                      {sourceLabel(source)}
                    </span>
                  ))}

                  {symbol.wasTraded && (
                    <span style={styles.tradedBadge}>Traded</span>
                  )}

                  {symbol.wasPracticed && (
                    <span style={styles.practicedBadge}>
                      Practiced {symbol.practiceCount}×
                    </span>
                  )}

                  {sessionSymbolByTicker.get(symbol.symbol)?.status ===
                    "active" && (
                    <span style={styles.activeBadge}>
                      Current
                    </span>
                  )}

                  {skippedSymbols.has(symbol.symbol) && (
                    <span style={styles.skippedBadge}>
                      Skipped
                    </span>
                  )}
                </div>

                <div style={styles.marketGrid}>
                  <MarketMetric
                    label="Last"
                    value={formatPrice(latestPrice)}
                  />
                  <MarketMetric
                    label="Change"
                    value={formatPercent(latestPercentChange)}
                  />
                  <MarketMetric
                    label="Volume"
                    value={formatNumber(latestVolume)}
                  />
                  <MarketMetric
                    label="Scanners"
                    value={String(symbol.scannerIds.length)}
                  />
                </div>

                {symbol.scannerSummaries.length > 0 && (
                  <div style={styles.scannerList}>
                    {symbol.scannerSummaries
                      .slice()
                      .sort(
                        (a, b) => b.lastSeenAt - a.lastSeenAt,
                      )
                      .map((summary) => (
                        <div
                          key={summary.scannerId}
                          style={styles.scannerRow}
                        >
                          <div>
                            <div style={styles.scannerName}>
                              {summary.scannerName}
                            </div>

                            <div style={styles.scannerMeta}>
                              {summary.hitCount} hit
                              {summary.hitCount === 1 ? "" : "s"} ·{" "}
                              {formatTime(summary.firstSeenAt)}–{formatTime(
                                summary.lastSeenAt,
                              )}
                            </div>
                          </div>

                          {summary.bestScore != null && (
                            <div style={styles.scoreBadge}>
                              {summary.bestScore.toFixed(1)}
                            </div>
                          )}
                        </div>
                      ))}
                  </div>
                )}

                {(symbol.setups.length > 0 ||
                  symbol.sessions.length > 0) && (
                  <div style={styles.tagRow}>
                    {symbol.setups.map((setup) => (
                      <span key={`setup-${setup}`} style={styles.tag}>
                        {setup}
                      </span>
                    ))}

                    {symbol.sessions
                      .filter((session) => session !== "unknown")
                      .map((session) => (
                        <span
                          key={`session-${session}`}
                          style={styles.sessionTag}
                        >
                          {session}
                        </span>
                      ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div style={styles.metric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function MarketMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div style={styles.marketMetric}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  card: {
    border: "1px solid rgba(148,163,184,.22)",
    borderRadius: 18,
    background:
      "linear-gradient(180deg, rgba(15,23,42,.96), rgba(2,6,23,.96))",
    padding: 14,
    boxShadow: "0 20px 50px rgba(0,0,0,.22)",
  },
  top: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    marginBottom: 12,
  },
  kicker: {
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 800,
    letterSpacing: 0.9,
    textTransform: "uppercase",
  },
  title: {
    marginTop: 2,
    color: "#f8fafc",
    fontSize: 16,
    fontWeight: 900,
  },
  subtitle: {
    marginTop: 4,
    color: "#64748b",
    fontSize: 10,
    lineHeight: 1.35,
  },
  progressBadge: {
    height: "fit-content",
    minWidth: 54,
    border: "1px solid rgba(45,212,191,.4)",
    borderRadius: 999,
    background: "rgba(13,148,136,.14)",
    color: "#99f6e4",
    padding: "6px 10px",
    textAlign: "center",
    fontSize: 12,
    fontWeight: 900,
  },
  dashboardGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3,minmax(0,1fr))",
    gap: 7,
    marginBottom: 8,
  },
  progressTrack: {
    height: 6,
    overflow: "hidden",
    borderRadius: 999,
    background: "rgba(51,65,85,.72)",
    marginBottom: 10,
  },
  progressFill: {
    height: "100%",
    borderRadius: 999,
    background:
      "linear-gradient(90deg, rgba(14,165,233,.95), rgba(45,212,191,.95))",
    transition: "width 180ms ease",
  },
  nextSetupCard: {
    border: "1px solid rgba(96,165,250,.3)",
    borderRadius: 14,
    background:
      "linear-gradient(135deg, rgba(30,64,175,.18), rgba(15,23,42,.9))",
    padding: 11,
    marginBottom: 10,
  },
  nextSetupTop: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
  },
  nextSetupKicker: {
    color: "#93c5fd",
    fontSize: 9,
    fontWeight: 900,
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  nextSetupSymbol: {
    color: "#f8fafc",
    fontSize: 22,
    fontWeight: 950,
    marginTop: 2,
  },
  nextSetupMeta: {
    color: "#94a3b8",
    fontSize: 9,
    fontWeight: 700,
    marginTop: 2,
  },
  setupCounter: {
    height: "fit-content",
    border: "1px solid rgba(148,163,184,.2)",
    borderRadius: 999,
    background: "rgba(15,23,42,.72)",
    color: "#cbd5e1",
    padding: "4px 7px",
    fontSize: 9,
    fontWeight: 900,
  },
  nextSetupActions: {
    display: "grid",
    gridTemplateColumns:
      "repeat(5,minmax(0,1fr))",
    gap: 6,
    marginTop: 10,
  },
  navigationButton: {
    border: "1px solid rgba(148,163,184,.24)",
    borderRadius: 8,
    background: "rgba(15,23,42,.72)",
    color: "#cbd5e1",
    padding: "7px 5px",
    fontSize: 9,
    fontWeight: 900,
    cursor: "pointer",
  },
  primaryReplayButton: {
    border: "1px solid rgba(96,165,250,.5)",
    borderRadius: 8,
    background: "rgba(37,99,235,.25)",
    color: "#dbeafe",
    padding: "7px 5px",
    fontSize: 9,
    fontWeight: 900,
    cursor: "pointer",
  },
  completeButton: {
    border: "1px solid rgba(45,212,191,.42)",
    borderRadius: 8,
    background: "rgba(13,148,136,.18)",
    color: "#99f6e4",
    padding: "7px 5px",
    fontSize: 9,
    fontWeight: 900,
    cursor: "pointer",
  },
  skipButton: {
    border: "1px solid rgba(251,191,36,.38)",
    borderRadius: 8,
    background: "rgba(217,119,6,.14)",
    color: "#fde68a",
    padding: "7px 5px",
    fontSize: 9,
    fontWeight: 900,
    cursor: "pointer",
  },
  totalBadge: {
    height: "fit-content",
    minWidth: 34,
    border: "1px solid rgba(96,165,250,.42)",
    borderRadius: 999,
    background: "rgba(37,99,235,.16)",
    color: "#bfdbfe",
    padding: "6px 10px",
    textAlign: "center",
    fontSize: 12,
    fontWeight: 900,
  },
  analysisError: {
    border: "1px solid rgba(239,68,68,.28)",
    borderRadius: 10,
    background: "rgba(127,29,29,.12)",
    color: "#fca5a5",
    padding: "8px 9px",
    marginBottom: 10,
    fontSize: 9,
    fontWeight: 750,
    lineHeight: 1.4,
  },
  dateRow: {
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) auto",
    alignItems: "end",
    gap: 8,
    marginBottom: 10,
  },
  fieldLabel: {
    display: "grid",
    gap: 5,
    color: "#94a3b8",
    fontSize: 10,
    fontWeight: 800,
  },
  select: {
    width: "100%",
    minWidth: 0,
    border: "1px solid rgba(148,163,184,.22)",
    borderRadius: 10,
    background: "rgba(15,23,42,.86)",
    color: "#e2e8f0",
    padding: "8px 9px",
    fontSize: 11,
    fontWeight: 800,
    outline: "none",
  },
  todayButton: {
    border: "1px solid rgba(96,165,250,.35)",
    borderRadius: 10,
    background: "rgba(37,99,235,.14)",
    color: "#bfdbfe",
    padding: "8px 10px",
    fontSize: 10,
    fontWeight: 900,
    cursor: "pointer",
  },
  replayControls: {
    display: "grid",
    gridTemplateColumns:
      "repeat(2,minmax(0,1fr))",
    gap: 8,
    marginBottom: 8,
  },
  sessionNote: {
    border: "1px solid rgba(96,165,250,.2)",
    borderRadius: 10,
    background: "rgba(37,99,235,.08)",
    color: "#93c5fd",
    padding: "7px 8px",
    marginBottom: 10,
    fontSize: 9,
    fontWeight: 750,
    lineHeight: 1.4,
  },
  metricGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    gap: 7,
    marginBottom: 10,
  },
  metric: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    border: "1px solid rgba(148,163,184,.14)",
    borderRadius: 10,
    background: "rgba(15,23,42,.72)",
    padding: "7px 8px",
    color: "#94a3b8",
    fontSize: 10,
  },
  toolbar: {
    display: "grid",
    gap: 8,
    marginBottom: 10,
  },
  search: {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid rgba(148,163,184,.2)",
    borderRadius: 10,
    background: "rgba(2,6,23,.7)",
    color: "#e2e8f0",
    padding: "9px 10px",
    fontSize: 11,
    outline: "none",
  },
  filterRow: {
    display: "grid",
    gridTemplateColumns: "repeat(3,minmax(0,1fr))",
    gap: 6,
  },
  filterButton: {
    border: "1px solid",
    borderRadius: 9,
    padding: "7px 6px",
    fontSize: 10,
    fontWeight: 900,
    cursor: "pointer",
  },
  empty: {
    border: "1px dashed rgba(148,163,184,.25)",
    borderRadius: 14,
    padding: 16,
    color: "#64748b",
    textAlign: "center",
    fontSize: 11,
    lineHeight: 1.45,
  },
  list: {
    display: "grid",
    gap: 10,
  },
  symbolCard: {
    border: "1px solid rgba(148,163,184,.16)",
    borderRadius: 14,
    background: "rgba(2,6,23,.56)",
    padding: 10,
  },
  symbolHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
  },
  symbolButton: {
    border: 0,
    background: "transparent",
    color: "#f8fafc",
    padding: 0,
    fontSize: 15,
    fontWeight: 950,
  },
  timeText: {
    marginTop: 3,
    color: "#64748b",
    fontSize: 9,
    fontWeight: 700,
  },
  symbolActions: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  replayButton: {
    border: "1px solid rgba(96,165,250,.42)",
    borderRadius: 8,
    background: "rgba(37,99,235,.16)",
    color: "#bfdbfe",
    padding: "5px 8px",
    fontSize: 9,
    fontWeight: 900,
    cursor: "pointer",
  },
  hitBadge: {
    border: "1px solid rgba(34,197,94,.3)",
    borderRadius: 999,
    background: "rgba(22,163,74,.1)",
    color: "#86efac",
    padding: "4px 7px",
    fontSize: 9,
    fontWeight: 900,
    whiteSpace: "nowrap",
  },
  sourceRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 8,
  },
  sourceBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  tradedBadge: {
    border: "1px solid rgba(250,204,21,.34)",
    borderRadius: 999,
    background: "rgba(250,204,21,.08)",
    color: "#fde68a",
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 900,
    textTransform: "uppercase",
  },
  practicedBadge: {
    border: "1px solid rgba(45,212,191,.34)",
    borderRadius: 999,
    background: "rgba(13,148,136,.1)",
    color: "#99f6e4",
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 900,
    textTransform: "uppercase",
  },
  skippedBadge: {
    border: "1px solid rgba(251,191,36,.34)",
    borderRadius: 999,
    background: "rgba(217,119,6,.1)",
    color: "#fde68a",
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 900,
    textTransform: "uppercase",
  },
  marketGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    gap: 6,
    marginTop: 9,
  },
  marketMetric: {
    display: "flex",
    justifyContent: "space-between",
    gap: 6,
    border: "1px solid rgba(148,163,184,.12)",
    borderRadius: 9,
    background: "rgba(15,23,42,.62)",
    padding: "6px 7px",
    color: "#64748b",
    fontSize: 9,
  },
  scannerList: {
    display: "grid",
    gap: 6,
    marginTop: 9,
  },
  scannerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
    borderLeft: "2px solid rgba(96,165,250,.45)",
    borderRadius: 8,
    background: "rgba(15,23,42,.55)",
    padding: "7px 8px",
  },
  scannerName: {
    color: "#cbd5e1",
    fontSize: 10,
    fontWeight: 850,
  },
  scannerMeta: {
    marginTop: 2,
    color: "#64748b",
    fontSize: 8,
    fontWeight: 700,
  },
  scoreBadge: {
    border: "1px solid rgba(96,165,250,.26)",
    borderRadius: 999,
    background: "rgba(37,99,235,.1)",
    color: "#93c5fd",
    padding: "4px 6px",
    fontSize: 9,
    fontWeight: 900,
  },
  tagRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
    marginTop: 8,
  },
  tag: {
    borderRadius: 7,
    background: "rgba(51,65,85,.58)",
    color: "#cbd5e1",
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 800,
  },
  sessionTag: {
    borderRadius: 7,
    background: "rgba(14,116,144,.13)",
    color: "#a5f3fc",
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 800,
    textTransform: "capitalize",
  },
};
