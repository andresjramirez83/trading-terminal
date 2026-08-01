import React, {
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import {
  getPracticeStarRating,
  type PracticeRecommendationCategory,
  type PracticeSetupType,
  type PracticeSymbolAnalysis,
} from "../../../../../trading/practice/analysis/PracticeAnalysisTypes";

import { usePracticeAnalysisStore } from "../../../../../trading/practice/analysis/usePracticeAnalysisStore";

export interface PracticeAnalysisWidgetProps {
  tradingDate: string;
  onSelectSymbol?: (params: {
    symbol: string;
    timeframe: string;
    tradingDate: string;
    jumpToTime?: number;
  }) => void;
}

type FilterValue =
  | "all"
  | PracticeRecommendationCategory
  | PracticeSetupType;

const FILTER_OPTIONS: Array<{
  value: FilterValue;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "best_overall", label: "Best Overall" },
  { value: "best_trend", label: "Trend" },
  {
    value: "best_opening_range_break",
    label: "ORB",
  },
  { value: "best_ifvg", label: "IFVG" },
  {
    value: "best_liquidity_sweep",
    label: "Liquidity",
  },
  { value: "reversal", label: "Reversal" },
  { value: "compression_breakout", label: "Compression" },
];

function formatScore(score: number): string {
  return String(Math.round(score));
}

function getDifficultyLabel(
  difficulty: PracticeSymbolAnalysis["difficulty"],
): string {
  switch (difficulty) {
    case "beginner":
      return "Beginner";
    case "advanced":
      return "Advanced";
    default:
      return "Intermediate";
  }
}

function getConditionLabel(
  condition: PracticeSymbolAnalysis["primaryCondition"],
): string {
  return condition
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getDirectionLabel(
  direction: PracticeSymbolAnalysis["primaryDirection"],
): string {
  if (direction === "bullish") return "Bullish";
  if (direction === "bearish") return "Bearish";
  return "Neutral";
}

function renderStars(score: number): string {
  const rating = getPracticeStarRating(score);

  return `${"★".repeat(rating)}${"☆".repeat(5 - rating)}`;
}

function findJumpToTime(
  analysis: PracticeSymbolAnalysis,
): number | undefined {
  return (
    analysis.recommendations[0]?.jumpToTime ??
    analysis.setups[0]?.confirmationAt ??
    analysis.setups[0]?.detectedAt
  );
}

export function PracticeAnalysisWidget({
  tradingDate,
  onSelectSymbol,
}: PracticeAnalysisWidgetProps): React.JSX.Element {
  const [filter, setFilter] =
    useState<FilterValue>("all");
  const [search, setSearch] = useState("");

  const store = usePracticeAnalysisStore({
    tradingDate,
  });

  const filteredSymbols = useMemo(() => {
    const normalizedSearch = search
      .trim()
      .toUpperCase();

    return store.symbols.filter((analysis) => {
      if (
        normalizedSearch &&
        !analysis.symbol.includes(normalizedSearch)
      ) {
        return false;
      }

      if (filter === "all") {
        return true;
      }

      const recommendationMatch =
        analysis.recommendations.some(
          (recommendation) =>
            recommendation.category === filter,
        );

      const setupMatch = analysis.setups.some(
        (setup) => setup.type === filter,
      );

      return recommendationMatch || setupMatch;
    });
  }, [store.symbols, filter, search]);

  const handleSelect = (
    analysis: PracticeSymbolAnalysis,
  ) => {
    onSelectSymbol?.({
      symbol: analysis.symbol,
      timeframe: analysis.timeframe,
      tradingDate: analysis.tradingDate,
      jumpToTime: findJumpToTime(analysis),
    });
  };

  return (
    <section style={styles.container}>
      <div style={styles.header}>
        <div>
          <div style={styles.eyebrow}>
            PRACTICE INTELLIGENCE
          </div>

          <div style={styles.titleRow}>
            <h3 style={styles.title}>
              Daily Analysis
            </h3>

            <span style={styles.countBadge}>
              {store.analyzedSymbolCount}
            </span>
          </div>
        </div>

        <div style={styles.dateBadge}>
          {tradingDate}
        </div>
      </div>

      <div style={styles.summaryGrid}>
        <SummaryCard
          label="Top Overall"
          value={store.topOverall?.symbol ?? "—"}
          score={store.topOverall?.overallScore}
        />

        <SummaryCard
          label="Best Trend"
          value={store.topTrend?.symbol ?? "—"}
          score={store.topTrend?.trend.score}
        />

        <SummaryCard
          label="Best IFVG"
          value={store.topIfvg?.symbol ?? "—"}
          score={store.topIfvg?.gaps.score}
        />

        <SummaryCard
          label="Best Sweep"
          value={
            store.topLiquiditySweep?.symbol ?? "—"
          }
          score={
            store.topLiquiditySweep?.liquidity.score
          }
        />
      </div>

      <div style={styles.toolbar}>
        <input
          type="search"
          value={search}
          onChange={(event) =>
            setSearch(event.target.value)
          }
          placeholder="Search symbol"
          style={styles.search}
        />

        <select
          value={filter}
          onChange={(event) =>
            setFilter(
              event.target.value as FilterValue,
            )
          }
          style={styles.select}
        >
          {FILTER_OPTIONS.map((option) => (
            <option
              key={option.value}
              value={option.value}
            >
              {option.label}
            </option>
          ))}
        </select>
      </div>

      {filteredSymbols.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyTitle}>
            No analysis yet
          </div>

          <div style={styles.emptyText}>
            Load the selected trading day and analyze
            symbols to generate rankings and replay
            recommendations.
          </div>
        </div>
      ) : (
        <div style={styles.list}>
          {filteredSymbols.map((analysis) => (
            <button
              key={analysis.id}
              type="button"
              onClick={() =>
                handleSelect(analysis)
              }
              style={styles.symbolCard}
            >
              <div style={styles.cardTop}>
                <div>
                  <div style={styles.symbolRow}>
                    <span style={styles.symbol}>
                      {analysis.symbol}
                    </span>

                    <span style={styles.timeframe}>
                      {analysis.timeframe}
                    </span>

                    <span style={styles.grade}>
                      {analysis.grade}
                    </span>
                  </div>

                  <div style={styles.stars}>
                    {renderStars(
                      analysis.replayScore,
                    )}
                  </div>
                </div>

                <div style={styles.scoreCircle}>
                  {formatScore(
                    analysis.overallScore,
                  )}
                </div>
              </div>

              <div style={styles.metricsGrid}>
                <Metric
                  label="Trend"
                  value={analysis.trend.score}
                />
                <Metric
                  label="Setup"
                  value={
                    analysis.setupQualityScore
                  }
                />
                <Metric
                  label="Replay"
                  value={analysis.replayScore}
                />
                <Metric
                  label="Clarity"
                  value={
                    analysis.executionClarityScore
                  }
                />
              </div>

              <div style={styles.metaRow}>
                <span style={styles.metaBadge}>
                  {getDifficultyLabel(
                    analysis.difficulty,
                  )}
                </span>

                <span style={styles.metaBadge}>
                  {getConditionLabel(
                    analysis.primaryCondition,
                  )}
                </span>

                <span style={styles.metaBadge}>
                  {getDirectionLabel(
                    analysis.primaryDirection,
                  )}
                </span>
              </div>

              {analysis.setups.length > 0 && (
                <div style={styles.setupRow}>
                  {analysis.setups
                    .slice(0, 3)
                    .map((setup) => (
                      <span
                        key={`${analysis.id}-${setup.type}-${setup.detectedAt}`}
                        style={styles.setupBadge}
                      >
                        {setup.type
                          .replace(/_/g, " ")
                          .toUpperCase()}
                      </span>
                    ))}
                </div>
              )}

              <div style={styles.reason}>
                {analysis.recommendations[0]
                  ?.reason ??
                  analysis.strengths[0] ??
                  analysis.risks[0] ??
                  "Analysis available"}
              </div>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SummaryCard({
  label,
  value,
  score,
}: {
  label: string;
  value: string;
  score?: number;
}): React.JSX.Element {
  return (
    <div style={styles.summaryCard}>
      <div style={styles.summaryLabel}>
        {label}
      </div>

      <div style={styles.summaryValueRow}>
        <span style={styles.summaryValue}>
          {value}
        </span>

        {Number.isFinite(score) && (
          <span style={styles.summaryScore}>
            {Math.round(Number(score))}
          </span>
        )}
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
}: {
  label: string;
  value: number;
}): React.JSX.Element {
  return (
    <div style={styles.metric}>
      <span style={styles.metricLabel}>
        {label}
      </span>

      <span style={styles.metricValue}>
        {Math.round(value)}
      </span>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  container: {
    display: "grid",
    gap: 12,
    border:
      "1px solid rgba(148,163,184,0.18)",
    borderRadius: 14,
    background:
      "linear-gradient(180deg, rgba(15,23,42,0.96), rgba(2,6,23,0.96))",
    padding: 12,
    color: "#e2e8f0",
  },

  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },

  eyebrow: {
    color: "#38bdf8",
    fontSize: 9,
    fontWeight: 900,
    letterSpacing: "0.14em",
  },

  titleRow: {
    display: "flex",
    alignItems: "center",
    gap: 7,
    marginTop: 3,
  },

  title: {
    margin: 0,
    color: "#f8fafc",
    fontSize: 15,
    fontWeight: 900,
  },

  countBadge: {
    display: "inline-flex",
    minWidth: 22,
    height: 22,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 999,
    background: "rgba(56,189,248,0.12)",
    color: "#7dd3fc",
    fontSize: 10,
    fontWeight: 900,
  },

  dateBadge: {
    border:
      "1px solid rgba(45,212,191,0.22)",
    borderRadius: 9,
    background: "rgba(13,148,136,0.08)",
    color: "#99f6e4",
    padding: "6px 8px",
    fontSize: 10,
    fontWeight: 850,
  },

  summaryGrid: {
    display: "grid",
    gridTemplateColumns:
      "repeat(2, minmax(0, 1fr))",
    gap: 8,
  },

  summaryCard: {
    border:
      "1px solid rgba(148,163,184,0.14)",
    borderRadius: 10,
    background: "rgba(15,23,42,0.72)",
    padding: "8px 9px",
  },

  summaryLabel: {
    color: "#64748b",
    fontSize: 9,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },

  summaryValueRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
    marginTop: 4,
  },

  summaryValue: {
    color: "#f8fafc",
    fontSize: 13,
    fontWeight: 900,
  },

  summaryScore: {
    color: "#38bdf8",
    fontSize: 11,
    fontWeight: 900,
  },

  toolbar: {
    display: "grid",
    gridTemplateColumns:
      "minmax(0, 1fr) 118px",
    gap: 8,
  },

  search: {
    width: "100%",
    minWidth: 0,
    boxSizing: "border-box",
    border:
      "1px solid rgba(148,163,184,0.18)",
    borderRadius: 9,
    background: "rgba(15,23,42,0.8)",
    color: "#e2e8f0",
    padding: "8px 9px",
    outline: "none",
    fontSize: 10,
    fontWeight: 750,
  },

  select: {
    width: "100%",
    minWidth: 0,
    border:
      "1px solid rgba(148,163,184,0.18)",
    borderRadius: 9,
    background: "rgba(15,23,42,0.8)",
    color: "#e2e8f0",
    padding: "8px 9px",
    outline: "none",
    fontSize: 10,
    fontWeight: 800,
  },

  list: {
    display: "grid",
    gap: 8,
    maxHeight: 560,
    overflowY: "auto",
    paddingRight: 2,
  },

  symbolCard: {
    display: "grid",
    gap: 8,
    width: "100%",
    border:
      "1px solid rgba(148,163,184,0.14)",
    borderRadius: 11,
    background: "rgba(15,23,42,0.74)",
    color: "inherit",
    padding: 10,
    textAlign: "left",
    cursor: "pointer",
  },

  cardTop: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },

  symbolRow: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },

  symbol: {
    color: "#f8fafc",
    fontSize: 14,
    fontWeight: 950,
    letterSpacing: "0.02em",
  },

  timeframe: {
    color: "#94a3b8",
    fontSize: 9,
    fontWeight: 850,
    textTransform: "uppercase",
  },

  grade: {
    borderRadius: 6,
    background: "rgba(34,197,94,0.1)",
    color: "#86efac",
    padding: "2px 5px",
    fontSize: 9,
    fontWeight: 950,
  },

  stars: {
    marginTop: 3,
    color: "#facc15",
    fontSize: 10,
    letterSpacing: "0.04em",
  },

  scoreCircle: {
    display: "inline-flex",
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    border:
      "1px solid rgba(56,189,248,0.28)",
    borderRadius: 999,
    background: "rgba(14,165,233,0.08)",
    color: "#7dd3fc",
    fontSize: 13,
    fontWeight: 950,
  },

  metricsGrid: {
    display: "grid",
    gridTemplateColumns:
      "repeat(4, minmax(0, 1fr))",
    gap: 5,
  },

  metric: {
    display: "grid",
    gap: 2,
    borderRadius: 7,
    background: "rgba(2,6,23,0.6)",
    padding: "5px 6px",
  },

  metricLabel: {
    color: "#64748b",
    fontSize: 8,
    fontWeight: 800,
    textTransform: "uppercase",
  },

  metricValue: {
    color: "#cbd5e1",
    fontSize: 10,
    fontWeight: 900,
  },

  metaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
  },

  metaBadge: {
    border:
      "1px solid rgba(148,163,184,0.14)",
    borderRadius: 999,
    background: "rgba(30,41,59,0.62)",
    color: "#cbd5e1",
    padding: "3px 6px",
    fontSize: 8,
    fontWeight: 850,
  },

  setupRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 5,
  },

  setupBadge: {
    borderRadius: 5,
    background: "rgba(168,85,247,0.1)",
    color: "#d8b4fe",
    padding: "3px 5px",
    fontSize: 8,
    fontWeight: 900,
  },

  reason: {
    color: "#94a3b8",
    fontSize: 9,
    fontWeight: 650,
    lineHeight: 1.4,
  },

  emptyState: {
    border:
      "1px dashed rgba(148,163,184,0.18)",
    borderRadius: 11,
    padding: "20px 14px",
    textAlign: "center",
  },

  emptyTitle: {
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: 900,
  },

  emptyText: {
    marginTop: 5,
    color: "#64748b",
    fontSize: 9,
    lineHeight: 1.5,
  },
};

export default PracticeAnalysisWidget;
