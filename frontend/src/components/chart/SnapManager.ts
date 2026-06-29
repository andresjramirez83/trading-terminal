// src/chart/SnapManager.ts

import type { CleanBar } from "./ChartTypes";

export type SnapTargetKind = "high" | "low" | "open" | "close";

export type SmartSnapInput = {
  bar: CleanBar | null;
  mousePrice: number;
  mouseY: number;
  tolerancePx?: number;
  priceToCoordinate: (price: number) => number | null;
};

export type SmartSnapResult = {
  price: number;
  snapped: boolean;
  target?: SnapTargetKind;
};

const DEFAULT_TOLERANCE_PX = 18;

function validNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function getSmartSnapPrice({
  bar,
  mousePrice,
  mouseY,
  tolerancePx = DEFAULT_TOLERANCE_PX,
  priceToCoordinate,
}: SmartSnapInput): SmartSnapResult {
  if (!bar || !validNumber(mousePrice)) {
    return { price: mousePrice, snapped: false };
  }

  const targets: {
    kind: SnapTargetKind;
    price: number;
    group: "wick" | "body";
    weight: number;
  }[] = [
    // Trendline-style magnetic snap should favor wicks.
    // This makes support/resistance lines feel closer to TradingView.
    { kind: "high", price: bar.high, group: "wick", weight: 0.72 },
    { kind: "low", price: bar.low, group: "wick", weight: 0.72 },

    // Body prices are still available, but they should not steal the snap
    // from a nearby wick unless the cursor is clearly on the body.
    { kind: "open", price: bar.open, group: "body", weight: 1.18 },
    { kind: "close", price: bar.close, group: "body", weight: 1.18 },
  ];

  let best: {
    kind: SnapTargetKind;
    price: number;
    distancePx: number;
    score: number;
  } | null = null;

  for (const target of targets) {
    if (!validNumber(target.price)) continue;

    const targetY = priceToCoordinate(target.price);
    if (targetY == null || !Number.isFinite(targetY)) continue;

    const distancePx = Math.abs(targetY - mouseY);

    if (distancePx > tolerancePx) continue;

    const score = distancePx * target.weight;

    if (!best || score < best.score) {
      best = {
        kind: target.kind,
        price: target.price,
        distancePx,
        score,
      };
    }
  }

  if (!best) {
    return { price: mousePrice, snapped: false };
  }

  return {
    price: best.price,
    snapped: true,
    target: best.kind,
  };
}
