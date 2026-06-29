// src/components/chart/studies/VWAPStudy.ts

import type { LineData, Time } from "lightweight-charts";
import type { CleanBar } from "../ChartTypes";
import type { StudyLineSeries } from "./StudyTypes";

export function buildVwapBars(bars: CleanBar[]): LineData<Time>[] {
  let cumulativePV = 0;
  let cumulativeVolume = 0;

  const vwapBars: LineData<Time>[] = [];

  for (const bar of bars) {
    const volume = Number(bar.volume ?? 0);
    if (!Number.isFinite(volume) || volume <= 0) continue;

    const typicalPrice = (bar.high + bar.low + bar.close) / 3;

    cumulativePV += typicalPrice * volume;
    cumulativeVolume += volume;

    if (cumulativeVolume <= 0) continue;

    vwapBars.push({
      time: bar.time,
      value: cumulativePV / cumulativeVolume,
    });
  }

  return vwapBars;
}

export function renderVWAP(params: {
  bars: CleanBar[];
  series?: StudyLineSeries;
}): void {
  if (!params.series) return;
  params.series.setData(buildVwapBars(params.bars));
}


export function getCurrentVWAP(
  bars: CleanBar[],
): number | undefined {
  const vwapBars = buildVwapBars(bars);
  return vwapBars.length ? Number(vwapBars[vwapBars.length - 1].value) : undefined;
}
