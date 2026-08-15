import type {
  Vwap3StudyResponse,
  Vwap3TradeCoachReview,
} from "../../../../../services/api";
import type { JournalTradeState } from "./TradingTypes";
import type { Vwap3PersonalCoachSummary } from "../../../../../trading/coach/Vwap3TradeCoachService";

type TradeJournalWidgetProps = {
  trades: JournalTradeState[];
  coachReviews?: Record<string, Vwap3TradeCoachReview>;
  coachStudy?: Vwap3StudyResponse | null;
  personalSummary?: Vwap3PersonalCoachSummary;
};

function money(value: number): string {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function pct(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${Number(value).toFixed(1)}%` : "—";
}

function reviewColor(review: Vwap3TradeCoachReview): string {
  if (review.classification === "likely_early_exit") return "#f59e0b";
  if (review.classification === "defensive_exit") return "#22c55e";
  if (review.classification === "target_exit") return "#22c55e";
  if (!review.scanner_match) return "#94a3b8";
  return "#60a5fa";
}

export default function TradeJournalWidget({
  trades,
  coachReviews = {},
  coachStudy = null,
  personalSummary,
}: TradeJournalWidgetProps) {
  const bestPullback = coachStudy?.best_observed_pullback;

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>Journal + AI Coach</div>
          <div style={styles.title}>Filled Trades</div>
        </div>

        <div style={styles.countBadge}>{trades.length}</div>
      </div>

      <div style={styles.notice}>
        Closed trades are automatically checked against the 3-VWAP scanner. The
        coach compares your entry, exit, frozen target, invalidation, and what
        price did after you exited.
      </div>

      {personalSummary && personalSummary.scannerMatchedTrades > 0 ? (
        <div style={styles.personalCard}>
          <div style={styles.studyHeader}>
            <strong>Your 3-VWAP Coaching Pattern</strong>
            <span>{personalSummary.scannerMatchedTrades} matched trades</span>
          </div>
          <div style={styles.studyGrid}>
            <Meta
              label="Avg Entry Quality"
              value={
                personalSummary.averageEntryQuality != null
                  ? `${personalSummary.averageEntryQuality.toFixed(0)}/100`
                  : "—"
              }
            />
            <Meta
              label="Likely Early Exits"
              value={String(personalSummary.likelyEarlyExits)}
            />
            <Meta
              label="Good Defensive Exits"
              value={String(personalSummary.defensiveExits)}
            />
            <Meta
              label="Target Hit After Exit"
              value={String(personalSummary.targetHitAfterExit)}
            />
          </div>
          {personalSummary.estimatedMissedPnlToTarget > 0 ? (
            <div style={styles.studyNote}>
              Estimated uncaptured P/L to frozen targets on reviewed exits: {money(personalSummary.estimatedMissedPnlToTarget)}.
              This is coaching context, not a claim that every target should have been held.
            </div>
          ) : null}
        </div>
      ) : null}

      {coachStudy && coachStudy.overall.setups > 0 ? (
        <div style={styles.studyCard}>
          <div style={styles.studyHeader}>
            <strong>3-VWAP Study · Last {coachStudy.days} Days</strong>
            <span>{coachStudy.overall.setups} setups</span>
          </div>
          <div style={styles.studyGrid}>
            <Meta
              label="Valid Hit Rate"
              value={pct(coachStudy.overall.hit_rate_pct)}
            />
            <Meta
              label="Hit After Invalidation"
              value={String(coachStudy.overall.target_hits_after_invalidation)}
            />
            <Meta
              label="Eventual Target Rate"
              value={pct(coachStudy.overall.eventual_target_rate_pct)}
            />
            <Meta
              label="Median Winner Pullback"
              value={pct(coachStudy.overall.median_pullback_before_target_pct)}
            />
            <Meta
              label="Median Time to Target"
              value={
                coachStudy.overall.median_minutes_to_target != null
                  ? `${coachStudy.overall.median_minutes_to_target.toFixed(0)}m`
                  : "—"
              }
            />
            <Meta
              label="Best Observed Pullback"
              value={
                bestPullback
                  ? `${bestPullback.pullback_pct}% · ${pct(bestPullback.hit_rate_pct)}`
                  : "Building data"
              }
            />
          </div>
          <div style={styles.studyNote}>
            Valid hits must reach target before invalidation. Target hits after invalidation are tracked separately for research.
          </div>
        </div>
      ) : null}

      {trades.length === 0 ? (
        <div style={styles.empty}>No completed Alpaca round-trip trades found yet. Journal times display in Pacific Time.</div>
      ) : (
        <div style={styles.list}>
          {trades.map((trade) => {
            const positive = trade.netPnl >= 0;
            const review = coachReviews[trade.id];

            return (
              <div key={trade.id} style={styles.tradeCard}>
                <div style={styles.tradeHeader}>
                  <div>
                    <div style={styles.tradeTitle}>
                      {trade.symbol} · {trade.strategy || "Trade"}
                    </div>

                    <div style={styles.tradeSub}>
                      {trade.date} · {trade.time} · {trade.holdTime}
                    </div>
                  </div>

                  <div
                    style={{
                      ...styles.pnlBadge,
                      color: positive ? "#22c55e" : "#ef4444",
                      borderColor: positive
                        ? "rgba(34,197,94,.4)"
                        : "rgba(239,68,68,.4)",
                      background: positive
                        ? "rgba(34,197,94,.1)"
                        : "rgba(239,68,68,.1)",
                    }}
                  >
                    {positive ? "+" : ""}
                    {money(trade.netPnl)}
                  </div>
                </div>

                <div style={styles.metaGrid}>
                  <Meta label="Side" value={trade.side.toUpperCase()} />
                  <Meta label="Shares" value={String(trade.shares)} />
                  <Meta label="Entry" value={money(trade.entry)} />
                  <Meta label="Exit" value={money(trade.exit)} />
                  <Meta label="Target" value={money(trade.target)} />
                  <Meta label="Stop" value={money(trade.stop)} />
                  <Meta label="Reason" value={trade.exitReason} />
                  <Meta label="R" value={`${trade.rMultiple.toFixed(2)}R`} />
                </div>

                {trade.notes ? <div style={styles.notes}>{trade.notes}</div> : null}

                {review ? (
                  <CoachReview review={review} />
                ) : (
                  <div style={styles.coachPending}>
                    AI Coach: checking this trade against 3-VWAP scanner history…
                  </div>
                )}

                <button type="button" style={styles.replayButton}>
                  Replay Trade
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function CoachReview({ review }: { review: Vwap3TradeCoachReview }) {
  const color = reviewColor(review);

  return (
    <div
      style={{
        ...styles.coachCard,
        borderColor: `${color}66`,
        background: `${color}10`,
      }}
    >
      <div style={styles.coachHeader}>
        <div>
          <div style={styles.coachKicker}>AI Trade Coach</div>
          <strong style={{ color }}>{review.headline}</strong>
        </div>
        {review.scanner_match ? (
          <div style={{ ...styles.gradeBadge, color }}>
            {review.scanner_grade || "3-VWAP"}
          </div>
        ) : null}
      </div>

      <div style={styles.coachSummary}>{review.summary}</div>

      {review.scanner_match ? (
        <div style={styles.coachMetrics}>
          <Meta
            label="Scanner Entry?"
            value={review.entry_after_scanner ? "Yes" : "Before signal"}
          />
          <Meta
            label="Entry Quality"
            value={
              review.entry_quality
                ? `${review.entry_quality.score}/100 · ${review.entry_quality.label}`
                : "—"
            }
          />
          <Meta
            label="Vs Freeze"
            value={pct(review.entry_quality?.entry_vs_freeze_pct)}
          />
          <Meta
            label="Target Left at Entry"
            value={pct(review.entry_quality?.target_remaining_pct_at_entry)}
          />
          {review.historical_context?.best_observed_pullback ? (
            <Meta
              label="Study Entry Reference"
              value={`${review.historical_context.best_observed_pullback.pullback_pct}% pullback · ${pct(review.historical_context.best_observed_pullback.hit_rate_pct)}`}
            />
          ) : null}
          <Meta
            label="Setup Valid at Exit"
            value={review.setup_valid_at_exit ? "Yes" : "No"}
          />
          <Meta
            label="Target After Exit"
            value={review.target_hit_after_exit ? "Yes" : "No"}
          />
          {review.minutes_exit_to_target != null ? (
            <Meta
              label="Exit → Target"
              value={`${review.minutes_exit_to_target.toFixed(0)}m`}
            />
          ) : null}
          {Number(review.estimated_missed_pnl_to_target) > 0 ? (
            <Meta
              label="Missed to Target"
              value={money(Number(review.estimated_missed_pnl_to_target))}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.meta}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  card: {
    border: "1px solid rgba(148, 163, 184, 0.22)",
    borderRadius: 18,
    background:
      "linear-gradient(180deg, rgba(15, 23, 42, 0.96), rgba(2, 6, 23, 0.96))",
    padding: 14,
    boxShadow: "0 20px 50px rgba(0,0,0,.22)",
  },
  top: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    marginBottom: 12,
  },
  kicker: {
    fontSize: 10,
    color: "#94a3b8",
    textTransform: "uppercase",
    letterSpacing: 0.9,
  },
  title: { fontSize: 16, fontWeight: 900 },
  countBadge: {
    border: "1px solid rgba(96,165,250,.4)",
    background: "rgba(37,99,235,.15)",
    color: "#bfdbfe",
    borderRadius: 999,
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 900,
    height: "fit-content",
  },
  notice: {
    border: "1px solid rgba(96,165,250,.18)",
    background: "rgba(37,99,235,.08)",
    color: "#93c5fd",
    borderRadius: 12,
    padding: "8px 10px",
    fontSize: 11,
    lineHeight: 1.35,
    marginBottom: 10,
  },
  personalCard: {
    border: "1px solid rgba(34,197,94,.24)",
    background: "rgba(20,83,45,.10)",
    borderRadius: 14,
    padding: 10,
    marginBottom: 10,
  },
  studyCard: {
    border: "1px solid rgba(168,85,247,.28)",
    background: "rgba(88,28,135,.10)",
    borderRadius: 14,
    padding: 10,
    marginBottom: 10,
  },
  studyHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    color: "#e9d5ff",
    fontSize: 11,
    marginBottom: 8,
  },
  studyGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 7,
  },
  studyNote: {
    marginTop: 7,
    fontSize: 10,
    color: "#a78bfa",
  },
  empty: {
    border: "1px dashed rgba(148,163,184,.25)",
    borderRadius: 14,
    padding: 14,
    color: "#64748b",
    fontSize: 12,
    textAlign: "center",
  },
  list: { display: "grid", gap: 10 },
  tradeCard: {
    border: "1px solid rgba(148,163,184,.16)",
    background: "rgba(2,6,23,.55)",
    borderRadius: 14,
    padding: 10,
  },
  tradeHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    marginBottom: 10,
  },
  tradeTitle: { fontSize: 13, fontWeight: 900, color: "#e5e7eb" },
  tradeSub: { marginTop: 3, color: "#64748b", fontSize: 10, fontWeight: 700 },
  pnlBadge: {
    border: "1px solid",
    borderRadius: 999,
    padding: "5px 8px",
    fontSize: 11,
    fontWeight: 900,
    height: "fit-content",
    whiteSpace: "nowrap",
  },
  metaGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 },
  meta: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    border: "1px solid rgba(148,163,184,.14)",
    background: "rgba(15,23,42,.75)",
    borderRadius: 10,
    padding: "7px 8px",
    color: "#94a3b8",
    fontSize: 10,
  },
  notes: { marginTop: 9, color: "#cbd5e1", fontSize: 11, lineHeight: 1.35 },
  coachPending: {
    marginTop: 10,
    border: "1px dashed rgba(96,165,250,.28)",
    borderRadius: 12,
    padding: 9,
    color: "#93c5fd",
    fontSize: 10,
  },
  coachCard: {
    marginTop: 10,
    border: "1px solid",
    borderRadius: 13,
    padding: 10,
  },
  coachHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 8,
    fontSize: 12,
  },
  coachKicker: {
    color: "#94a3b8",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 0.8,
    marginBottom: 2,
  },
  gradeBadge: {
    border: "1px solid currentColor",
    borderRadius: 999,
    padding: "3px 7px",
    fontSize: 9,
    fontWeight: 900,
  },
  coachSummary: {
    marginTop: 8,
    color: "#dbeafe",
    fontSize: 10,
    lineHeight: 1.45,
  },
  coachMetrics: {
    marginTop: 8,
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 6,
  },
  replayButton: {
    width: "100%",
    marginTop: 10,
    border: "1px solid rgba(96,165,250,.35)",
    background: "rgba(37,99,235,.16)",
    color: "#bfdbfe",
    borderRadius: 11,
    padding: "9px",
    fontSize: 11,
    fontWeight: 900,
    cursor: "pointer",
  },
};
