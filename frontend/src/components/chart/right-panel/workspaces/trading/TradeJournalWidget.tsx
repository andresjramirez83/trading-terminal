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
  if (review.entry_verdict === "AVOID") return "#ef4444";
  if (review.entry_verdict === "CAUTION") return "#f59e0b";
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
        coach compares your entry and exit with the frozen target and scanner
        invalidation, then reconstructs EMA/VWAP trend, 1m/5m structure,
        liquidity, demand/FVG context, and the price path after entry. Coach
        timestamps display in Pacific Time.
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
            <Meta
              label="Entries After Invalidation"
              value={String(personalSummary.entriesAfterInvalidation)}
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

function coachPrice(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "—";
  const number = Number(value);
  return number >= 1 ? `$${number.toFixed(2)}` : `$${number.toFixed(4)}`;
}

function coachTime(value: string | null | undefined): string {
  if (!value) return "—";
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

function yesNo(value: boolean | null | undefined): string {
  if (value == null) return "—";
  return value ? "Yes" : "No";
}

function CoachSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div style={styles.coachSection}>
      <div style={styles.coachSectionTitle}>{title}</div>
      {children}
    </div>
  );
}

function CoachReview({ review }: { review: Vwap3TradeCoachReview }) {
  const color = reviewColor(review);
  const trend = review.trend_context;
  const structure1m = review.structure_context?.["1m"];
  const structure5m = review.structure_context?.["5m"];
  const liquidity = review.liquidity_context;
  const demand = review.demand_context?.zone;
  const sweep = liquidity?.latest_sweep;
  const path5 = review.entry_path?.["5m"];
  const path15 = review.entry_path?.["15m"];
  const path30 = review.entry_path?.["30m"];

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
          <div style={styles.coachKicker}>AI Trade Coach · Pacific Time</div>
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
        <>
          <CoachSection title="Entry Verdict">
            <div style={styles.coachMetrics}>
              <Meta label="Overall" value={review.entry_verdict || "—"} />
              <Meta
                label="Entry Quality"
                value={
                  review.entry_quality
                    ? `${review.entry_quality.score}/100 · ${review.entry_quality.label}`
                    : "—"
                }
              />
              <Meta
                label="Setup Valid at Entry"
                value={yesNo(review.setup_valid_at_entry)}
              />
              <Meta
                label="Entry After Invalidation"
                value={yesNo(review.entry_after_invalidation)}
              />
              {review.entry_after_invalidation ? (
                <Meta
                  label="Late by"
                  value={
                    review.minutes_after_invalidation != null
                      ? `${review.minutes_after_invalidation.toFixed(0)}m`
                      : "—"
                  }
                />
              ) : null}
              <Meta
                label="Scanner Invalidation"
                value={coachTime(review.setup_invalidation_time)}
              />
              <Meta label="Your Entry" value={coachTime(review.entry_time_pt)} />
              <Meta
                label="Scanner Entry?"
                value={review.entry_after_scanner ? "Yes" : "Before signal"}
              />
              <Meta
                label="Vs Freeze"
                value={pct(review.entry_quality?.entry_vs_freeze_pct)}
              />
              <Meta
                label="Target Left at Entry"
                value={pct(review.entry_quality?.target_remaining_pct_at_entry)}
              />
              <Meta label="Freeze" value={coachPrice(review.freeze_price)} />
              <Meta label="Frozen +3" value={coachPrice(review.frozen_target)} />
              <Meta
                label="Displacement Low"
                value={coachPrice(review.displacement_low)}
              />
              <Meta label="Your Stop" value={coachPrice(review.planned_stop)} />
            </div>
            {review.entry_quality?.score_reasons?.length ? (
              <ul style={styles.coachBullets}>
                {review.entry_quality.score_reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            ) : null}
          </CoachSection>

          <CoachSection title="Trend · EMA / VWAP at Entry">
            <div style={styles.coachMetrics}>
              <Meta label="EMA9" value={coachPrice(trend?.ema9)} />
              <Meta label="EMA20" value={coachPrice(trend?.ema20)} />
              <Meta label="EMA200" value={coachPrice(trend?.ema200)} />
              <Meta label="VWAP" value={coachPrice(trend?.vwap)} />
              <Meta label="EMA Alignment" value={trend?.ema_alignment || "—"} />
              <Meta label="EMA9 Slope" value={trend?.ema9_slope || "—"} />
              <Meta label="EMA20 Slope" value={trend?.ema20_slope || "—"} />
              <Meta label="Above VWAP" value={yesNo(trend?.above_vwap)} />
              <Meta label="Above EMA9" value={yesNo(trend?.above_ema9)} />
              <Meta label="Above EMA20" value={yesNo(trend?.above_ema20)} />
              <Meta label="VWAP Distance" value={pct(trend?.vwap_distance_pct)} />
            </div>
          </CoachSection>

          <CoachSection title="Market Structure at Entry">
            <div style={styles.coachMetrics}>
              <Meta label="1m Structure" value={structure1m?.trend || "—"} />
              <Meta label="5m Structure" value={structure5m?.trend || "—"} />
              <Meta label="5m BOS" value={yesNo(structure5m?.bos)} />
              <Meta label="5m CHoCH" value={yesNo(structure5m?.choch)} />
              <Meta
                label="5m Swing High"
                value={coachPrice(structure5m?.last_swing_high)}
              />
              <Meta
                label="5m Swing Low"
                value={coachPrice(structure5m?.last_swing_low)}
              />
              <Meta label="5m HH" value={yesNo(structure5m?.higher_highs)} />
              <Meta label="5m HL" value={yesNo(structure5m?.higher_lows)} />
              <Meta label="5m LH" value={yesNo(structure5m?.lower_highs)} />
              <Meta label="5m LL" value={yesNo(structure5m?.lower_lows)} />
            </div>
          </CoachSection>

          <CoachSection title="Liquidity at Entry">
            <div style={styles.coachMetrics}>
              <Meta
                label="Liquidity Above"
                value={coachPrice(liquidity?.nearest_above)}
              />
              <Meta
                label="Liquidity Below"
                value={coachPrice(liquidity?.nearest_below)}
              />
              <Meta label="Equal Highs" value={yesNo(liquidity?.equal_highs)} />
              <Meta label="Equal Lows" value={yesNo(liquidity?.equal_lows)} />
              <Meta
                label="Latest Sweep"
                value={
                  sweep
                    ? `${sweep.side === "sell-side" ? "Sell-side" : "Buy-side"} @ ${coachPrice(sweep.price)}`
                    : "None confirmed"
                }
              />
              <Meta
                label="Sweep Reclaimed"
                value={sweep ? yesNo(sweep.reclaimed) : "—"}
              />
              {sweep?.time ? (
                <Meta label="Sweep Time" value={coachTime(sweep.time)} />
              ) : null}
            </div>
          </CoachSection>

          <CoachSection title="Demand / FVG Context">
            {demand ? (
              <div style={styles.coachMetrics}>
                <Meta
                  label="5m Demand Zone"
                  value={`${coachPrice(demand.bottom)}–${coachPrice(demand.top)}`}
                />
                <Meta label="Zone Status" value={demand.status || "—"} />
                <Meta label="Entry Location" value={demand.entry_location || "—"} />
                <Meta label="Distance" value={pct(demand.distance_pct)} />
                <Meta
                  label="Mitigation"
                  value={pct(demand.mitigation_pct)}
                />
                <Meta
                  label="Zone Confirmed"
                  value={coachTime(demand.confirmation_time)}
                />
              </div>
            ) : (
              <div style={styles.coachSectionEmpty}>
                No confirmed nearby 5-minute demand/FVG zone was found at entry.
              </div>
            )}
          </CoachSection>

          <CoachSection title="What Happened After Entry">
            <div style={styles.coachMetrics}>
              <Meta
                label="First 5m"
                value={`MFE ${pct(path5?.mfe_pct)} · MAE ${pct(path5?.mae_pct)}`}
              />
              <Meta
                label="First 15m"
                value={`MFE ${pct(path15?.mfe_pct)} · MAE ${pct(path15?.mae_pct)}`}
              />
              <Meta
                label="First 30m"
                value={`MFE ${pct(path30?.mfe_pct)} · MAE ${pct(path30?.mae_pct)}`}
              />
              <Meta
                label="Setup Valid at Exit"
                value={yesNo(review.setup_valid_at_exit)}
              />
              <Meta
                label="Target After Exit"
                value={review.target_hit_after_exit ? "Yes" : "No"}
              />
              <Meta
                label="MFE After Exit"
                value={pct(review.mfe_after_exit_pct)}
              />
            </div>
          </CoachSection>

          {review.first_confirmation_after_entry ? (
            <CoachSection title="First Later Technical Confirmation">
              <div style={styles.coachMetrics}>
                <Meta
                  label="Time"
                  value={coachTime(review.first_confirmation_after_entry.time)}
                />
                <Meta
                  label="Price"
                  value={coachPrice(review.first_confirmation_after_entry.price)}
                />
              </div>
              {review.first_confirmation_after_entry.reasons?.length ? (
                <ul style={styles.coachBullets}>
                  {review.first_confirmation_after_entry.reasons.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
            </CoachSection>
          ) : null}

          {review.what_went_well?.length ? (
            <CoachSection title="What You Did Well">
              <ul style={styles.coachBullets}>
                {review.what_went_well.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </CoachSection>
          ) : null}

          {review.next_time_guidance?.length ? (
            <CoachSection title="Next Time">
              <ul style={styles.coachBullets}>
                {review.next_time_guidance.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </CoachSection>
          ) : null}

          {review.historical_context?.best_observed_pullback ? (
            <div style={styles.coachStudyRef}>
              Study reference: {review.historical_context.best_observed_pullback.pullback_pct}% pullback · {pct(review.historical_context.best_observed_pullback.hit_rate_pct)} valid target rate in the observed sample. This is research context, not a required entry rule.
            </div>
          ) : null}
        </>
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
  coachSection: {
    marginTop: 10,
    borderTop: "1px solid rgba(148,163,184,.14)",
    paddingTop: 9,
  },
  coachSectionTitle: {
    marginBottom: 7,
    color: "#e2e8f0",
    fontSize: 10,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  coachSectionEmpty: {
    color: "#94a3b8",
    fontSize: 10,
    lineHeight: 1.4,
  },
  coachBullets: {
    margin: "8px 0 0 18px",
    padding: 0,
    color: "#cbd5e1",
    fontSize: 10,
    lineHeight: 1.45,
  },
  coachStudyRef: {
    marginTop: 10,
    border: "1px solid rgba(168,85,247,.2)",
    background: "rgba(88,28,135,.08)",
    borderRadius: 10,
    padding: 8,
    color: "#c4b5fd",
    fontSize: 9,
    lineHeight: 1.4,
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
