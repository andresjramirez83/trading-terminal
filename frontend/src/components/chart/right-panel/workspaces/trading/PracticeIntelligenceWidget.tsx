// src/components/chart/right-panel/workspaces/trading/PracticeIntelligenceWidget.tsx

import type { CSSProperties } from "react";

import type { MarketIntelligenceReport } from "../../../../../trading/intelligence/core/IntelligenceTypes";
import type { MarketMemoryEngineResult } from "../../../../../trading/memory/MarketMemoryEngine";
import type { MarketMemorySnapshot } from "../../../../../trading/memory/MarketMemoryTypes";
import type { MarketStory } from "../../../../../trading/memory/MarketStoryBuilder";

export interface PracticeIntelligenceWidgetProps {
  report: MarketIntelligenceReport | null;
  symbol?: string;
  loading?: boolean;
}

function percent(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;

  const normalized = value as number;
  return Math.round(
    Math.max(
      0,
      Math.min(
        100,
        normalized <= 1 ? normalized * 100 : normalized,
      ),
    ),
  );
}

function isMemoryResult(value: unknown): value is MarketMemoryEngineResult {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<MarketMemoryEngineResult>;
  return Boolean(
    candidate.memory &&
      candidate.story &&
      Array.isArray(candidate.sequences),
  );
}

function isMemorySnapshot(value: unknown): value is MarketMemorySnapshot {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<MarketMemorySnapshot>;
  return (
    typeof candidate.symbol === "string" &&
    typeof candidate.timeframe === "string" &&
    Array.isArray(candidate.events) &&
    Array.isArray(candidate.activeSequences)
  );
}

function isMarketStory(value: unknown): value is MarketStory {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<MarketStory>;
  return (
    typeof candidate.headline === "string" &&
    typeof candidate.summary === "string" &&
    Array.isArray(candidate.keyEvents)
  );
}

function readMemoryResult(
  report: MarketIntelligenceReport,
): MarketMemoryEngineResult | null {
  const candidates = [
    report.metadata?.marketMemoryResult,
    report.metadata?.marketMemoryEngineResult,
  ];

  for (const candidate of candidates) {
    if (isMemoryResult(candidate)) return candidate;
  }

  return null;
}

function readMemorySnapshot(
  report: MarketIntelligenceReport,
  memoryResult: MarketMemoryEngineResult | null,
): MarketMemorySnapshot | null {
  if (memoryResult?.memory) return memoryResult.memory;

  const candidates = [
    report.metadata?.marketMemory,
    report.metadata?.marketMemorySnapshot,
    report.metadata?.memorySnapshot,
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

  const candidates = [
    report.metadata?.marketStory,
    report.metadata?.marketMemoryStory,
  ];

  for (const candidate of candidates) {
    if (isMarketStory(candidate)) return candidate;
  }

  return null;
}

function directionColor(
  direction: MarketIntelligenceReport["direction"],
): string {
  if (direction === "bullish") return "#22c55e";
  if (direction === "bearish") return "#ef4444";
  return "#94a3b8";
}

function recommendationColor(
  report: MarketIntelligenceReport,
): string {
  if (report.recommendation.canTrade) {
    return directionColor(report.direction);
  }

  if (report.recommendation.shouldWait) {
    return "#f59e0b";
  }

  return "#94a3b8";
}

export default function PracticeIntelligenceWidget({
  report,
  symbol,
  loading = false,
}: PracticeIntelligenceWidgetProps) {
  if (!report) {
    return (
      <section style={styles.shell}>
        <div style={styles.header}>
          <div>
            <div style={styles.kicker}>Replay Intelligence</div>
            <div style={styles.title}>
              {symbol ? `${symbol} Market Story` : "Market Story"}
            </div>
          </div>

          <div style={styles.pendingBadge}>
            {loading ? "Analyzing" : "Pending"}
          </div>
        </div>

        <div style={styles.empty}>
          {loading
            ? "Historical bars are being evaluated by the shared intelligence engine."
            : "Run Practice Center analysis to generate the replay market story, decision, and coaching."}
        </div>
      </section>
    );
  }

  const memoryResult = readMemoryResult(report);
  const memory = readMemorySnapshot(report, memoryResult);
  const marketStory = readMarketStory(report, memoryResult);
  const confidence = percent(
    marketStory?.confidence ?? report.marketConfidence,
  );
  const color = directionColor(report.direction);
  const actionColor = recommendationColor(report);
  const eventCount = memory?.events.length ?? 0;
  const sequenceCount = memory?.activeSequences.length ?? 0;

  return (
    <section style={styles.shell}>
      <div style={styles.header}>
        <div>
          <div style={styles.kicker}>Replay Intelligence</div>
          <div style={styles.title}>
            {marketStory?.headline || report.narrative.headline}
          </div>
        </div>

        <div
          style={{
            ...styles.directionBadge,
            color,
            borderColor: `${color}55`,
            background: `${color}16`,
          }}
        >
          {report.direction}
        </div>
      </div>

      <div style={styles.summary}>
        {marketStory?.summary ||
          report.narrative.shortSummary ||
          report.summary}
      </div>

      <div style={styles.confidenceRow}>
        <span>Confidence</span>
        <strong style={{ color }}>{confidence}%</strong>
      </div>

      <div style={styles.track}>
        <div
          style={{
            ...styles.fill,
            width: `${confidence}%`,
            background: color,
          }}
        />
      </div>

      <div style={styles.metricGrid}>
        <Metric label="Grade" value={report.grade} />
        <Metric
          label="Trade Score"
          value={Math.round(report.tradeScore).toString()}
        />
        <Metric
          label="Conviction"
          value={Math.round(report.convictionScore).toString()}
        />
        <Metric
          label="Events"
          value={eventCount.toString()}
        />
        <Metric
          label="Sequences"
          value={sequenceCount.toString()}
        />
        <Metric
          label="Regime"
          value={report.context.regime.regime}
        />
      </div>

      <div
        style={{
          ...styles.recommendation,
          borderColor: `${actionColor}44`,
          background: `${actionColor}12`,
        }}
      >
        <div
          style={{
            ...styles.recommendationLabel,
            color: actionColor,
          }}
        >
          Coach Action
        </div>

        <div style={styles.recommendationTitle}>
          {report.recommendation.label}
        </div>

        <div style={styles.recommendationSummary}>
          {report.recommendation.summary}
        </div>
      </div>

      <div style={styles.thesisGrid}>
        <Thesis
          label="Bullish Thesis"
          value={
            marketStory?.bullishThesis ??
            "No strong bullish thesis stored."
          }
          color="#22c55e"
        />

        <Thesis
          label="Bearish Thesis"
          value={
            marketStory?.bearishThesis ??
            "No strong bearish thesis stored."
          }
          color="#ef4444"
        />
      </div>

      {report.coach.messages.length > 0 ? (
        <div style={styles.coachBox}>
          <div style={styles.coachKicker}>AI Coach</div>
          <div style={styles.coachHeadline}>
            {report.coach.headline}
          </div>
          <div style={styles.coachSummary}>
            {report.coach.messages[0]?.message ??
              report.coach.summary}
          </div>
        </div>
      ) : null}

      {marketStory?.keyEvents?.length ? (
        <div style={styles.eventsBox}>
          <div style={styles.eventsTitle}>Key Replay Events</div>

          {marketStory.keyEvents
            .slice(-4)
            .reverse()
            .map((event, index) => (
              <div
                key={`${event}-${index}`}
                style={styles.eventRow}
              >
                <span style={styles.eventDot} />
                <span>{event}</span>
              </div>
            ))}
        </div>
      ) : null}
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
      <span style={styles.metricLabel}>{label}</span>
      <strong style={styles.metricValue} title={value}>
        {value}
      </strong>
    </div>
  );
}

function Thesis({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div
      style={{
        ...styles.thesis,
        borderColor: `${color}35`,
      }}
    >
      <div
        style={{
          ...styles.thesisLabel,
          color,
        }}
      >
        {label}
      </div>

      <div style={styles.thesisText}>{value}</div>
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  shell: {
    marginTop: 10,
    border: "1px solid rgba(56,189,248,.2)",
    borderRadius: 14,
    background:
      "linear-gradient(145deg, rgba(8,47,73,.18), rgba(15,23,42,.88))",
    padding: 11,
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 10,
  },
  kicker: {
    color: "#7dd3fc",
    fontSize: 9,
    fontWeight: 900,
    letterSpacing: ".09em",
    textTransform: "uppercase",
  },
  title: {
    marginTop: 3,
    color: "#f8fafc",
    fontSize: 13,
    fontWeight: 900,
    lineHeight: 1.3,
  },
  pendingBadge: {
    flexShrink: 0,
    border: "1px solid rgba(245,158,11,.36)",
    borderRadius: 999,
    background: "rgba(245,158,11,.1)",
    color: "#fcd34d",
    padding: "4px 7px",
    fontSize: 9,
    fontWeight: 900,
  },
  directionBadge: {
    flexShrink: 0,
    border: "1px solid",
    borderRadius: 999,
    padding: "4px 7px",
    fontSize: 9,
    fontWeight: 900,
    textTransform: "capitalize",
  },
  empty: {
    marginTop: 10,
    borderRadius: 10,
    background: "rgba(15,23,42,.55)",
    color: "#94a3b8",
    padding: 10,
    fontSize: 10,
    lineHeight: 1.5,
  },
  summary: {
    marginTop: 9,
    color: "#cbd5e1",
    fontSize: 10.5,
    lineHeight: 1.5,
  },
  confidenceRow: {
    display: "flex",
    justifyContent: "space-between",
    marginTop: 10,
    color: "#94a3b8",
    fontSize: 9,
    fontWeight: 800,
  },
  track: {
    height: 6,
    marginTop: 5,
    overflow: "hidden",
    borderRadius: 999,
    background: "rgba(51,65,85,.8)",
  },
  fill: {
    height: "100%",
    borderRadius: 999,
    transition: "width 180ms ease",
  },
  metricGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3,minmax(0,1fr))",
    gap: 6,
    marginTop: 10,
  },
  metric: {
    minWidth: 0,
    border: "1px solid rgba(148,163,184,.12)",
    borderRadius: 9,
    background: "rgba(15,23,42,.62)",
    padding: 7,
  },
  metricLabel: {
    display: "block",
    color: "#64748b",
    fontSize: 8,
    fontWeight: 800,
    textTransform: "uppercase",
  },
  metricValue: {
    display: "block",
    marginTop: 3,
    overflow: "hidden",
    color: "#e2e8f0",
    fontSize: 10,
    fontWeight: 900,
    textOverflow: "ellipsis",
    textTransform: "capitalize",
    whiteSpace: "nowrap",
  },
  recommendation: {
    marginTop: 9,
    border: "1px solid",
    borderRadius: 10,
    padding: 9,
  },
  recommendationLabel: {
    fontSize: 8.5,
    fontWeight: 900,
    letterSpacing: ".08em",
    textTransform: "uppercase",
  },
  recommendationTitle: {
    marginTop: 3,
    color: "#f8fafc",
    fontSize: 11,
    fontWeight: 900,
  },
  recommendationSummary: {
    marginTop: 4,
    color: "#cbd5e1",
    fontSize: 9.5,
    lineHeight: 1.45,
  },
  thesisGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2,minmax(0,1fr))",
    gap: 7,
    marginTop: 9,
  },
  thesis: {
    border: "1px solid",
    borderRadius: 10,
    background: "rgba(15,23,42,.5)",
    padding: 8,
  },
  thesisLabel: {
    fontSize: 8.5,
    fontWeight: 900,
    letterSpacing: ".07em",
    textTransform: "uppercase",
  },
  thesisText: {
    marginTop: 4,
    color: "#cbd5e1",
    fontSize: 9,
    lineHeight: 1.45,
  },
  coachBox: {
    marginTop: 9,
    border: "1px solid rgba(167,139,250,.25)",
    borderRadius: 10,
    background: "rgba(124,58,237,.08)",
    padding: 9,
  },
  coachKicker: {
    color: "#c4b5fd",
    fontSize: 8.5,
    fontWeight: 900,
    letterSpacing: ".08em",
    textTransform: "uppercase",
  },
  coachHeadline: {
    marginTop: 3,
    color: "#f5f3ff",
    fontSize: 10.5,
    fontWeight: 900,
  },
  coachSummary: {
    marginTop: 4,
    color: "#ddd6fe",
    fontSize: 9.5,
    lineHeight: 1.45,
  },
  eventsBox: {
    marginTop: 9,
    border: "1px solid rgba(148,163,184,.12)",
    borderRadius: 10,
    background: "rgba(15,23,42,.45)",
    padding: 9,
  },
  eventsTitle: {
    marginBottom: 6,
    color: "#94a3b8",
    fontSize: 8.5,
    fontWeight: 900,
    letterSpacing: ".08em",
    textTransform: "uppercase",
  },
  eventRow: {
    display: "grid",
    gridTemplateColumns: "6px minmax(0,1fr)",
    alignItems: "start",
    gap: 7,
    marginTop: 5,
    color: "#cbd5e1",
    fontSize: 9,
    lineHeight: 1.4,
  },
  eventDot: {
    width: 6,
    height: 6,
    marginTop: 3,
    borderRadius: 999,
    background: "#38bdf8",
  },
};

