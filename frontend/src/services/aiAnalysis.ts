import { API_BASE } from "./api";

export type AIPattern = {
  id: string;
  name: string;
  label: string;
  timeframe: string;
  note: string;
  created_at: string;
};

export type AIEvidence = {
  available?: boolean;
  engulfing_now?: boolean;
  engulfing_recent_5?: boolean;
  potential_low_sweep?: boolean;
  red_body_recovery_pct?: number | null;
  green_to_prev_red_volume?: number | null;
  relative_volume_20?: number;
  close_location?: number;
  upper_wick_fraction?: number;
  strong_bullish_close?: boolean;
};

export type AIMarkup = {
  id: string; kind: "level" | "zone" | "marker" | "projection"; tone: "watch" | "confirmed" | "risk" | "context";
  timeframe: "1m" | "5m" | "all"; label: string; source: "closed_bars";
  price?: number; low?: number; high?: number; time_ms?: number;
  scenario?: "base" | "bull" | "bear"; stale?: boolean;
  points?: { step: number; price: number }[];
};

export type AIScenarioFrame = {
  timeframe: "1m" | "5m";
  anchor_time_ms: number; anchor_price: number; bars_forward: number;
  stale: boolean; age_minutes: number; bias: "bullish" | "bearish" | "range";
  evidence_strength: string; evidence_score: number;
  bull_points: number; bear_points: number; reasons: string[];
  support: number; resistance: number;
  upside_trigger: number; downside_trigger: number;
  bullish_path: { step: number; price: number }[];
  bearish_path: { step: number; price: number }[];
  base_path: { step: number; price: number }[];
};

export type AIProjections = {
  method: string; note: string; probability_calibrated: false;
  timeframes: { "1m"?: AIScenarioFrame; "5m"?: AIScenarioFrame };
};

export type AIFairValueGap = {
  id: string; timeframe: "1m" | "5m" | "15m" | "30m" | "1h";
  direction: "bullish" | "bearish";
  status: "untouched" | "retested" | "partially_filled" | "filled" | "invalidated";
  formed_time_ms: number;
  original_low: number; original_high: number;
  remaining_low: number; remaining_high: number;
  remaining_fraction: number; rejection_count: number;
  distance_atr?: number; rank_points?: number; bars_old: number;
  data_stale?: boolean;
};

export type AIRespectTimeframe = {
  timeframe: string; closed_candles: number;
  positive_reactions: number; broken_zones: number;
  fvg_rejections: number; swing_rejections: number;
  quality: "strong" | "moderate" | "mixed" | "insufficient";
  respect_ratio: number | null; open_fvgs: number;
  age_minutes: number | null; stale: boolean;
  evidence: { time_ms: number; type: string; zone: string; price: number }[];
};

export type AIMultiTimeframe = {
  method: string;
  timeframes: Record<string, AIRespectTimeframe>;
  dominant_timeframe: string | null;
  dominant_reason: string;
  ranked_open_gaps: AIFairValueGap[];
  selected_gap: AIFairValueGap | null;
  feed_errors?: Record<string, string>;
  notes?: string[];
};

export type AILiquiditySweepStage = {
  stage: "liquidity" | "sweep" | "reclaim" | "hold" | "breakout";
  time_ms: number; price: number;
};
export type AILiquiditySweepMatch = {
  reference_name: string; timeframe: string;
  status: "not_found" | "insufficient_data" | "unsupported" | "invalidated" |
          "reclaimed_waiting_retest" | "retest_held" | "continuation_observed";
  matched: boolean; historical_only: boolean;
  zone?: { low: number; high: number; level: number; start_time_ms: number; end_time_ms: number } | null;
  sweep_low?: number | null; stages: AILiquiditySweepStage[];
  reasons: string[]; method: string; last_closed_time_ms?: number | null;
};

export type AIDisplacementFVGSweep = {
  status: "insufficient_data" | "not_found" | "watching_range" | "swept_waiting_reclaim" |
    "reclaimed" | "invalidated" | "target_touched" | "inverted" | "inversion_held" | "inversion_failed";
  matched: boolean; timeframe: "5m"; historical_only: boolean; method: string;
  last_closed_time_ms?: number;
  watch?: { zone: AISweepRange; gap: AISweepGap } | null;
  setup?: { id: string; sweep_time_ms: number; sweep_low: number;
    reclaim_time_ms: number | null; reclaim_quality: string;
    lower_wick_fraction: number; close_location: number;
    invalidation: number; zone: AISweepRange; gap: AISweepGap;
    stage_time_ms: number; target_touched: boolean;
    stages: {stage: "sweep" | "reclaim"; time_ms: number; price: number}[];
  } | null;
};
export type AISweepRange = { low: number; high: number; touches: number; candles: number;
  start_time_ms: number; end_time_ms: number };
export type AISweepGap = { id: string; formed_time_ms: number; low: number; high: number;
  original_low: number; original_high: number; timeframe: "5m"; status_at_sweep: string;
  rally_low: number; rally_high: number };

export type AIReport = {
  symbol: string;
  annotations?: AIMarkup[];
  pattern_match?: AILiquiditySweepMatch;
  displacement_fvg_sweep?: AIDisplacementFVGSweep;
  projections?: AIProjections;
  multi_timeframe?: AIMultiTimeframe;
  as_of?: string;
  phase: string;
  rank_points?: number;
  candle_counts?: Record<string, number>;
  structure?: { available?: boolean; phase?: string; retracement_pct?: number; rally_low?: number; rally_high?: number; pullback_low?: number; reason?: string };
  one_minute?: AIEvidence;
  five_minute?: AIEvidence;
  notes?: string[];
  caveats?: string[];
  data_errors?: string[];
  news?: {
    alerts?: { title: string; severity: string; detail?: string }[];
    headlines?: { headline: string; url?: string; category?: string }[];
    sources?: Record<string, { ok?: boolean; error?: string } | string>;
  };
  level2?: { available?: boolean; reason?: string; spread?: number; top5_imbalance?: number; age_seconds?: number; note?: string; l2_ready?: boolean; tape_5s?: { aggressive_buy_volume_5s?: number; aggressive_sell_volume_5s?: number; trade_pressure_5s?: number; ticker_prints_5s?: number } };
  vision?: { ok: boolean; status?: string; narrative?: string; message?: string; model?: string };
  advisory?: string;
};

let temporaryLocalToken = "";
function isLoopbackBrowser(): boolean {
  return typeof window !== "undefined" && ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
}

// Temporary session-only fallback for an explicitly established localhost SSH tunnel.
// Never store or transmit this token from the public HTTP origin.
export function setTemporaryLocalAIToken(token: string): void {
  if (!isLoopbackBrowser()) throw new Error("Temporary AI token is only allowed on localhost through a secure SSH tunnel.");
  temporaryLocalToken = token.trim();
}
export function clearTemporaryLocalAIToken(): void { temporaryLocalToken = ""; }
export function hasTemporaryLocalAIToken(): boolean { return isLoopbackBrowser() && !!temporaryLocalToken; }

function authHeaders(token: string): Record<string, string> {
  const selected = token.trim() || (isLoopbackBrowser() ? temporaryLocalToken : "");
  return selected ? { "X-AI-Analysis-Token": selected } : {};
}

async function parseResponse<T>(response: Response): Promise<T> {
  const content = await response.json().catch(() => null);
  if (!response.ok) throw new Error(content?.detail || `AI request failed (${response.status})`);
  return content as T;
}

export async function fetchAIPatterns(token: string): Promise<AIPattern[]> {
  const response = await fetch(`${API_BASE}/ai-analysis/patterns`, {
    headers: authHeaders(token), cache: "no-store", credentials: "same-origin",
  });
  const result = await parseResponse<{ patterns: AIPattern[] }>(response);
  return result.patterns;
}

export async function saveAIPattern(payload: {
  name: string; label: string; timeframe: string; note: string; image_data: string;
}, token: string): Promise<AIPattern> {
  const response = await fetch(`${API_BASE}/ai-analysis/patterns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) }, credentials: "same-origin",
    body: JSON.stringify(payload),
  });
  return parseResponse<AIPattern>(response);
}

export async function analyzeAIChart(symbol: string, referenceId: string, token: string): Promise<AIReport> {
  const response = await fetch(`${API_BASE}/ai-analysis/analyze/${encodeURIComponent(symbol)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) }, credentials: "same-origin",
    body: JSON.stringify({ reference_id: referenceId || null, include_vision: true, include_news: true, include_level2: true, include_multi_timeframe: true }),
  });
  return parseResponse<AIReport>(response);
}

export async function scanAICharts(symbols: string[], referenceId: string, token: string, visualTopN = 0): Promise<{
  as_of: string; rank_explanation: string; results: AIReport[];
}> {
  const response = await fetch(`${API_BASE}/ai-analysis/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) }, credentials: "same-origin",
    body: JSON.stringify({ symbols, reference_id: referenceId || null, visual_top_n: visualTopN }),
  });
  return parseResponse<{ as_of: string; rank_explanation: string; results: AIReport[] }>(response);
}

export async function fetchAIPatternImage(patternId: string, token: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}/ai-analysis/patterns/${encodeURIComponent(patternId)}/image`, {
    headers: authHeaders(token), cache: "no-store", credentials: "same-origin",
  });
  if (!response.ok) throw new Error(`Could not load pattern screenshot (${response.status})`);
  return response.blob();
}


// The browser receives only a Secure, HttpOnly, SameSite=Strict session cookie.
// The API token is sent once over HTTPS and is never stored in JavaScript storage.
export async function getAISession(): Promise<{ authenticated: boolean; requires_token: boolean }> {
  const response = await fetch(`${API_BASE}/ai-analysis/session`, { credentials: "same-origin", cache: "no-store" });
  return parseResponse(response);
}

export async function beginAISession(token: string): Promise<void> {
  if (typeof window === "undefined" || window.location.protocol !== "https:") {
    throw new Error("Secure remembered sign-in requires HTTPS. Do not enter the AI token on an HTTP website.");
  }
  const response = await fetch(`${API_BASE}/ai-analysis/session`, {
    method: "POST", credentials: "same-origin", cache: "no-store",
    headers: { "X-AI-Analysis-Token": token.trim() },
  });
  await parseResponse(response);
}

export async function endAISession(): Promise<void> {
  const response = await fetch(`${API_BASE}/ai-analysis/session`, {
    method: "DELETE", credentials: "same-origin", cache: "no-store",
  });
  await parseResponse(response);
}
