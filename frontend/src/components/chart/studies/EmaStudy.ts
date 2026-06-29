import type { LineData, Time } from "lightweight-charts";
import type { CleanBar } from "../chart/ChartTypes";

export function buildEmaBars(
  bars: CleanBar[],
  period: number
): LineData<Time>[] {
  if (!bars.length || period <= 0) return [];

  const multiplier = 2 / (period + 1);
  const emaBars: LineData<Time>[] = [];

  let ema = bars[0].close;

  for (const bar of bars) {
    ema = bar.close * multiplier + ema * (1 - multiplier);

    emaBars.push({
      time: bar.time,
      value: ema,
    });
  }

  return emaBars;
}


export function getCurrentEMA(
  bars: CleanBar[],
  period: number,
): number | undefined {
  const emaBars = buildEmaBars(bars, period);
  return emaBars.length ? Number(emaBars[emaBars.length - 1].value) : undefined;
}
