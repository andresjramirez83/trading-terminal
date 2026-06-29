import type { CleanBar } from "./ChartTypes";
import type { StudyResults } from "./studies/StudyResultTypes";

export interface ChartState {
  symbol?: string;
  timeframe?: string;

  bars: CleanBar[];

  lastBar?: CleanBar;
  price?: number;

  studies: StudyResults;

  ema: {
    ema9?: number;
    ema20?: number;
    ema50?: number;
    ema200?: number;
    bullish?: boolean;
  };

  vwap: {
    value?: number;
    above?: boolean;
    slope?: "rising" | "falling" | "flat";
    distance?: number;
    reclaimed?: boolean;
  };

  atr: {
    value?: number;
    expanding?: boolean;
  };

  volume: {
    current?: number;
    average?: number;
    relative?: number;
  };

  structure: {
    trend?: "bullish" | "bearish" | "neutral";

    bos?: boolean;
    choch?: boolean;

    higherHighs?: boolean;
    higherLows?: boolean;

    lowerHighs?: boolean;
    lowerLows?: boolean;

    swingHigh?: number;
    swingLow?: number;

    lastSwingHigh?: number;
    lastSwingLow?: number;

    bullishCount?: number;
    bearishCount?: number;

    strength?: number;
  };

  compression: {
    score?: number;
    breaking?: boolean;
  };
    momentum: {
    score?: number;

    direction?: "bullish" | "bearish" | "neutral";
    status?:
      | "Strong Bullish"
      | "Bullish"
      | "Neutral"
      | "Bearish"
      | "Strong Bearish";

    emaMomentum?: number;
    vwapMomentum?: number;
    candleMomentum?: number;
    volumeMomentum?: number;
    atrMomentum?: number;

    increasing?: boolean;
    fading?: boolean;
  };
}
