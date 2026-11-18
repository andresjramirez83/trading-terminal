import { useEffect, useState, type CSSProperties } from "react";
import { analyzeAIChart, fetchAIPatterns, type AIReport, type AIPattern } from "../../../../services/aiAnalysis";

type Props = { symbol: string };

const card: CSSProperties = {
  border: "1px solid rgba(96,165,250,.24)", borderRadius: 12,
  padding: 12, background: "#111827", color: "#e5e7eb",
};
const btn: CSSProperties = {
  border: "1px solid #3b82f6", borderRadius: 8, background: "#1d4ed8",
  color: "white", padding: "9px 11px", fontWeight: 800, cursor: "pointer", fontSize: 12,
};
const input: CSSProperties = {
  background: "#0b1220", color: "#e2e8f0", borderRadius: 7,
  border: "1px solid #334155", padding: 7, width: "100%", boxSizing: "border-box",
};

export default function PreTradeAIAnalysis({ symbol }: Props) {
  const [token, setToken] = useState("");
  const [patterns, setPatterns] = useState<AIPattern[]>([]);
  const [selectedPattern, setSelectedPattern] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<AIReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => { setReport(null); setError(""); }, [symbol]);
  useEffect(() => {
    let live = true;
    fetchAIPatterns("").then((items) => { if (live) setPatterns(items); }).catch(() => {});
    return () => { live = false; };
  }, []);

  async function run() {
    setBusy(true); setError("");
    try {
      const next = await analyzeAIChart(symbol, selectedPattern, token);
      setReport(next);
    } catch (exc) {
      setError(exc instanceof Error ? exc.message : "Analysis unavailable");
    } finally { setBusy(false); }
  }

  return (
    <section style={{ ...card, display: "grid", gap: 9 }}>
      <div style={{ fontSize: 11, fontWeight: 900, color: "#93c5fd" }}>PRE-TRADE · AI SECOND PAIR OF EYES</div>
      <div style={{ fontSize: 10, color: "#94a3b8", lineHeight: 1.5 }}>
        Read-only review of closed 1m/5m candles, retracement, volume, current Level 2 (if available), news, filings, and an actual AI-generated chart image when configured. No orders are submitted.
      </div>
      <select style={input} value={selectedPattern} onChange={(e) => setSelectedPattern(e.target.value)}>
        <option value="">General visual review (no reference)</option>
        {patterns.map((p) => <option value={p.id} key={p.id}>Compare: {p.name}</option>)}
      </select>
      <details>
        <summary style={{ fontSize: 10, cursor: "pointer", color: "#93c5fd" }}>AI access token (if configured on server)</summary>
        <input type="password" autoComplete="off" placeholder="Optional token; not stored" style={{ ...input, marginTop: 6 }} value={token} onChange={(e) => setToken(e.target.value)} />
      </details>
      <button type="button" style={{ ...btn, background: "#17223a", borderColor: "#334155" }} onClick={() => void fetchAIPatterns(token).then(setPatterns).catch((e) => setError(String(e)))}>Reload Saved Patterns</button>
      <button type="button" disabled={busy || !symbol} style={{ ...btn, opacity: busy ? 0.55 : 1 }} onClick={() => void run()}>
        {busy ? "Analyzing…" : `AI ANALYSIS · ${symbol}`}
      </button>
      {error && <div role="alert" style={{ color: "#fca5a5", fontSize: 11 }}>{error}</div>}
      {report && <div style={{ display: "grid", gap: 8, fontSize: 11, lineHeight: 1.5 }}>
        <div><strong>Phase:</strong> {report.phase.replace(/_/g, " ")} · {new Date(report.as_of || "").toLocaleTimeString()}</div>
        <div>Retracement: {report.structure?.retracement_pct == null ? "Not established" : `${report.structure.retracement_pct}%`}</div>
        <div>1m engulf (recent): {report.one_minute?.engulfing_recent_5 ? "Detected" : "Not detected"}</div>
        <div>1m potential low sweep: {report.one_minute?.potential_low_sweep ? "Possible sweep/reclaim" : "Not detected"}</div>
        <div>5m bullish close: {report.five_minute?.strong_bullish_close ? "Confirmed on last closed candle" : "Not confirmed"}</div>
        <div>5m recovery of previous red body: {report.five_minute?.red_body_recovery_pct == null ? "Not applicable" : `${report.five_minute.red_body_recovery_pct}%`}</div>
        {(report.notes || []).map((line, i) => <div key={`n${i}`} style={{ color: "#86efac" }}>+ {line}</div>)}
        {(report.caveats || []).map((line, i) => <div key={`w${i}`} style={{ color: "#fcd34d" }}>! {line}</div>)}
        {report.news?.alerts?.map((a, i) => <div key={`a${i}`} style={{ color: a.severity === "critical" ? "#fca5a5" : "#fde68a" }}>News: {a.title} — {a.detail}</div>)}
        {report.level2 && <div>Level 2: {report.level2.available ? `Spread ${report.level2.spread ?? "?"}; top-5 imbalance ${report.level2.top5_imbalance ?? "?"}` : report.level2.reason}</div>}
        {report.level2?.available && <div>Recent tape: {report.level2.l2_ready ? "ready" : "warming up"} · {report.level2.tape_5s?.ticker_prints_5s ?? "—"} prints / 5s · pressure {report.level2.tape_5s?.trade_pressure_5s ?? "—"}</div>}
        {report.vision?.ok ? <div style={{ whiteSpace: "pre-wrap", color: "#dbeafe", borderTop: "1px solid #334155", paddingTop: 8 }}><strong>Visual AI review ({report.vision.model}):</strong>{"\n"}{report.vision.narrative}</div> : <div style={{ color: "#fbbf24" }}>Visual AI: {report.vision?.message || "Not available"}</div>}
        {(report.data_errors || []).map((e, i) => <div key={`e${i}`} style={{ color: "#fca5a5" }}>Market data error: {e}</div>)}
        {report.news?.sources && Object.entries(report.news.sources).filter(([, value]) => typeof value === "object" && value?.ok === false).map(([key, value]) => <div key={key} style={{ color: "#fcd34d" }}>{key}: {typeof value === "object" ? value.error : value}</div>)}
        <div style={{ fontSize: 10, color: "#94a3b8" }}>Research only. You make all trading decisions. A missing feed or lack of warning does not mean a trade is safe.</div>
      </div>}
    </section>
  );
}
