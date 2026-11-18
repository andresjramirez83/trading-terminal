import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { fetchAIPatternImage, fetchAIPatterns, saveAIPattern, scanAICharts, type AIPattern, type AIReport } from "../services/aiAnalysis";

type Props = { selectedSymbol: string; onSelectSymbol: (symbol: string) => void };
const field: CSSProperties = { border: "1px solid #334155", background: "#071225", color: "#f1f5f9", padding: "8px", borderRadius: 7, maxWidth: "100%" };
const button: CSSProperties = { border: "1px solid #2563eb", color: "#fff", background: "#1d4ed8", borderRadius: 7, padding: "9px 12px", cursor: "pointer", fontWeight: 800 };

function fileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Unable to read screenshot"));
    reader.readAsDataURL(file);
  });
}

export default function AIPatternLab({ selectedSymbol, onSelectSymbol }: Props) {
  const [patterns, setPatterns] = useState<AIPattern[]>([]);
  const [token, setToken] = useState("");
  const [name, setName] = useState("Bullish pullback");
  const [label, setLabel] = useState("interesting");
  const [timeframe, setTimeframe] = useState("1m");
  const [note, setNote] = useState("Rally, 60–78% pullback, potential reversal; mark the alert candle and ignore future price action.");
  const [file, setFile] = useState<File | null>(null);
  const [referenceId, setReferenceId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [scanSymbols, setScanSymbols] = useState("");
  const [visualTop, setVisualTop] = useState(false);
  const [result, setResult] = useState<AIReport[]>([]);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try { setPatterns(await fetchAIPatterns(token)); }
    catch (e) { setNotice(e instanceof Error ? e.message : "Could not load pattern library"); }
  }, [token]);
  useEffect(() => { void fetchAIPatterns("").then(setPatterns).catch(() => {}); }, []);

  async function save() {
    if (!file) { setNotice("Select a chart screenshot first."); return; }
    if (file.size > 5 * 1024 * 1024) { setNotice("Screenshot must be smaller than 5 MB."); return; }
    setBusy(true); setNotice("");
    try {
      const saved = await saveAIPattern({ name, label, timeframe, note, image_data: await fileAsDataUrl(file) }, token);
      setReferenceId(saved.id);
      setNotice(`Saved ${saved.name}. Example saved for future comparison; it has not trained a model.`);
      await refresh();
    } catch (e) { setNotice(e instanceof Error ? e.message : "Save failed"); }
    finally { setBusy(false); }
  }

  async function preview() {
    if (!referenceId) return;
    setNotice("");
    try {
      const url = URL.createObjectURL(await fetchAIPatternImage(referenceId, token));
      setPreviewUrl((previous) => { if (previous) URL.revokeObjectURL(previous); return url; });
    } catch (e) { setNotice(e instanceof Error ? e.message : "Preview unavailable"); }
  }

  async function runScan() {
    setBusy(true); setNotice("");
    try {
      let watchlist: string[] = [];
      try {
        const stored = JSON.parse(window.localStorage.getItem("watchlist") || "[]");
        if (Array.isArray(stored)) watchlist = stored.filter((s): s is string => typeof s === "string");
      } catch { /* ignore malformed stored lists */ }
      const sources = scanSymbols.trim() ? scanSymbols.split(/[\s,;]+/) : [...watchlist, selectedSymbol];
      const symbols = Array.from(new Set(sources.map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9.\-]{1,15}$/.test(s)))).slice(0, 30);
      if (!symbols.length) throw new Error("Add at least one ticker to scan.");
      const data = await scanAICharts(symbols, referenceId, token, visualTop ? 1 : 0);
      setResult(data.results);
      setNotice(`Scanned ${data.results.length} symbols on demand. Ranking is rule-based, NOT an AI probability.`);
    } catch (e) { setNotice(e instanceof Error ? e.message : "Scan failed"); }
    finally { setBusy(false); }
  }

  return (
    <details style={{ borderRadius: 12, padding: 13, marginBottom: 14, border: "1px solid #365b90", background: "#071c39" }}>
      <summary style={{ fontSize: 16, fontWeight: 900, cursor: "pointer" }}>AI Pattern Library & Multi-Stage Discovery (new)</summary>
      <p style={{ color: "#94a3b8", fontSize: 12, lineHeight: 1.5 }}>Save your completed chart screenshots one at a time. The scanner measures closed-candle rallies, retracements, 1m engulfing and 5m follow-through. With an API key, it can also visually compare the top candidate's chart against a saved example. No auto-trades or silent model training.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <input style={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Pattern name" aria-label="Pattern name" />
        <select style={field} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Example classification">
          <option value="interesting">Interesting example</option><option value="good">Good example</option><option value="bad">Bad or failed setup</option>
        </select>
        <select style={field} value={timeframe} onChange={(e) => setTimeframe(e.target.value)} aria-label="Reference timeframe">
          <option value="1m">1m</option><option value="5m">5m</option><option value="15m">15m</option>
        </select>
        <input type="file" accept="image/png,image/jpeg,image/webp" style={field} onChange={(e) => setFile(e.target.files?.[0] || null)} aria-label="Chart screenshot" />
      </div>
      <textarea style={{ ...field, display: "block", minHeight: 54, width: "100%", boxSizing: "border-box", marginBottom: 10 }} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What should the AI notice? At what candle would you want an alert?" />
      <button style={button} type="button" disabled={busy} onClick={() => void save()}>Save Screenshot</button>
      <div style={{ marginTop: 15, display: "grid", gap: 9 }}>
        <strong>Scan your watchlist</strong>
        <input style={{ ...field, width: "100%", boxSizing: "border-box" }} value={scanSymbols} onChange={(e) => setScanSymbols(e.target.value)} placeholder="Optional: FRTT, AAPL, TSLA (blank uses saved watchlist + selected symbol; up to 30)" />
        <select style={field} value={referenceId} onChange={(e) => setReferenceId(e.target.value)}>
          <option value="">No reference selected</option>
          {patterns.map((p) => <option key={p.id} value={p.id}>{p.name} · {p.timeframe} · {p.label}</option>)}
        </select>
        <div style={{ display: "grid", gap: 7 }}>
          <button type="button" style={{ ...button, width: "fit-content", background: "#17223a" }} disabled={!referenceId} onClick={() => void preview()}>Preview Selected Reference</button>
          {previewUrl && <img src={previewUrl} alt="Saved pattern reference" style={{ width: "min(100%, 700px)", borderRadius: 8 }} />}
        </div>
        <label style={{ fontSize: 12, display: "flex", gap: 8 }}><input type="checkbox" checked={visualTop} onChange={(e) => setVisualTop(e.target.checked)} />Visually review top-ranked result (requires OPENAI_API_KEY; may incur API costs)</label>
        <details><summary style={{ cursor: "pointer", fontSize: 12 }}>API access token (if required)</summary><input style={{ ...field, marginTop: 6 }} type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="Not stored" /><button type="button" style={{ ...button, marginLeft: 8 }} onClick={() => void refresh()}>Reload Pattern Library</button></details>
        <div><button style={button} type="button" disabled={busy} onClick={() => void runScan()}>{busy ? "Working…" : "Scan For Developing Patterns"}</button></div>
      </div>
      {notice && <div role="status" style={{ margin: "10px 0", color: "#fde68a", fontSize: 12 }}>{notice}</div>}
      {result.length > 0 && <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
        {result.map((r) => <button key={r.symbol} type="button" onClick={() => { onSelectSymbol(r.symbol); window.location.assign("/chart"); }} style={{ ...field, cursor: "pointer", textAlign: "left", display: "flex", gap: 12, justifyContent: "space-between" }}>
          <span><strong>{r.symbol}</strong> · {r.phase?.replace(/_/g, " ")}</span>
          <span>Points {r.rank_points ?? 0}/6 · Retrace {r.structure?.retracement_pct ?? "—"}% · {r.vision?.ok ? "Visual review available" : "Open chart"}</span>
        </button>)}
      </div>}
    </details>
  );
}
