import type { CleanBar } from "./ChartTypes";

export type ChartAutoScaleMode = "price" | "analysis" | "everything";

type PriceRange = {
  minValue: number;
  maxValue: number;
};

type BuildPriceScaleRangeInput = {
  baseRange: PriceRange | null;
  bars: CleanBar[];
  analysisRange?: PriceRange | null;
  mode?: ChartAutoScaleMode;
};

function finitePrice(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function buildRangeFromBars(bars: CleanBar[]): PriceRange | null {
  let minValue = Number.POSITIVE_INFINITY;
  let maxValue = Number.NEGATIVE_INFINITY;

  for (const bar of bars) {
    const high = finitePrice(bar.high);
    const low = finitePrice(bar.low);

    if (high == null || low == null) {
      continue;
    }

    minValue = Math.min(minValue, low);
    maxValue = Math.max(maxValue, high);
  }

  if (
    !Number.isFinite(minValue) ||
    !Number.isFinite(maxValue) ||
    minValue >= maxValue
  ) {
    return null;
  }

  return {
    minValue,
    maxValue,
  };
}

function padRange(range: PriceRange): PriceRange {
  const minValue = finitePrice(range.minValue);
  const maxValue = finitePrice(range.maxValue);

  if (minValue == null || maxValue == null) {
    return range;
  }

  if (minValue === maxValue) {
    const padding = Math.max(Math.abs(minValue) * 0.03, 0.01);

    return {
      minValue: minValue - padding,
      maxValue: maxValue + padding,
    };
  }

  const span = maxValue - minValue;
  const padding = Math.max(span * 0.08, Math.abs(maxValue) * 0.002, 0.01);

  return {
    minValue: minValue - padding,
    maxValue: maxValue + padding,
  };
}

function mergeRanges(
  first: PriceRange | null,
  second: PriceRange | null | undefined,
): PriceRange | null {
  if (!first) return second ?? null;
  if (!second) return first;

  return {
    minValue: Math.min(first.minValue, second.minValue),
    maxValue: Math.max(first.maxValue, second.maxValue),
  };
}

export class ChartAutoScaleManager {
  private mode: ChartAutoScaleMode = "price";
  private focusedPriceRange: PriceRange | null = null;
  private verticalPanRatio = 0;

  setMode(mode: ChartAutoScaleMode): void {
    this.mode = mode;
  }

  getMode(): ChartAutoScaleMode {
    return this.mode;
  }

  setFocusedPriceRange(range: PriceRange | null): void {
    const minValue = finitePrice(range?.minValue);
    const maxValue = finitePrice(range?.maxValue);

    if (minValue == null || maxValue == null || minValue >= maxValue) {
      this.focusedPriceRange = null;
      return;
    }

    this.focusedPriceRange = {
      minValue,
      maxValue,
    };
  }

  setFocusedBars(bars: CleanBar[]): boolean {
    const range = buildRangeFromBars(bars);

    if (!range) {
      this.focusedPriceRange = null;
      return false;
    }

    this.focusedPriceRange = range;
    return true;
  }

  clearFocusedPriceRange(): void {
    this.focusedPriceRange = null;
  }

  hasFocusedPriceRange(): boolean {
    return this.focusedPriceRange != null;
  }

  panVertically(deltaY: number, chartHeight: number): boolean {
    if (
      !Number.isFinite(deltaY) ||
      !Number.isFinite(chartHeight) ||
      chartHeight <= 0 ||
      deltaY === 0
    ) {
      return false;
    }

    // Only about two thirds of the chart height is used by the candle price
    // scale because the remaining space is reserved by the scale margins.
    const usableHeight = Math.max(1, chartHeight * 0.67);
    const nextRatio = this.verticalPanRatio + deltaY / usableHeight;
    this.verticalPanRatio = Math.max(-3, Math.min(3, nextRatio));
    return true;
  }

  clearVerticalPan(): void {
    this.verticalPanRatio = 0;
  }

  private applyVerticalPan(range: PriceRange): PriceRange {
    const paddedRange = padRange(range);

    if (this.verticalPanRatio === 0) {
      return paddedRange;
    }

    const span = paddedRange.maxValue - paddedRange.minValue;
    const offset = span * this.verticalPanRatio;

    return {
      minValue: paddedRange.minValue + offset,
      maxValue: paddedRange.maxValue + offset,
    };
  }

  buildPriceScaleRange(input: BuildPriceScaleRangeInput): PriceRange | null {
    if (this.focusedPriceRange) {
      const focusedRange = mergeRanges(
        this.focusedPriceRange,
        input.analysisRange,
      );
      return focusedRange ? this.applyVerticalPan(focusedRange) : null;
    }

    const mode = input.mode ?? this.mode;

    if (mode !== "price") {
      const mergedRange = mergeRanges(input.baseRange, input.analysisRange);
      return mergedRange ? this.applyVerticalPan(mergedRange) : null;
    }

    const recentBars = input.bars.slice(-650);
    const recentRange = buildRangeFromBars(recentBars);

    if (!recentRange) {
      const mergedRange = mergeRanges(input.baseRange, input.analysisRange);
      return mergedRange ? this.applyVerticalPan(mergedRange) : null;
    }

    const mergedRange = mergeRanges(recentRange, input.analysisRange);
    return mergedRange ? this.applyVerticalPan(mergedRange) : null;
  }
}
