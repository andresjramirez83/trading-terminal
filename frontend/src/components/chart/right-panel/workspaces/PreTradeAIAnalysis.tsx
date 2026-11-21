import { useEffect, useState, type CSSProperties } from "react";
import { analyzeAIChart, fetchAIPatterns, type AIReport, type AIPattern } from "../../../../services/aiAnalysis";
import AIAuthPanel from "../../../AIAuthPanel";
import { sendAIMarkupCommand, type AIOverlayMode } from "../../ai/aiMarkupEvents";

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
  const [patterns, setPatterns] = useState<AIPattern[]>([]);
  const [selectedPattern, setSelectedPattern] = useState(() => {
    try { return window.sessionStorage.getItem("tt_selected_ai_reference") || ""; }
    catch { return ""; }
  });
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<AIReport | null>(null);
  const [error, setError] = useState("");
  const [overlayMode, setOverlayMode] = useState<AIOverlayMode>("clean");

  useEffect(() => { setReport(null); setError(""); setOverlayMode("clean"); }, [symbol]);
  useEffect(() => {
    try { window.sessionStorage.setItem("tt_selected_ai_reference", selectedPattern); } catch { /* optional UI state */ }
  }, [selectedPattern]);
  useEffect(() => {
    let live = true;
    fetchAIPatterns("").then((items) => { if (live) setPatterns(items); }).catch(() => {});
    return () => { live = false; };
  }, []);

  async function run() {
    setBusy(true); setError("");
    try {
      const next = await analyzeAIChart(symbol, selectedPattern, "");
      setReport(next);
      sendAIMarkupCommand({ mode: "set", symbol, marks: next.annotations || [], projections: next.projections, multiTimeframe: next.multi_timeframe, patternMatch: next.pattern_match, displacementFvgSweep: next.displacement_fvg_sweep });
      sendAIMarkupCommand({ mode: "view", symbol, view: overlayMode });
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
      <AIAuthPanel onSignedIn={() => void fetchAIPatterns("").then(setPatterns).catch(() => {})} />
      <button type="button" style={{ ...btn, background: "#17223a", borderColor: "#334155" }} onClick={() => void fetchAIPatterns("").then(setPatterns).catch((e) => setError(String(e)))}>Reload Saved Patterns</button>
      <button type="button" disabled={busy || !symbol} style={{ ...btn, opacity: busy ? 0.55 : 1 }} onClick={() => void run()}>
        {busy ? "Analyzing…" : `ANALYZE & MARK CHART · ${symbol}`}
      </button>
      <div style={{ display: "grid", gap: 5 }}>
        <strong style={{ fontSize: 11, color: "#93c5fd" }}>CHART VIEW</strong>
        <div style={{ display: "flex", gap: 5 }}>
          {(["clean", "detailed", "hidden"] as const).map((view) => (
            <button key={view} type="button" aria-pressed={overlayMode === view}
              style={{ ...btn, flex: 1, padding: "8px 3px", fontSize: 11,
                background: overlayMode === view ? "#1d4ed8" : "#17223a",
                borderColor: overlayMode === view ? "#60a5fa" : "#334155" }}
              onClick={() => {
                setOverlayMode(view);
                sendAIMarkupCommand({ mode: "view", symbol, view });
              }}>{view === "clean" ? "Clean" : view === "detailed" ? "Detailed" : "Hidden"}</button>
          ))}
        </div>
        <button type="button" style={{ ...btn, background: "#17223a", borderColor: "#334155" }}
          onClick={() => { sendAIMarkupCommand({ mode: "clear", symbol }); setReport(null); }}>Clear AI overlay</button>
      </div>
      <small style={{ color: "#94a3b8", lineHeight: 1.5 }}>
        <b>Clean</b> shows one conditional path for the active 1m/5m chart, one nearby reaction area,
        a target and an invalidation (when supported). Range/stale setups show no directional forecast.
        <b> Detailed</b> shows the original technical marks. <b>Hidden</b> removes AI drawings.
        These are rule-based what-if illustrations, not learned price predictions or order instructions.
      </small>
      {error && <div role="alert" style={{ color: "#fca5a5", fontSize: 11 }}>{error}</div>}
      {report && <div style={{ display: "grid", gap: 8, fontSize: 11, lineHeight: 1.5 }}>
        <div>{report.annotations?.length ?? 0} measured research marks available. Clean mode draws only a small selection for the active timeframe.</div>
        {report.displacement_fvg_sweep && <div style={{ border: "1px solid #365b90", borderRadius: 8, padding: 9, display: "grid", gap: 5 }}>
          <strong style={{ color: "#93c5fd" }}>RALLY → RETRACEMENT FVG → RANGE SWEEP / RECLAIM</strong>
          <b>{report.displacement_fvg_sweep.status.replaceAll("_", " ").toUpperCase()}
            {report.displacement_fvg_sweep.historical_only ? " · historical only" : ""}</b>
          {(() => {
            const candidate = report.displacement_fvg_sweep?.setup || report.displacement_fvg_sweep?.watch;
            if (!candidate) return <span>No qualifying pre-existing bearish gap and range sequence in recent closed 5m candles.</span>;
            return <>
              <span>Initial rally: ${candidate.gap.rally_low.toFixed(3)} → ${candidate.gap.rally_high.toFixed(3)}</span>
              <span>Consolidation: {candidate.zone.candles} bars · {candidate.zone.touches} separated low tests near ${candidate.zone.low.toFixed(3)}</span>
              <span style={{ color: "#fcd34d" }}>Pre-existing bearish FVG: ${candidate.gap.low.toFixed(3)}–${candidate.gap.high.toFixed(3)} (potential target, not guaranteed)</span>
              {report.displacement_fvg_sweep?.setup && <>
                <span>Sweep low ${report.displacement_fvg_sweep.setup.sweep_low.toFixed(3)} · reclaim {report.displacement_fvg_sweep.setup.reclaim_quality.replaceAll("_", " ")}</span>
                <span>Watch failure below ${report.displacement_fvg_sweep.setup.invalidation.toFixed(3)}</span>
              </>}
            </>;
          })()}
          <small style={{ color: "#94a3b8" }}>FVG formed before the sweep. Early phone alerts use completed 1m candles; confirmation requires a closed 5m candle. No automated order placement.</small>
        </div>}
        {report.pattern_match && <div style={{ border: "1px solid #365b90", borderRadius: 8, padding: 9, display: "grid", gap: 6 }}>
          <strong style={{ color: "#93c5fd" }}>SAVED PATTERN · OBSERVED CANDLE STAGES</strong>
          <b>{report.pattern_match.reference_name} · {report.pattern_match.timeframe}</b>
          <span style={{ color: report.pattern_match.matched ? "#86efac" : "#fcd34d" }}>
            {report.pattern_match.status.replaceAll("_", " ")}{report.pattern_match.historical_only ? " · historical only" : ""}
          </span>
          {report.pattern_match.reasons.map((line, i) => <span key={i} style={{ color: "#cbd5e1" }}>{line}</span>)}
          <small style={{ color: "#94a3b8" }}>Only observed, completed candles are marked. A saved screenshot does not train a model or guarantee a matching trade; the visual comparison is separate.</small>
        </div>}
        {report.multi_timeframe && <div style={{ border: "1px solid #365b90", borderRadius: 8, padding: 9, display: "grid", gap: 7 }}>
          <strong style={{ color: "#93c5fd" }}>MULTI-TIMEFRAME · FVG & ZONE RESPECT</strong>
          <div style={{ color: "#cbd5e1" }}>
            {report.multi_timeframe.dominant_timeframe
              ? <>Strongest observed reaction evidence: <b>{report.multi_timeframe.dominant_timeframe}</b></>
              : "No clearly respected timeframe established yet."}
          </div>
          <div style={{ color: "#94a3b8", fontSize: 10 }}>{report.multi_timeframe.dominant_reason}</div>
          {(["1m", "5m", "15m", "30m", "1h"] as const).map((tf) => {
            const f = report.multi_timeframe?.timeframes?.[tf];
            return <div key={tf} style={{ display: "flex", justifyContent: "space-between", gap: 7, borderTop: "1px solid #24354d", paddingTop: 4 }}>
              <b>{tf}</b>
              {f ? <span style={{ color: f.stale ? "#fbbf24" : "#cbd5e1", textAlign: "right" }}>
                {f.quality}{f.stale ? " · historical" : ""} · {f.positive_reactions} reactions / {f.broken_zones} breaks · {f.open_fvgs} open FVGs
              </span> : <span style={{ color: "#fbbf24" }}>Data unavailable</span>}
            </div>;
          })}
          <strong style={{ color: "#93c5fd" }}>OPEN FAIR VALUE GAPS TO WATCH</strong>
          {report.multi_timeframe.ranked_open_gaps.length === 0 && <span>No qualifying unfilled three-candle gaps in the available history.</span>}
          {report.multi_timeframe.ranked_open_gaps.slice(0, 4).map((gap) => (
            <div key={gap.id} style={{ color: gap.direction === "bullish" ? "#86efac" : "#fda4af" }}>
              {gap.timeframe} {gap.direction} · {gap.status.replace("_", " ")} · ${gap.remaining_low.toFixed(4)}–${gap.remaining_high.toFixed(4)}
              {gap.data_stale ? " · historical" : ""}
            </div>
          ))}
          {Object.entries(report.multi_timeframe.feed_errors || {}).map(([tf, msg]) => (
            <div key={tf} style={{ color: "#fca5a5" }}>{tf} data feed: {msg}</div>
          ))}
          <small style={{ color: "#94a3b8" }}>Higher-timeframe gaps are not guaranteed targets. Respect scores use completed candle rejections and breaks, not AI win probabilities. Clean mode shows at most one relevant FVG zone.</small>
        </div>}
        {report.projections && <div style={{ border: "1px solid #365b90", borderRadius: 8, padding: 9, display: "grid", gap: 8 }}>
          <strong style={{ color: "#93c5fd" }}>AI-ASSISTED SCENARIO PROJECTIONS</strong>
          <div style={{ fontSize: 10, color: "#fcd34d" }}>Evidence score is NOT a probability. These paths are mechanical what-if sketches using volatility and completed candles; the model's written vision review is separate.</div>
          {(["1m", "5m"] as const).map((tf) => {
            const f = report.projections?.timeframes[tf];
            if (!f) return <div key={tf}>{tf}: insufficient candle history for scenarios</div>;
            const money = (n: number) => Number.isFinite(n) ? n.toFixed(n < 1 ? 4 : 2) : "—";
            return <div key={tf} style={{ borderTop: "1px solid #334155", paddingTop: 7, display: "grid", gap: 3 }}>
              <strong>{tf} · {f.bias.toUpperCase()} / {f.evidence_strength.toUpperCase()} evidence {f.stale ? "· STALE: historical illustration only" : ""}</strong>
              <span>Evidence meter: {f.evidence_score}/100 (uncalibrated rule tally, not confidence %)</span>
              <span>Last observed close {money(f.anchor_price)} · support {money(f.support)} · resistance {money(f.resistance)}</span>
              <span style={{ color: "#86efac" }}>Upside confirmation watch above {money(f.upside_trigger)} · possible upside path ends near {money(f.bullish_path[f.bullish_path.length - 1].price)}</span>
              <span style={{ color: "#fda4af" }}>Downside failure watch below {money(f.downside_trigger)} · possible downside path ends near {money(f.bearish_path[f.bearish_path.length - 1].price)}</span>
              <span style={{ color: "#fcd34d" }}>Main cautious scenario ends near {money(f.base_path[f.base_path.length - 1].price)} over {f.bars_forward} future chart slots</span>
              <span style={{ color: "#9ca3af", fontSize: 10 }}>Evidence: {f.reasons.join("; ")}</span>
            </div>;
          })}
        </div>}
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
