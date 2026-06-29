export type SnapshotTrend = "bullish" | "bearish" | "neutral";

export interface EMASnapshot {
  ema9?: number;
  ema20?: number;
  ema50?: number;
}

export interface VWAPSnapshot {
  value?: number;
  slope?: number;
}

export interface ATRSnapshot {
  value?: number;
  expanding?: boolean;
}

export interface VolumeSnapshot {
  current?: number;
  average?: number;
  relative?: number;
}

export interface StructureSnapshot {
  trend?: SnapshotTrend;

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
}

export interface CompressionSnapshot {
  score?: number;
  breaking?: boolean;
}

export interface MomentumSnapshot {
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
}

export interface StudySnapshot {
  symbol?: string;
  timeframe?: string;
  price?: number;

  ema: EMASnapshot;
  vwap: VWAPSnapshot;
  atr: ATRSnapshot;
  volume: VolumeSnapshot;
  structure: StructureSnapshot;
  compression: CompressionSnapshot;
  momentum: MomentumSnapshot;
}
