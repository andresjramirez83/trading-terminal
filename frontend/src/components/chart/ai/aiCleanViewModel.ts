import type { AIMarkup, AIProjections, AIScenarioFrame, AIMultiTimeframe, AIFairValueGap } from "../../../services/aiAnalysis";

/** Minimal, price-anchored view of an EXISTING rule-based conditional scenario.
 * No inference, market data calls, or order actions happen here.
 */
export type AICleanView = {
  timeframe: "1m" | "5m";
  bias: "bullish" | "bearish" | "range";
  stale: boolean;
  anchorTimeMs: number;
  anchorPrice: number;
  path: { step: number; price: number }[] | null;
  reaction: { low: number; high: number; label: string };
  target: number | null;
  targetLabel: string;
  invalidation: number | null;
  marker: { time_ms: number; price: number } | null;
};

const price = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function validPath(points: unknown, anchor: number): { step: number; price: number }[] | null {
  if (!Array.isArray(points) || points.length < 2 || points.length > 8) return null;
  let previous = -1;
  const result: { step: number; price: number }[] = [];
  for (const point of points) {
    if (!point || !Number.isInteger(point.step) || point.step < 0 || point.step > 20 ||
        !price(point.price) || point.step <= previous) return null;
    result.push({ step: point.step, price: point.price });
    previous = point.step;
  }
  if (result[0].step !== 0 || Math.abs(result[0].price - anchor) > Math.max(0.000001, anchor * 0.00001)) return null;
  return result;
}

export function selectCleanAIView(
  timeframe: string,
  projections: AIProjections | null | undefined,
  marks: AIMarkup[],
  mtf?: AIMultiTimeframe | null,
): AICleanView | null {
  const tf = timeframe.toLowerCase();
  if (tf !== "1m" && tf !== "5m") return null;
  const f: AIScenarioFrame | undefined = projections?.timeframes?.[tf];
  if (!f || !price(f.anchor_price) || !Number.isSafeInteger(f.anchor_time_ms) || f.anchor_time_ms <= 0 ||
      !price(f.support) || !price(f.resistance) || f.support >= f.resistance ||
      !finite(f.upside_trigger) || !finite(f.downside_trigger) ||
      (f.bias !== "bullish" && f.bias !== "bearish" && f.bias !== "range")) return null;

  const bullish = f.bias === "bullish";
  const bearish = f.bias === "bearish";
  // Do not silently turn a range into an upward-looking prediction.
  const sourcePath = bullish ? f.bullish_path : bearish ? f.bearish_path : null;
  const path = !f.stale && sourcePath ? validPath(sourcePath, f.anchor_price) : null;
  const span = f.resistance - f.support;
  // Tight, local reaction band rather than a screen-wide box or fib ladder.
  const halfWidth = Math.min(f.anchor_price * 0.015, Math.max(f.anchor_price * 0.001, span * 0.04));
  const center = bearish ? f.resistance : f.support;
  let reaction = {
    low: Math.max(0.000001, center - halfWidth),
    high: center + halfWidth,
    label: bearish ? "Resistance" : "Support",
  };
  // A single relevant higher-TF FVG REPLACES the ordinary reaction band.
  // Never stack it as another chart box or show stale/filled gaps.
  const gaps: AIFairValueGap[] = Array.isArray(mtf?.ranked_open_gaps) ? mtf.ranked_open_gaps : [];
  const validGap = (g: AIFairValueGap): boolean =>
    !g.data_stale && (g.status === "untouched" || g.status === "retested" || g.status === "partially_filled") &&
    price(g.remaining_low) && price(g.remaining_high) && g.remaining_low < g.remaining_high &&
    g.remaining_high - g.remaining_low < f.anchor_price * .10;
  const nearby = gaps.find((g) => validGap(g) &&
    (bullish ? g.direction === "bullish" && g.remaining_low <= f.anchor_price * 1.01
             : bearish ? g.direction === "bearish" && g.remaining_high >= f.anchor_price * .99
                       : false) &&
    Math.max(0, g.remaining_low - f.anchor_price, f.anchor_price - g.remaining_high) < f.anchor_price * .04);
  if (nearby && !f.stale) reaction = {
    low: nearby.remaining_low, high: nearby.remaining_high,
    label: `${nearby.timeframe} ${nearby.direction === "bullish" ? "Bull" : "Bear"} FVG`,
  };
  const target = bullish
    ? (f.resistance > f.anchor_price ? f.resistance : f.upside_trigger > f.anchor_price ? f.upside_trigger : null)
    : bearish
      ? (f.support < f.anchor_price ? f.support : f.downside_trigger < f.anchor_price && price(f.downside_trigger) ? f.downside_trigger : null)
      : null;
  // Open gaps in the direction of travel can be *watch destinations*.
  // Do not modify the volatility-derived projected path to force a fill.
  const destination = !f.stale ? gaps.find((g) => validGap(g) && (
    bullish ? g.remaining_low > f.anchor_price && g.remaining_low < f.anchor_price * 1.04
            : bearish ? g.remaining_high < f.anchor_price && g.remaining_high > f.anchor_price * .96
                      : false
  )) : undefined;
  const gapTarget = destination ? (bullish ? destination.remaining_low : destination.remaining_high) : null;
  const displayTarget = gapTarget ?? target;
  const targetLabel = destination ? `${destination.timeframe} FVG watch` : "Target";
  const invalidation = bullish
    ? (price(f.downside_trigger) && f.downside_trigger < f.anchor_price ? f.downside_trigger : null)
    : bearish
      ? (price(f.upside_trigger) && f.upside_trigger > f.anchor_price ? f.upside_trigger : null)
      : null;

  // At most one confirmed candle highlight on the selected timeframe.
  const oneMarker = [...marks].reverse().find((m) => m?.source === "closed_bars" && m.kind === "marker" &&
    m.timeframe === tf && m.tone === "confirmed" && Number.isSafeInteger(m.time_ms) && price(m.price));
  return {
    timeframe: tf, bias: f.bias, stale: Boolean(f.stale),
    anchorTimeMs: f.anchor_time_ms, anchorPrice: f.anchor_price, path,
    reaction, target: displayTarget, targetLabel, invalidation,
    marker: oneMarker && oneMarker.time_ms && oneMarker.price
      ? { time_ms: oneMarker.time_ms, price: oneMarker.price } : null,
  };
}
