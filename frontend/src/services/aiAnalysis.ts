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

export type AIReport = {
  symbol: string;
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

function authHeaders(token: string): Record<string, string> {
  return token.trim() ? { "X-AI-Analysis-Token": token.trim() } : {};
}

async function parseResponse<T>(response: Response): Promise<T> {
  const content = await response.json().catch(() => null);
  if (!response.ok) throw new Error(content?.detail || `AI request failed (${response.status})`);
  return content as T;
}

export async function fetchAIPatterns(token: string): Promise<AIPattern[]> {
  const response = await fetch(`${API_BASE}/ai-analysis/patterns`, {
    headers: authHeaders(token), cache: "no-store",
  });
  const result = await parseResponse<{ patterns: AIPattern[] }>(response);
  return result.patterns;
}

export async function saveAIPattern(payload: {
  name: string; label: string; timeframe: string; note: string; image_data: string;
}, token: string): Promise<AIPattern> {
  const response = await fetch(`${API_BASE}/ai-analysis/patterns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify(payload),
  });
  return parseResponse<AIPattern>(response);
}

export async function analyzeAIChart(symbol: string, referenceId: string, token: string): Promise<AIReport> {
  const response = await fetch(`${API_BASE}/ai-analysis/analyze/${encodeURIComponent(symbol)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ reference_id: referenceId || null, include_vision: true, include_news: true, include_level2: true }),
  });
  return parseResponse<AIReport>(response);
}

export async function scanAICharts(symbols: string[], referenceId: string, token: string, visualTopN = 0): Promise<{
  as_of: string; rank_explanation: string; results: AIReport[];
}> {
  const response = await fetch(`${API_BASE}/ai-analysis/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(token) },
    body: JSON.stringify({ symbols, reference_id: referenceId || null, visual_top_n: visualTopN }),
  });
  return parseResponse(response);
}

export async function fetchAIPatternImage(patternId: string, token: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}/ai-analysis/patterns/${encodeURIComponent(patternId)}/image`, {
    headers: authHeaders(token), cache: "no-store",
  });
  if (!response.ok) throw new Error(`Could not load pattern screenshot (${response.status})`);
  return response.blob();
}
