import type { CleanBar } from "./ChartTypes";

export type ChartAutoScaleMode = "price" | "analysis" | "everything";

type PriceRange = {
  minValue: number;
  maxValue: number;
};

type BuildPriceScaleRangeInput = {
  baseRange: PriceRange | null;
  bars: CleanBar[];
  mode?: ChartAutoScaleMode;
};

function finitePrice(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
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

export class ChartAutoScaleManager {
  private mode: ChartAutoScaleMode = "price";
  private focusedPriceRange: PriceRange | null = null;

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

  clearFocusedPriceRange(): void {
    this.focusedPriceRange = null;
  }

  hasFocusedPriceRange(): boolean {
    return this.focusedPriceRange != null;
  }

  buildPriceScaleRange(input: BuildPriceScaleRangeInput): PriceRange | null {
    if (this.focusedPriceRange) {
      return padRange(this.focusedPriceRange);
    }

    const mode = input.mode ?? this.mode;

    if (mode !== "price") {
      return input.baseRange ? padRange(input.baseRange) : input.baseRange;
    }

    const recentBars = input.bars.slice(-650);
    let minValue = Number.POSITIVE_INFINITY;
    let maxValue = Number.NEGATIVE_INFINITY;

    for (const bar of recentBars) {
      const high = finitePrice(bar.high);
      const low = finitePrice(bar.low);

      if (high == null || low == null) {
        continue;
      }

      minValue = Math.min(minValue, low);
      maxValue = Math.max(maxValue, high);
    }

    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
      return input.baseRange ? padRange(input.baseRange) : input.baseRange;
    }

    return padRange({ minValue, maxValue });
  }
}
