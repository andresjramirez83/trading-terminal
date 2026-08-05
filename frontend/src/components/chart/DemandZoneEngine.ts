// src/components/chart/DemandZoneEngine.ts

import type { Time, UTCTimestamp } from "lightweight-charts";
import type { CleanBar, DemandZone } from "./ChartTypes";
import {
  buildMarketStructure,
  type MarketStructurePoint,
  type MarketStructureResult,
} from "./analysis/MarketStructureEngine";

export type AutomaticDemandZoneSetup = "continuation" | "reversal";
export type AutomaticDemandZoneStatus =
  | "fresh"
  | "touched"
  | "partially-mitigated"
  | "invalidated";

/**
 * A demand zone confirmed by structure and imbalance, not a manually drawn
 * rectangle. The full pre-FVG candle range, including both wicks, is used.
 */
export interface AutomaticDemandZone {
  id: string;
  originIndex: number;
  originTime: Time;
  confirmationIndex: number;
  confirmationTime: Time;
  higherHighIndex: number;
  higherHighTime: Time;
  higherHighPrice: number;
  fvgIndex: number;
  fvgTime: Time;
  bottom: number;
  top: number;
  previousHigh: number;
  previousHigherLow?: number;
  setup: AutomaticDemandZoneSetup;
  status: AutomaticDemandZoneStatus;
  active: boolean;
  touchCount: number;
  mitigationPercent: number;
  invalidationIndex?: number;
  invalidationTime?: Time;
}

export interface AutomaticDemandZoneOptions {
  /**
   * @deprecated Demand is now always anchored to the exact candle immediately
   * before the FVG displacement candle.
   */
  maxOriginLookback?: number;
  /** @deprecated The full confirmed HH leg is now searched for its FVG. */
  maxFvgBarsAfterBreak?: number;
  /**
   * @deprecated The pre-FVG candle no longer needs to be bearish or indecision.
   */
  indecisionBodyPercent?: number;
  /** Keep reversal demand zones whose origin formed below the prior HL. */
  includeReversalZones?: boolean;
  maxZones?: number;
  structure?: MarketStructureResult;
}

export interface DemandZoneOptions {
  extendBars?: number;
  bodyOnly?: boolean;
  symbol?: string;
  timeframe?: string;
}

const STORAGE_PREFIX = "chart.demandZones.v1";

function bodyHigh(bar: CleanBar): number {
  return Math.max(bar.open, bar.close);
}

function isFiniteBar(bar: CleanBar | undefined): bar is CleanBar {
  return Boolean(
    bar &&
      Number.isFinite(bar.open) &&
      Number.isFinite(bar.high) &&
      Number.isFinite(bar.low) &&
      Number.isFinite(bar.close),
  );
}

/**
 * Three-candle bullish FVG:
 *
 * first candle         = index - 2
 * displacement candle  = index - 1
 * confirming candle    = index
 *
 * The gap exists when the confirming candle's low is above the first candle's
 * high. The demand-zone anchor is the first candle: the exact candle directly
 * before the displacement/imbalance begins.
 */
function isBullishFvg(bars: CleanBar[], index: number): boolean {
  if (index < 2 || index >= bars.length) return false;

  const first = bars[index - 2];
  const displacement = bars[index - 1];
  const confirming = bars[index];

  /**
   * A bullish FVG is defined by the price gap itself. The HH leg already
   * validates bullish direction, so the middle candle does not also need to
   * close green. Requiring a green middle candle caused valid HH-leg
   * imbalances to be missed.
   */
  return (
    isFiniteBar(first) &&
    isFiniteBar(displacement) &&
    isFiniteBar(confirming) &&
    confirming.low > first.high
  );
}

/**
 * Returns the exact candle immediately before the FVG displacement candle.
 *
 * Do not walk backward looking for a bearish or indecision candle. A bullish
 * pre-FVG candle is still the correct demand-zone anchor under the approved
 * rule.
 */
function getPreFvgCandleIndex(
  bars: CleanBar[],
  fvgIndex: number,
  minimumIndex: number,
): number | null {
  const originIndex = fvgIndex - 2;

  if (originIndex < minimumIndex || originIndex < 0) return null;
  return isFiniteBar(bars[originIndex]) ? originIndex : null;
}

function latestPointBefore(
  points: MarketStructurePoint[],
  confirmationIndex: number,
  types: MarketStructurePoint["type"][],
): MarketStructurePoint | undefined {
  return points
    .filter(
      (point) =>
        point.confirmationIndex < confirmationIndex &&
        point.index < confirmationIndex &&
        types.includes(point.type),
    )
    .sort((a, b) => {
      if (a.confirmationIndex !== b.confirmationIndex) {
        return b.confirmationIndex - a.confirmationIndex;
      }

      return b.index - a.index;
    })[0];
}

function getConfirmedBullishLegs(
  structure: MarketStructureResult,
): MarketStructurePoint[] {
  /**
   * Demand zones are created only from true bullish BOS legs.
   *
   * A transition/CHoCH HH is useful as the new reference high, but it did not
   * take out a previous bullish HH and therefore cannot validate demand.
   * Requiring a matching HL with the same confirmationIndex also guarantees
   * that the engine has a real base for the leg.
   */
  return structure.points
    .filter((point) => {
      if (point.type !== "HH" || point.breakType !== "bos") {
        return false;
      }

      return structure.points.some(
        (candidate) =>
          candidate.type === "HL" &&
          candidate.breakType === "bos" &&
          candidate.confirmationIndex === point.confirmationIndex &&
          candidate.index < point.confirmationIndex,
      );
    })
    .slice()
    .sort((a, b) => {
      if (a.confirmationIndex !== b.confirmationIndex) {
        return a.confirmationIndex - b.confirmationIndex;
      }

      return a.index - b.index;
    });
}

function evaluateLifecycle(
  bars: CleanBar[],
  zone: AutomaticDemandZone,
): AutomaticDemandZone {
  let status: AutomaticDemandZoneStatus = "fresh";
  let touchCount = 0;
  let mitigationPercent = 0;
  let wasInside = false;
  const height = Math.max(zone.top - zone.bottom, 0.0000001);
  const startIndex =
    Math.max(
      zone.confirmationIndex,
      zone.higherHighIndex,
      zone.fvgIndex,
    ) + 1;

  for (let index = startIndex; index < bars.length; index += 1) {
    const bar = bars[index];
    if (!isFiniteBar(bar)) continue;

    if (bar.close < zone.bottom) {
      return {
        ...zone,
        status: "invalidated",
        active: false,
        touchCount,
        mitigationPercent: 100,
        invalidationIndex: index,
        invalidationTime: bar.time,
      };
    }

    const inside = bar.low <= zone.top && bar.high >= zone.bottom;
    if (inside && !wasInside) touchCount += 1;

    if (inside) {
      const depth = Math.max(
        0,
        Math.min(1, (zone.top - bar.low) / height),
      );
      mitigationPercent = Math.max(mitigationPercent, depth * 100);
      status =
        mitigationPercent > 5 ? "partially-mitigated" : "touched";
    }

    wasInside = inside;
  }

  return {
    ...zone,
    status,
    active: true,
    touchCount,
    mitigationPercent: Math.round(mitigationPercent),
  };
}

/**
 * Detects automatic bullish demand zones using the approved rules:
 *
 * 1. Only a confirmed bullish BOS containing a matched HH/HL pair qualifies.
 * 2. The breakout candle must take out the previous HH wick and close above
 *    the top of the previous HH candle's body.
 * 3. CHoCH/transition highs never create demand zones.
 * 4. The FVG must form from the matching HL base through the breakout candle;
 *    later FVGs near the top of the completed leg are ignored.
 * 5. The first bullish FVG from that HL base is selected.
 * 6. The demand-zone anchor is the exact candle immediately before the FVG
 *    displacement candle, using its full wick range.
 * 7. An origin fully above the prior HL is continuation; otherwise reversal.
 * 8. The zone is invalid only when a candle closes below its low.
 * 9. ATR is deliberately not used.
 */
export function buildAutomaticDemandZones(
  bars: CleanBar[],
  options: AutomaticDemandZoneOptions = {},
): AutomaticDemandZone[] {
  if (bars.length < 8 || bars.some((bar) => !isFiniteBar(bar))) {
    return [];
  }

  const includeReversalZones = options.includeReversalZones ?? true;
  const maxZones = Math.max(1, options.maxZones ?? 24);
  const structure = options.structure ?? buildMarketStructure(bars);
  const bullishLegs = getConfirmedBullishLegs(structure);
  const zones: AutomaticDemandZone[] = [];

  for (const higherHighPoint of bullishLegs) {
    const confirmationIndex = higherHighPoint.confirmationIndex;
    const confirmationBar = bars[confirmationIndex];
    const higherHighBar = bars[higherHighPoint.index];

    if (
      !isFiniteBar(confirmationBar) ||
      !isFiniteBar(higherHighBar)
    ) {
      continue;
    }

    /**
     * The HH and HL must belong to the same confirmed bullish BOS. Without the
     * matched HL, there is no reliable base for a demand-zone leg.
     */
    const sameLegHigherLow = structure.points.find(
      (point) =>
        point.type === "HL" &&
        point.breakType === "bos" &&
        point.confirmationIndex === confirmationIndex &&
        point.index < confirmationIndex,
    );

    if (!sameLegHigherLow) continue;

    /**
     * Use only the actual previous confirmed HH. No generic pivot or LH may
     * substitute for it.
     */
    const previousHighPoint = latestPointBefore(
      structure.points,
      confirmationIndex,
      ["HH"],
    );

    if (
      !previousHighPoint ||
      previousHighPoint.index >= sameLegHigherLow.index
    ) {
      continue;
    }

    const previousHighBar = bars[previousHighPoint.index];
    if (!isFiniteBar(previousHighBar)) continue;

    const previousHighBodyTop = bodyHigh(previousHighBar);
    const previousHighWick = previousHighPoint.price;

    /**
     * Exact approved validation:
     * - the breakout candle must trade above the previous HH wick;
     * - it must close above the top of the previous HH candle's body.
     *
     * The close may remain below the previous HH wick.
     */
    const tookOutPreviousHigh =
      confirmationBar.high > previousHighWick;
    const closedAbovePreviousBody =
      confirmationBar.close > previousHighBodyTop;

    if (!tookOutPreviousHigh || !closedAbovePreviousBody) {
      continue;
    }

    /**
     * The matching HL is the exact leg base. Do not move the start forward
     * using a prior confirmation index, because delayed HH finalization can
     * otherwise skip the true base and select an FVG near the top.
     */
    const legStart = sameLegHigherLow.index;

    /**
     * The FVG must participate in the impulse that actually broke the previous
     * HH. FVGs forming after the breakout candle belong to later price action
     * and must not create a zone for this leg.
     */
    const fvgSearchEnd = confirmationIndex;

    let selectedFvgIndex: number | null = null;
    let selectedOriginIndex: number | null = null;

    /**
     * Search forward from the leg base and select the FIRST bullish FVG.
     * This keeps the demand zone at the base of the move instead of selecting
     * a later imbalance near the HH.
     */
    for (
      let fvgIndex = Math.max(2, legStart + 2);
      fvgIndex <= fvgSearchEnd;
      fvgIndex += 1
    ) {
      if (!isBullishFvg(bars, fvgIndex)) continue;

      const originIndex = getPreFvgCandleIndex(
        bars,
        fvgIndex,
        legStart,
      );

      if (originIndex == null) continue;

      selectedFvgIndex = fvgIndex;
      selectedOriginIndex = originIndex;
      break;
    }

    if (
      selectedFvgIndex == null ||
      selectedOriginIndex == null
    ) {
      continue;
    }

    const origin = bars[selectedOriginIndex];
    const previousHigherLow = latestPointBefore(
      structure.points,
      confirmationIndex,
      ["HL"],
    );

    const setup: AutomaticDemandZoneSetup =
      previousHigherLow && origin.low > previousHigherLow.price
        ? "continuation"
        : "reversal";

    if (setup === "reversal" && !includeReversalZones) continue;

    const baseZone: AutomaticDemandZone = {
      id: [
        "auto-demand",
        String(origin.time),
        String(confirmationBar.time),
      ].join("-"),
      originIndex: selectedOriginIndex,
      originTime: origin.time,
      confirmationIndex,
      confirmationTime: confirmationBar.time,
      higherHighIndex: higherHighPoint.index,
      higherHighTime: higherHighBar.time,
      higherHighPrice: higherHighPoint.price,
      fvgIndex: selectedFvgIndex,
      fvgTime: bars[selectedFvgIndex].time,
      bottom: origin.low,
      top: origin.high,
      previousHigh: previousHighBodyTop,
      previousHigherLow: previousHigherLow?.price,
      setup,
      status: "fresh",
      active: true,
      touchCount: 0,
      mitigationPercent: 0,
    };

    zones.push(evaluateLifecycle(bars, baseZone));
  }

  return zones.slice(-maxZones);
}

function normalizeSymbol(symbol?: string): string {
  return String(symbol || "SPY")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_.-]/g, "_");
}

function normalizeTimeframe(timeframe?: string): string {
  return String(timeframe || "5m")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "_");
}

function makeStorageKey(
  symbol?: string,
  timeframe?: string,
): string {
  return `${STORAGE_PREFIX}.${normalizeSymbol(
    symbol,
  )}.${normalizeTimeframe(timeframe)}`;
}

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== "undefined" && !!window.localStorage;
  } catch {
    return false;
  }
}

function cloneZone(zone: DemandZone): DemandZone {
  return JSON.parse(JSON.stringify(zone)) as DemandZone;
}

/**
 * Existing manual-zone storage API. Automatic detection is exposed through
 * detect() and buildAutomaticDemandZones() so manual drawings remain separate.
 */
export class DemandZoneEngine {
  private zones = new Map<string, DemandZone>();
  private extendBars: number;
  private bodyOnly: boolean;
  private symbol: string;
  private timeframe: string;
  private storageKey: string;

  constructor(options?: DemandZoneOptions) {
    this.extendBars = options?.extendBars ?? 500;
    this.bodyOnly = options?.bodyOnly ?? false;
    this.symbol = normalizeSymbol(options?.symbol);
    this.timeframe = normalizeTimeframe(options?.timeframe);
    this.storageKey = makeStorageKey(
      this.symbol,
      this.timeframe,
    );
    this.load();
  }

  detect(
    bars: CleanBar[],
    options: AutomaticDemandZoneOptions = {},
  ): AutomaticDemandZone[] {
    return buildAutomaticDemandZones(bars, options);
  }

  setWorkspace(symbol: string, timeframe: string): void {
    this.symbol = normalizeSymbol(symbol);
    this.timeframe = normalizeTimeframe(timeframe);
    this.storageKey = makeStorageKey(
      this.symbol,
      this.timeframe,
    );
    this.load();
  }

  getAll(): DemandZone[] {
    return [...this.zones.values()].map(cloneZone);
  }

  clear(): void {
    this.zones.clear();
    this.save();
  }

  remove(id: string): void {
    this.zones.delete(id);
    this.save();
  }

  createFromCandle(candle: CleanBar): DemandZone {
    const top = this.bodyOnly
      ? Math.max(candle.open, candle.close)
      : candle.high;
    const bottom = this.bodyOnly
      ? Math.min(candle.open, candle.close)
      : candle.low;

    const zone: DemandZone = {
      id: crypto.randomUUID(),
      candleTime: candle.time as UTCTimestamp,
      startTime: candle.time as UTCTimestamp,
      endTime: (Number(candle.time) +
        this.extendBars) as UTCTimestamp,
      top,
      bottom,
      color: "#00ff00",
      fill: "rgba(0,255,0,.18)",
      visible: true,
    };

    this.zones.set(zone.id, zone);
    this.save();
    return cloneZone(zone);
  }

  update(id: string, top: number, bottom: number): void {
    const zone = this.zones.get(id);
    if (!zone) return;

    zone.top = top;
    zone.bottom = bottom;
    this.save();
  }

  setVisible(id: string, visible: boolean): void {
    const zone = this.zones.get(id);
    if (!zone) return;

    zone.visible = visible;
    this.save();
  }

  setColor(id: string, border: string, fill: string): void {
    const zone = this.zones.get(id);
    if (!zone) return;

    zone.color = border;
    zone.fill = fill;
    this.save();
  }

  extend(id: string, bars: number): void {
    const zone = this.zones.get(id);
    if (!zone) return;

    zone.endTime = (Number(zone.startTime) + bars) as UTCTimestamp;
    this.save();
  }

  findAtPrice(price: number): DemandZone | null {
    for (const zone of this.zones.values()) {
      if (price >= zone.bottom && price <= zone.top) {
        return cloneZone(zone);
      }
    }

    return null;
  }

  invalidateBrokenZones(currentPrice: number): void {
    let changed = false;

    for (const zone of this.zones.values()) {
      if (currentPrice < zone.bottom && zone.visible) {
        zone.visible = false;
        changed = true;
      }
    }

    if (changed) this.save();
  }

  serialize(): string {
    return JSON.stringify([...this.zones.values()]);
  }

  deserialize(json: string): void {
    this.zones.clear();

    try {
      const zones = JSON.parse(json) as DemandZone[];

      for (const zone of zones) {
        if (zone?.id) {
          this.zones.set(zone.id, cloneZone(zone));
        }
      }

      this.save();
    } catch {
      this.zones.clear();
      this.save();
    }
  }

  private load(): void {
    this.zones.clear();
    if (!canUseLocalStorage()) return;

    const saved = window.localStorage.getItem(this.storageKey);
    if (!saved) return;

    try {
      const zones = JSON.parse(saved) as DemandZone[];
      if (!Array.isArray(zones)) return;

      for (const zone of zones) {
        if (zone?.id) {
          this.zones.set(zone.id, cloneZone(zone));
        }
      }
    } catch (error) {
      console.warn(
        "[DemandZoneEngine] failed to load zones",
        error,
      );
    }
  }

  private save(): void {
    if (!canUseLocalStorage()) return;

    try {
      window.localStorage.setItem(
        this.storageKey,
        this.serialize(),
      );
    } catch (error) {
      console.warn(
        "[DemandZoneEngine] failed to save zones",
        error,
      );
    }
  }
}
