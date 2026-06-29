export interface EMAStudyResult {
  ema9?: number;
  ema20?: number;
  ema50?: number;

  ema9Above20?: boolean;
  priceAboveEma20?: boolean;
}

export interface VWAPStudyResult {
  value?: number;
  slope?: number;

  priceAboveVwap?: boolean;
  rising?: boolean;
}

export interface ATRStudyResult {
  value?: number;
  expanding?: boolean;

  expansionCount?: number;
}

export interface StudyResults {
  ema: EMAStudyResult;
  vwap: VWAPStudyResult;
  atr: ATRStudyResult;
}