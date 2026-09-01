export type RightPanelWorkspace =
  | "chart"
  | "trade"
  | "watchlists"
  | "scanner"
  | "news"
  | "coach"
  | "level2";

export type ReadinessStatus = "bullish" | "neutral" | "bearish";

export interface TradeReadinessItem {
  label: string;
  status: ReadinessStatus;
}

export interface TradeReadinessData {
  score: number;
  items: TradeReadinessItem[];
}
