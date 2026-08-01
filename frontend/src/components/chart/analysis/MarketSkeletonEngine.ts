import {
  DefaultSkeletonSettings,
  MarketSkeleton,
  SkeletonDirection,
  SkeletonLeg,
  SkeletonPoint,
  SkeletonSettings,
} from "./MarketSkeletonTypes";

export interface SkeletonCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface Extremum {
  index: number;
  time: number;
  price: number;
}

interface EngineState {
  direction: SkeletonDirection;
  anchor: Extremum;
  candidate: Extremum;
  lastConfirmed: SkeletonPoint;
}

const EPSILON = 1e-9;

export class MarketSkeletonEngine {
  private readonly settings: SkeletonSettings;

  constructor(settings?: Partial<SkeletonSettings>) {
    this.settings = {
      ...DefaultSkeletonSettings,
      ...settings,
    };
  }

  public build(candles: SkeletonCandle[]): MarketSkeleton {
    if (!Array.isArray(candles) || candles.length < 2) {
      return { points: [], legs: [] };
    }

    const normalized = this.normalizeCandles(candles);
    if (normalized.length < 2) {
      return { points: [], legs: [] };
    }

    const atr = this.calculateAtr(normalized);
    const averageVolume = this.calculateAverageVolume(normalized);
    const initialState = this.createInitialState(normalized, atr, averageVolume);

    if (!initialState) {
      return { points: [], legs: [] };
    }

    const points: SkeletonPoint[] = [initialState.lastConfirmed];
    const legs: SkeletonLeg[] = [];
    let state = initialState;

    for (let index = state.candidate.index + 1; index < normalized.length; index += 1) {
      state = this.processBar(
        normalized,
        atr,
        averageVolume,
        index,
        state,
        points,
        legs,
      );
    }

    const activePoint = this.createActivePoint(
      normalized,
      atr,
      averageVolume,
      state,
    );

    if (
      activePoint &&
      activePoint.index !== state.lastConfirmed.index &&
      activePoint.type !== state.lastConfirmed.type
    ) {
      points.push(activePoint);
      legs.push(this.createLeg(state.lastConfirmed, activePoint, atr, normalized));
    }

    return {
      points: this.removeDuplicatePoints(points),
      legs: this.removeDuplicateLegs(legs),
    };
  }

  public getSettings(): SkeletonSettings {
    return { ...this.settings };
  }

  private processBar(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    index: number,
    state: EngineState,
    points: SkeletonPoint[],
    legs: SkeletonLeg[],
  ): EngineState {
    const candle = candles[index];

    if (state.direction === "up") {
      const candidate =
        candle.high >= state.candidate.price
          ? { index, time: candle.time, price: candle.high }
          : state.candidate;

      const nextState: EngineState = { ...state, candidate };

      if (this.shouldConfirmHigh(candles, atr, averageVolume, index, nextState)) {
        return this.confirmHigh(
          candles,
          atr,
          averageVolume,
          index,
          nextState,
          points,
          legs,
        );
      }

      return nextState;
    }

    const candidate =
      candle.low <= state.candidate.price
        ? { index, time: candle.time, price: candle.low }
        : state.candidate;

    const nextState: EngineState = { ...state, candidate };

    if (this.shouldConfirmLow(candles, atr, averageVolume, index, nextState)) {
      return this.confirmLow(
        candles,
        atr,
        averageVolume,
        index,
        nextState,
        points,
        legs,
      );
    }

    return nextState;
  }

  private shouldConfirmHigh(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    index: number,
    state: EngineState,
  ): boolean {
    const reversalDistance = state.candidate.price - candles[index].low;
    if (reversalDistance <= EPSILON) return false;

    const barsFromAnchor = state.candidate.index - state.anchor.index;
    const barsFromExtreme = index - state.candidate.index;

    if (barsFromAnchor < this.settings.minimumBarsPerLeg) return false;
    if (barsFromExtreme < Math.max(1, this.settings.smoothing)) return false;

    const threshold = this.getAdaptiveReversalThreshold(
      candles,
      atr,
      averageVolume,
      index,
      state.candidate.price,
    );

    return reversalDistance >= threshold;
  }

  private shouldConfirmLow(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    index: number,
    state: EngineState,
  ): boolean {
    const reversalDistance = candles[index].high - state.candidate.price;
    if (reversalDistance <= EPSILON) return false;

    const barsFromAnchor = state.candidate.index - state.anchor.index;
    const barsFromExtreme = index - state.candidate.index;

    if (barsFromAnchor < this.settings.minimumBarsPerLeg) return false;
    if (barsFromExtreme < Math.max(1, this.settings.smoothing)) return false;

    const threshold = this.getAdaptiveReversalThreshold(
      candles,
      atr,
      averageVolume,
      index,
      state.candidate.price,
    );

    return reversalDistance >= threshold;
  }

  private confirmHigh(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    index: number,
    state: EngineState,
    points: SkeletonPoint[],
    legs: SkeletonLeg[],
  ): EngineState {
    const point = this.createConfirmedPoint(
      candles,
      atr,
      averageVolume,
      state.lastConfirmed,
      state.candidate,
      "high",
    );

    if (point.index !== state.lastConfirmed.index) {
      points.push(point);
      legs.push(this.createLeg(state.lastConfirmed, point, atr, candles));
    }

    return {
      direction: "down",
      anchor: state.candidate,
      candidate: this.findLowestExtremum(candles, state.candidate.index, index),
      lastConfirmed: point,
    };
  }

  private confirmLow(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    index: number,
    state: EngineState,
    points: SkeletonPoint[],
    legs: SkeletonLeg[],
  ): EngineState {
    const point = this.createConfirmedPoint(
      candles,
      atr,
      averageVolume,
      state.lastConfirmed,
      state.candidate,
      "low",
    );

    if (point.index !== state.lastConfirmed.index) {
      points.push(point);
      legs.push(this.createLeg(state.lastConfirmed, point, atr, candles));
    }

    return {
      direction: "up",
      anchor: state.candidate,
      candidate: this.findHighestExtremum(candles, state.candidate.index, index),
      lastConfirmed: point,
    };
  }

  private createInitialState(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
  ): EngineState | null {
    const searchWindow = Math.min(
      candles.length - 1,
      Math.max(this.settings.minimumBarsPerLeg * 3, this.settings.atrPeriod * 2, 20),
    );

    let highest = this.findHighestExtremum(candles, 0, searchWindow);
    let lowest = this.findLowestExtremum(candles, 0, searchWindow);

    if (highest.index === lowest.index) {
      const first = candles[0];
      const second = candles[1];

      if (second.close >= first.close) {
        lowest = { index: 0, time: first.time, price: first.low };
        highest = { index: 1, time: second.time, price: second.high };
      } else {
        highest = { index: 0, time: first.time, price: first.high };
        lowest = { index: 1, time: second.time, price: second.low };
      }
    }

    if (lowest.index < highest.index) {
      return {
        direction: "up",
        anchor: lowest,
        candidate: highest,
        lastConfirmed: this.createInitialPoint(
          candles,
          averageVolume,
          lowest,
          "low",
        ),
      };
    }

    return {
      direction: "down",
      anchor: highest,
      candidate: lowest,
      lastConfirmed: this.createInitialPoint(
        candles,
        averageVolume,
        highest,
        "high",
      ),
    };
  }

  private createInitialPoint(
    candles: SkeletonCandle[],
    averageVolume: number[],
    extremum: Extremum,
    type: "high" | "low",
  ): SkeletonPoint {
    const volumeRatio = this.getVolumeRatio(candles, averageVolume, extremum.index);

    return {
      id: this.createPointId(extremum.time, extremum.index, type),
      index: extremum.index,
      time: extremum.time,
      price: extremum.price,
      type,
      confirmed: true,
      atrMove: 0,
      percentMove: 0,
      volumeRatio,
      score: this.scoreSwing(0, 0, volumeRatio),
    };
  }

  private createConfirmedPoint(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    previous: SkeletonPoint,
    extremum: Extremum,
    type: "high" | "low",
  ): SkeletonPoint {
    const priceDistance = Math.abs(extremum.price - previous.price);
    const atrValue = this.getAtrAt(atr, extremum.index);
    const atrMove = atrValue > EPSILON ? priceDistance / atrValue : 0;
    const percentMove =
      Math.abs(previous.price) > EPSILON
        ? priceDistance / Math.abs(previous.price)
        : 0;
    const volumeRatio = this.getVolumeRatio(candles, averageVolume, extremum.index);

    return {
      id: this.createPointId(extremum.time, extremum.index, type),
      index: extremum.index,
      time: extremum.time,
      price: extremum.price,
      type,
      confirmed: true,
      atrMove,
      percentMove,
      volumeRatio,
      score: this.scoreSwing(atrMove, percentMove, volumeRatio),
    };
  }

  private createActivePoint(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    state: EngineState,
  ): SkeletonPoint | null {
    if (state.candidate.index <= state.lastConfirmed.index) return null;

    const point = this.createConfirmedPoint(
      candles,
      atr,
      averageVolume,
      state.lastConfirmed,
      state.candidate,
      state.direction === "up" ? "high" : "low",
    );

    return {
      ...point,
      confirmed: false,
    };
  }

  private createLeg(
    start: SkeletonPoint,
    end: SkeletonPoint,
    atr: number[],
    candles: SkeletonCandle[],
  ): SkeletonLeg {
    const priceDistance = Math.abs(end.price - start.price);
    const averageAtr = this.getAverageAtrBetween(atr, start.index, end.index);
    const atrDistance = averageAtr > EPSILON ? priceDistance / averageAtr : 0;
    const percentDistance =
      Math.abs(start.price) > EPSILON
        ? priceDistance / Math.abs(start.price)
        : 0;
    const averageVolumeRatio = this.getAverageVolumeRatioBetween(
      candles,
      start.index,
      end.index,
    );

    return {
      id: `${start.id}__${end.id}`,
      start,
      end,
      direction: end.price >= start.price ? "up" : "down",
      barCount: Math.abs(end.index - start.index),
      priceDistance,
      atrDistance,
      percentDistance,
      score: this.scoreSwing(atrDistance, percentDistance, averageVolumeRatio),
    };
  }

  private getAdaptiveReversalThreshold(
    candles: SkeletonCandle[],
    atr: number[],
    averageVolume: number[],
    index: number,
    referencePrice: number,
  ): number {
    const atrValue = this.getAtrAt(atr, index);
    const percentThreshold =
      Math.abs(referencePrice) * Math.max(0, this.settings.minimumPercentReversal);
    const localVolatilityRatio = this.getLocalVolatilityRatio(atr, index);
    const volumeRatio = this.getVolumeRatio(candles, averageVolume, index);

    const volatilityAdjustment = this.clamp(
      0.85 + localVolatilityRatio * 0.25,
      0.85,
      1.75,
    );

    const volumeAdjustment = this.clamp(
      1.08 - Math.max(0, volumeRatio - 1) * 0.1,
      0.82,
      1.08,
    );

    const atrThreshold =
      atrValue *
      Math.max(0, this.settings.minimumAtrReversal) *
      volatilityAdjustment *
      volumeAdjustment;

    return Math.max(atrThreshold, percentThreshold, EPSILON);
  }

  private scoreSwing(
    atrMove: number,
    percentMove: number,
    volumeRatio: number,
  ): number {
    const atrComponent = this.normalizeScore(
      atrMove,
      Math.max(this.settings.minimumAtrReversal * 2.5, 1),
    );
    const percentComponent = this.normalizeScore(
      percentMove,
      Math.max(this.settings.minimumPercentReversal * 3, 0.01),
    );
    const volumeComponent = this.normalizeScore(volumeRatio, 2);

    const totalWeight =
      this.settings.atrWeight +
      this.settings.distanceWeight +
      this.settings.volumeWeight;

    if (totalWeight <= EPSILON) return 0;

    const rawScore =
      atrComponent * this.settings.atrWeight +
      percentComponent * this.settings.distanceWeight +
      volumeComponent * this.settings.volumeWeight;

    return Math.round(this.clamp(rawScore / totalWeight, 0, 1) * 100);
  }

  private calculateAtr(candles: SkeletonCandle[]): number[] {
    const period = Math.max(1, Math.floor(this.settings.atrPeriod));
    const trueRanges = new Array<number>(candles.length).fill(0);
    const atr = new Array<number>(candles.length).fill(0);

    for (let index = 0; index < candles.length; index += 1) {
      const candle = candles[index];

      if (index === 0) {
        trueRanges[index] = Math.max(candle.high - candle.low, EPSILON);
        atr[index] = trueRanges[index];
        continue;
      }

      const previousClose = candles[index - 1].close;
      trueRanges[index] = Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - previousClose),
        Math.abs(candle.low - previousClose),
        EPSILON,
      );

      if (index < period) {
        let sum = 0;
        for (let cursor = 0; cursor <= index; cursor += 1) {
          sum += trueRanges[cursor];
        }
        atr[index] = sum / (index + 1);
      } else {
        atr[index] =
          (atr[index - 1] * (period - 1) + trueRanges[index]) / period;
      }
    }

    return atr;
  }

  private calculateAverageVolume(candles: SkeletonCandle[]): number[] {
    const period = Math.max(5, Math.floor(this.settings.atrPeriod));
    const result = new Array<number>(candles.length).fill(0);
    let rollingSum = 0;

    for (let index = 0; index < candles.length; index += 1) {
      rollingSum += Math.max(0, candles[index].volume ?? 0);

      if (index >= period) {
        rollingSum -= Math.max(0, candles[index - period].volume ?? 0);
      }

      result[index] = rollingSum / Math.min(index + 1, period);
    }

    return result;
  }

  private getLocalVolatilityRatio(atr: number[], index: number): number {
    const lookback = Math.max(5, Math.floor(this.settings.atrPeriod));
    const start = Math.max(0, index - lookback + 1);
    let sum = 0;
    let count = 0;

    for (let cursor = start; cursor <= index; cursor += 1) {
      sum += this.getAtrAt(atr, cursor);
      count += 1;
    }

    const average = count > 0 ? sum / count : 0;
    const current = this.getAtrAt(atr, index);
    return average > EPSILON ? current / average : 1;
  }

  private getVolumeRatio(
    candles: SkeletonCandle[],
    averageVolume: number[],
    index: number,
  ): number {
    const volume = Math.max(0, candles[index]?.volume ?? 0);
    const average = Math.max(0, averageVolume[index] ?? 0);
    return volume > EPSILON && average > EPSILON ? volume / average : 1;
  }

  private getAverageVolumeRatioBetween(
    candles: SkeletonCandle[],
    startIndex: number,
    endIndex: number,
  ): number {
    const start = Math.max(0, Math.min(startIndex, endIndex));
    const end = Math.min(candles.length - 1, Math.max(startIndex, endIndex));

    let legVolume = 0;
    let legCount = 0;
    for (let index = start; index <= end; index += 1) {
      legVolume += Math.max(0, candles[index].volume ?? 0);
      legCount += 1;
    }

    const baselineStart = Math.max(0, start - Math.max(this.settings.atrPeriod, 5));
    let baselineVolume = 0;
    let baselineCount = 0;

    for (let index = baselineStart; index < start; index += 1) {
      baselineVolume += Math.max(0, candles[index].volume ?? 0);
      baselineCount += 1;
    }

    if (legCount === 0 || baselineCount === 0) return 1;

    const baselineAverage = baselineVolume / baselineCount;
    return baselineAverage > EPSILON
      ? legVolume / legCount / baselineAverage
      : 1;
  }

  private getAverageAtrBetween(
    atr: number[],
    startIndex: number,
    endIndex: number,
  ): number {
    const start = Math.max(0, Math.min(startIndex, endIndex));
    const end = Math.min(atr.length - 1, Math.max(startIndex, endIndex));
    let sum = 0;
    let count = 0;

    for (let index = start; index <= end; index += 1) {
      const value = this.getAtrAt(atr, index);
      if (value > EPSILON) {
        sum += value;
        count += 1;
      }
    }

    return count > 0 ? sum / count : 0;
  }

  private getAtrAt(atr: number[], index: number): number {
    return index >= 0 && index < atr.length && Number.isFinite(atr[index])
      ? atr[index]
      : 0;
  }

  private findHighestExtremum(
    candles: SkeletonCandle[],
    startIndex: number,
    endIndex: number,
  ): Extremum {
    const start = Math.max(0, Math.min(startIndex, endIndex));
    const end = Math.min(candles.length - 1, Math.max(startIndex, endIndex));
    let bestIndex = start;
    let bestPrice = candles[start].high;

    for (let index = start + 1; index <= end; index += 1) {
      if (candles[index].high >= bestPrice) {
        bestPrice = candles[index].high;
        bestIndex = index;
      }
    }

    return { index: bestIndex, time: candles[bestIndex].time, price: bestPrice };
  }

  private findLowestExtremum(
    candles: SkeletonCandle[],
    startIndex: number,
    endIndex: number,
  ): Extremum {
    const start = Math.max(0, Math.min(startIndex, endIndex));
    const end = Math.min(candles.length - 1, Math.max(startIndex, endIndex));
    let bestIndex = start;
    let bestPrice = candles[start].low;

    for (let index = start + 1; index <= end; index += 1) {
      if (candles[index].low <= bestPrice) {
        bestPrice = candles[index].low;
        bestIndex = index;
      }
    }

    return { index: bestIndex, time: candles[bestIndex].time, price: bestPrice };
  }

  private normalizeCandles(candles: SkeletonCandle[]): SkeletonCandle[] {
    return candles
      .filter(
        (candle) =>
          candle != null &&
          Number.isFinite(candle.time) &&
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close),
      )
      .map((candle) => ({
        time: candle.time,
        open: candle.open,
        high: Math.max(candle.high, candle.open, candle.close, candle.low),
        low: Math.min(candle.low, candle.open, candle.close, candle.high),
        close: candle.close,
        volume: Math.max(0, candle.volume ?? 0),
      }))
      .sort((left, right) => left.time - right.time);
  }

  private removeDuplicatePoints(points: SkeletonPoint[]): SkeletonPoint[] {
    const result: SkeletonPoint[] = [];

    for (const point of points) {
      const previous = result[result.length - 1];

      if (!previous) {
        result.push(point);
      } else if (previous.index === point.index) {
        if (point.confirmed || !previous.confirmed) result[result.length - 1] = point;
      } else if (previous.type === point.type) {
        const replacePrevious =
          point.type === "high"
            ? point.price >= previous.price
            : point.price <= previous.price;
        if (replacePrevious) result[result.length - 1] = point;
      } else {
        result.push(point);
      }
    }

    return result;
  }

  private removeDuplicateLegs(legs: SkeletonLeg[]): SkeletonLeg[] {
    const seen = new Set<string>();
    return legs.filter((leg) => {
      if (seen.has(leg.id)) return false;
      seen.add(leg.id);
      return true;
    });
  }

  private createPointId(
    time: number,
    index: number,
    type: "high" | "low",
  ): string {
    return `skeleton-${type}-${time}-${index}`;
  }

  private normalizeScore(value: number, target: number): number {
    if (!Number.isFinite(value) || target <= EPSILON) return 0;
    return this.clamp(value / target, 0, 1);
  }

  private clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value));
  }
}

export default MarketSkeletonEngine;