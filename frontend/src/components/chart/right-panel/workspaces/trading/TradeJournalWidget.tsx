import type {
  Vwap3StudyResponse,
  Vwap3TradeCoachReview,
} from "../../../../../services/api";
import type { JournalTradeState } from "./TradingTypes";
import type {
  Vwap3DeepTradeAnalysis,
  Vwap3PersonalCoachSummary,
} from "../../../../../trading/coach/Vwap3TradeCoachService";

type TradeJournalWidgetProps = {
  trades: JournalTradeState[];
  coachReviews?: Record<string, Vwap3TradeCoachReview>;
  coachStudy?: Vwap3StudyResponse | null;
  personalSummary?: Vwap3PersonalCoachSummary;
  showCoach?: boolean;
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
  showCoach = false,
}: TradeJournalWidgetProps) {
  const bestPullback = coachStudy?.best_observed_pullback;

  return (
    <section style={styles.card}>
      <div style={styles.top}>
        <div>
          <div style={styles.kicker}>
            {showCoach ? "VWAP +3 AI Coach" : "Journal"}
          </div>
          <div style={styles.title}>
            {showCoach ? "Trade Reviews" : "Filled Trades"}
          </div>
        </div>

        <div style={styles.countBadge}>{trades.length}</div>
      </div>

      {showCoach ? (
        <div style={styles.notice}>
          Closed trades are automatically reconstructed through the available session.
          The coach now grades entry, stop placement, exit execution, and the trade
          thesis separately; checks whether your planned target or stop was hit later;
          and compares those events with 1m/5m structure, demand/FVG support,
          liquidity sweeps, EMA/VWAP context, and recorded Level 2 behavior. Current-day
          reviews keep updating through the end of extended trading. Coach timestamps
          display in Pacific Time.
        </div>
      ) : null}

      {showCoach && personalSummary && personalSummary.scannerMatchedTrades > 0 ? (
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
            <Meta
              label="Early Into Support"
              value={String(personalSummary.earlyEntriesIntoSupport)}
            />
            <Meta
              label="Stop Placement Flags"
              value={String(personalSummary.stopPlacementIssues)}
            />
            <Meta
              label="Counter-Trend Entries"
              value={String(personalSummary.counterTrendEntries)}
            />
            <Meta
              label="Avg Stop Quality"
              value={score100(personalSummary.averageStopQuality)}
            />
            <Meta
              label="Avg Exit Quality"
              value={score100(personalSummary.averageExitQuality)}
            />
            <Meta
              label="Avg Thesis Quality"
              value={score100(personalSummary.averageThesisQuality)}
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

      {showCoach && coachStudy && coachStudy.overall.setups > 0 ? (
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

                {showCoach ? (
                  review ? (
                    <CoachReview review={review} />
                  ) : (
                    <div style={styles.coachPending}>
                      AI Coach: checking this trade against 3-VWAP scanner history…
                    </div>
                  )
                ) : null}

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

function score100(value: number | null | undefined): string {
  return Number.isFinite(value) ? `${Number(value).toFixed(0)}/100` : "—";
}

function secondsFromEntry(value: number | null | undefined): string {
  if (!Number.isFinite(value)) return "—";
  const seconds = Number(value);
  if (Math.abs(seconds) < 0.5) return "At entry";
  return `${seconds > 0 ? "+" : ""}${seconds.toFixed(0)}s`;
}

function gradeColor(score: number | null | undefined): string {
  if (!Number.isFinite(score)) return "#94a3b8";
  if (Number(score) >= 85) return "#22c55e";
  if (Number(score) >= 70) return "#60a5fa";
  if (Number(score) >= 60) return "#f59e0b";
  return "#ef4444";
}

function structureText(
  value: Vwap3DeepTradeAnalysis["structure_at_entry"],
): string {
  if (!value) return "—";
  const breakText = value.last_break_direction
    ? ` · ${value.last_break_direction.toUpperCase()} break`
    : "";
  return `${value.trend.toUpperCase()}${breakText}`;
}

function DeepGradeCard({
  title,
  grade,
}: {
  title: string;
  grade: Vwap3DeepTradeAnalysis["grades"]["entry"];
}) {
  const color = gradeColor(grade.score);
  return (
    <div style={{ ...styles.deepGradeCard, borderColor: `${color}55` }}>
      <div style={styles.deepGradeTitle}>{title}</div>
      <div style={{ ...styles.deepGradeValue, color }}>
        {grade.grade} · {grade.score}/100
      </div>
      <div style={styles.deepGradeLabel}>{grade.label}</div>
    </div>
  );
}

function DeepSessionReview({ deep }: { deep: Vwap3DeepTradeAnalysis }) {
  const demand = deep.support_context.demand_zone;
  const fvg = deep.support_context.bullish_fvg;

  return (
    <CoachSection title="Deep Session Review">
      <div style={styles.deepStatusRow}>
        <span style={styles.deepFocusBadge}>Focus: {deep.primary_focus}</span>
        <span style={styles.deepSessionBadge}>
          {deep.session_complete ? "SESSION COMPLETE" : "FOLLOWING SESSION"}
        </span>
      </div>

      <div style={styles.deepGradeGrid}>
        <DeepGradeCard title="Entry" grade={deep.grades.entry} />
        <DeepGradeCard title="Stop" grade={deep.grades.stop} />
        <DeepGradeCard title="Exit" grade={deep.grades.exit} />
        <DeepGradeCard title="Thesis" grade={deep.grades.thesis} />
      </div>

      <div style={styles.deepSummary}>{deep.summary}</div>

      <div style={styles.coachMetrics}>
        <Meta
          label="Target Used"
          value={`${coachPrice(deep.target_price)} · ${deep.target_source}`}
        />
        <Meta
          label="Stop Used"
          value={`${coachPrice(deep.stop_price)} · ${deep.stop_source}`}
        />
        <Meta
          label="Target After Exit"
          value={deep.target_hit_after_exit ? coachTime(deep.target_hit_after_exit_time) : "No"}
        />
        <Meta
          label="Stop Hit"
          value={
            deep.stop_hit_before_exit
              ? coachTime(deep.stop_hit_before_exit_time)
              : deep.stop_hit_after_exit
                ? coachTime(deep.stop_hit_after_exit_time)
                : "No"
          }
        />
        <Meta
          label="Target After Stop"
          value={
            deep.target_after_stop
              ? `Yes · ${deep.minutes_stop_to_target ?? "—"}m later`
              : "No"
          }
        />
        <Meta
          label="Deepest Pullback"
          value={`${coachPrice(deep.deepest_pullback_price)} · ${pct(deep.adverse_excursion_pct)} MAE`}
        />
      </div>

      <div style={styles.coachSectionMiniTitle}>Market Structure Through the Trade</div>
      <div style={styles.coachMetrics}>
        <Meta label="At Entry" value={structureText(deep.structure_at_entry)} />
        <Meta label="At Exit" value={structureText(deep.structure_at_exit)} />
        <Meta
          label="At Deep Pullback"
          value={structureText(deep.structure_at_deepest_pullback)}
        />
        <Meta label="At Stop" value={structureText(deep.structure_at_stop)} />
        <Meta label="At Target" value={structureText(deep.structure_at_target)} />
        <Meta
          label="Bullish Shift After Entry"
          value={coachTime(deep.first_bullish_structure_shift_after_entry)}
        />
        <Meta
          label="Bearish Break After Entry"
          value={coachTime(deep.first_bearish_structure_break_after_entry)}
        />
        <Meta
          label="Counter-Trend Entry"
          value={yesNo(deep.counter_trend_entry)}
        />
      </div>

      <div style={styles.coachSectionMiniTitle}>Support / Pullback Context</div>
      <div style={styles.coachMetrics}>
        <Meta
          label="Demand"
          value={
            demand
              ? `${coachPrice(demand.bottom)}–${coachPrice(demand.top)} · ${demand.held ? "held" : "failed"}`
              : "None"
          }
        />
        <Meta
          label="Bullish FVG"
          value={
            fvg
              ? `${coachPrice(fvg.bottom)}–${coachPrice(fvg.top)} · ${fvg.reclaimed ? "reclaimed" : fvg.held ? "held" : "failed"}`
              : "None"
          }
        />
        <Meta label="FVG + Demand Overlap" value={yesNo(deep.support_context.overlap)} />
        <Meta
          label="Liquidity Sweep"
          value={
            deep.support_context.bullish_liquidity_sweep
              ? `Yes @ ${coachPrice(deep.support_context.sweep_level)}`
              : "No"
          }
        />
        <Meta
          label="Entry Early Into Support"
          value={yesNo(deep.entry_was_early_into_support)}
        />
        <Meta
          label="Structure Failed Before Stop"
          value={yesNo(deep.structural_failure_before_stop)}
        />
      </div>

      {deep.grades.entry.reasons.length ||
      deep.grades.stop.reasons.length ||
      deep.grades.exit.reasons.length ||
      deep.grades.thesis.reasons.length ? (
        <div style={styles.deepReasonGrid}>
          {[
            ["Entry", deep.grades.entry.reasons],
            ["Stop", deep.grades.stop.reasons],
            ["Exit", deep.grades.exit.reasons],
            ["Thesis", deep.grades.thesis.reasons],
          ].map(([label, reasons]) => (
            <div key={String(label)} style={styles.deepReasonCard}>
              <strong>{String(label)}</strong>
              <ul style={styles.coachBullets}>
                {(reasons as string[]).map((reason) => (
                  <li key={`${label}-${reason}`}>{reason}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {deep.lessons.length ? (
        <>
          <div style={styles.coachSectionMiniTitle}>Main Lessons</div>
          <ul style={styles.coachBullets}>
            {deep.lessons.map((lesson) => (
              <li key={lesson}>{lesson}</li>
            ))}
          </ul>
        </>
      ) : null}
    </CoachSection>
  );
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
  const deep = (review as Vwap3TradeCoachReview & {
    deep_analysis?: Vwap3DeepTradeAnalysis;
  }).deep_analysis;
  const trend = review.trend_context;
  const structure1m = review.structure_context?.["1m"];
  const structure5m = review.structure_context?.["5m"];
  const liquidity = review.liquidity_context;
  const level2 = review.level2_context;
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

      {deep ? <DeepSessionReview deep={deep} /> : null}

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

          <CoachSection title="Level 2 Breakout Behavior · Research">
            {level2?.available ? (
              <>
                <div style={styles.coachMetrics}>
                  <Meta label="At Entry" value={`${score100(level2.score_at_entry)} · ${level2.state_at_entry || "—"}`} />
                  <Meta label="Best Pre-Entry" value={score100(level2.pre_entry_max_score)} />
                  <Meta label="Best Post-Entry" value={score100(level2.post_entry_max_score)} />
                  <Meta label="Peak" value={`${score100(level2.peak_score)} · ${secondsFromEntry(level2.peak_seconds_from_entry)}`} />
                  <Meta label="First Strong" value={secondsFromEntry(level2.first_strong_seconds_from_entry)} />
                  <Meta label="Breakout Pressure" value={secondsFromEntry(level2.first_breakout_seconds_from_entry)} />
                  <Meta label="Book Pressure" value={level2.book_pressure_at_entry != null ? `${level2.book_pressure_at_entry > 0 ? "+" : ""}${level2.book_pressure_at_entry.toFixed(1)}` : "—"} />
                  <Meta label="Top-5 Imbalance" value={level2.top5_imbalance_at_entry != null ? `${level2.top5_imbalance_at_entry.toFixed(2)}x` : "—"} />
                  <Meta label="Bid Stacking" value={pct(level2.bid_stacking_pct_at_entry)} />
                  <Meta label="Ask Pulling" value={pct(level2.ask_pulling_pct_at_entry)} />
                  <Meta label="Ask Absorption" value={score100(level2.ask_absorption_score_at_entry)} />
                  <Meta label="Aggressive Tape" value={pct(level2.trade_pressure_5s_at_entry)} />
                  <Meta label="Thin Upside Path" value={yesNo(level2.upside_path_thin_at_entry)} />
                  <Meta label="Samples" value={String(level2.sample_count || 0)} />
                </div>
                {level2.summary ? (
                  <div style={styles.coachSectionEmpty}>{level2.summary}</div>
                ) : null}
                {level2.signals?.length ? (
                  <ul style={styles.coachBullets}>
                    {level2.signals.map((item) => (
                      <li key={`l2-positive-${item}`}>L2: {item}</li>
                    ))}
                  </ul>
                ) : null}
                {level2.cautions?.length ? (
                  <ul style={styles.coachBullets}>
                    {level2.cautions.map((item) => (
                      <li key={`l2-caution-${item}`}>L2 caution: {item}</li>
                    ))}
                  </ul>
                ) : null}
              </>
            ) : (
              <div style={styles.coachSectionEmpty}>
                No Level 2 research history was recorded around this entry. New 3-VWAP candidates are collected automatically when the Moomoo research collector is active.
              </div>
            )}
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
  deepStatusRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 8,
  },
  deepFocusBadge: {
    border: "1px solid rgba(96,165,250,.35)",
    background: "rgba(37,99,235,.12)",
    color: "#bfdbfe",
    borderRadius: 999,
    padding: "4px 7px",
    fontSize: 9,
    fontWeight: 900,
  },
  deepSessionBadge: {
    border: "1px solid rgba(168,85,247,.32)",
    background: "rgba(88,28,135,.12)",
    color: "#ddd6fe",
    borderRadius: 999,
    padding: "4px 7px",
    fontSize: 9,
    fontWeight: 900,
  },
  deepGradeGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 7,
  },
  deepGradeCard: {
    border: "1px solid",
    background: "rgba(15,23,42,.72)",
    borderRadius: 11,
    padding: 8,
  },
  deepGradeTitle: {
    color: "#94a3b8",
    fontSize: 9,
    fontWeight: 800,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  deepGradeValue: {
    marginTop: 3,
    fontSize: 13,
    fontWeight: 950,
  },
  deepGradeLabel: {
    marginTop: 2,
    color: "#cbd5e1",
    fontSize: 9,
    lineHeight: 1.3,
  },
  deepSummary: {
    marginTop: 8,
    border: "1px solid rgba(96,165,250,.18)",
    background: "rgba(30,58,138,.08)",
    color: "#dbeafe",
    borderRadius: 10,
    padding: 8,
    fontSize: 10,
    lineHeight: 1.45,
  },
  coachSectionMiniTitle: {
    marginTop: 10,
    color: "#94a3b8",
    fontSize: 9,
    fontWeight: 900,
    textTransform: "uppercase",
    letterSpacing: 0.55,
  },
  deepReasonGrid: {
    display: "grid",
    gap: 7,
    marginTop: 9,
  },
  deepReasonCard: {
    border: "1px solid rgba(148,163,184,.12)",
    background: "rgba(15,23,42,.48)",
    borderRadius: 10,
    padding: 8,
    color: "#cbd5e1",
    fontSize: 9,
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
