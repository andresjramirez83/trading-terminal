import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ScannerPanel from "../components/ScannerPanel";
import AIPatternLab from "../components/AIPatternLab";
import { API_BASE } from "../services/api";

const SHARED_SCANNER_WATCHLIST_STORAGE_KEY = "watchlist";
const SHARED_ACTIVE_SYMBOL_STORAGE_KEY = "activeSymbol";
const DEFAULT_SYMBOL = "AAPL";

function normalizeSingleSymbol(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9.]/g, "");
}

function loadSharedActiveSymbol(): string {
  if (typeof window === "undefined") return DEFAULT_SYMBOL;
  const saved = normalizeSingleSymbol(window.localStorage.getItem(SHARED_ACTIVE_SYMBOL_STORAGE_KEY) || "");
  return saved || DEFAULT_SYMBOL;
}

function saveSharedScannerWatchlist(nextWatchlist: string[]) {
  if (typeof window === "undefined") return;

  const cleaned = Array.from(
    new Set(nextWatchlist.map((item) => normalizeSingleSymbol(String(item))).filter(Boolean))
  );

  window.localStorage.setItem(SHARED_SCANNER_WATCHLIST_STORAGE_KEY, JSON.stringify(cleaned));
  window.dispatchEvent(
    new CustomEvent<string[]>("scanner-watchlist-change", {
      detail: cleaned,
    })
  );
}

function saveSharedActiveSymbol(nextSymbol: string) {
  if (typeof window === "undefined") return;
  const cleaned = normalizeSingleSymbol(nextSymbol);
  if (!cleaned) return;

  window.localStorage.setItem(SHARED_ACTIVE_SYMBOL_STORAGE_KEY, cleaned);
  window.dispatchEvent(
    new CustomEvent<string>("scanner-active-symbol-change", {
      detail: cleaned,
    })
  );
}

export default function ScannerPage() {
  const navigate = useNavigate();
  const [symbol, setSymbol] = useState(() => loadSharedActiveSymbol());
  type FibSignal = {key:string;symbol:string;timeframe:string;stage:string;hl_price?:number;fib_pct?:number;sweep_low?:number;sweep_time?:string;signal_time?:string};
  const [fibSignals,setFibSignals]=useState<FibSignal[]>([]);
  const [fibError,setFibError]=useState("");
  useEffect(()=>{
    let active=true;
    const refresh=async()=>{
      try {
        const res=await fetch(`${API_BASE}/fib-hl-signals`,{cache:"no-store"});
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const data=await res.json() as {signals?:FibSignal[]};
        if(active){setFibSignals(Array.isArray(data.signals)?data.signals:[]);setFibError("");}
      } catch(err){if(active)setFibError(String(err));}
    };
    void refresh();
    const timer=window.setInterval(()=>void refresh(),30000);
    return ()=>{active=false;window.clearInterval(timer);};
  },[]);

  const handleBackToChart = useCallback(() => {
    // ChartEngine owns browser-level listeners and rendering resources. A clean
    // page transition guarantees they are initialized again after the scanner
    // workspace has been open for an extended period.
    if (typeof window !== "undefined") {
      window.location.assign("/chart");
      return;
    }

    navigate("/chart", { replace: true });
  }, [navigate]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== SHARED_ACTIVE_SYMBOL_STORAGE_KEY || !event.newValue) return;
      const next = normalizeSingleSymbol(event.newValue);
      if (next) setSymbol(next);
    };

    const handleActiveSymbolEvent = (event: Event) => {
      const next = normalizeSingleSymbol((event as CustomEvent<string>).detail || "");
      if (next) setSymbol(next);
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener("scanner-active-symbol-change", handleActiveSymbolEvent);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("scanner-active-symbol-change", handleActiveSymbolEvent);
    };
  }, []);

  const handleSelectSymbol = useCallback((nextSymbol: string) => {
    const next = normalizeSingleSymbol(nextSymbol);
    if (!next) return;
    setSymbol(next);
    saveSharedActiveSymbol(next);
  }, []);

  const handleWatchlistChange = useCallback((symbols: string[]) => {
    saveSharedScannerWatchlist(symbols);
  }, []);

  return (
    <div
      className="scanner-page"
      style={{
        minHeight: "100vh",
        background: "#03152f",
        color: "#ffffff",
        fontFamily: "Arial, sans-serif",
        padding: 16,
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 16,
          padding: 16,
          borderRadius: 14,
          background: "#0a1f44",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>Scanner Center</div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            Overnight runner workflow with saved afterhours + premarket merge.
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              background: "#071731",
              border: "1px solid rgba(255,255,255,0.08)",
              fontSize: 13,
            }}
          >
            Selected Symbol: <strong>{symbol}</strong>
          </div>

          <button
            type="button"
            onClick={handleBackToChart}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.12)",
              background: "#071731",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Back to Chart
          </button>
        </div>
      </div>

      <section style={{padding:16,marginBottom:16,borderRadius:14,background:"#0a1f44",overflowX:"auto"}}>
        <h2 style={{marginTop:0}}>Fibonacci HL Liquidity Sweeps</h2>
        <p style={{fontSize:12,opacity:0.7}}>1M / 5M / 15M | Recent signals | Auto-refresh every 30 seconds</p>
        {fibError && <p style={{color:"#fbbf24"}}>Signal feed unavailable: {fibError}</p>}
        <table style={{width:"100%",textAlign:"left",fontSize:13}}><thead><tr>
          {["Symbol","TF","Higher Low","Fib %","Sweep Low","Status","Time (ET)"].map(h=><th key={h} style={{padding:8}}>{h}</th>)}
        </tr></thead><tbody>
          {fibSignals.slice(0,60).map(r=><tr key={r.key}>
            <td style={{padding:8}}><button type="button" onClick={()=>{handleSelectSymbol(r.symbol);window.sessionStorage.setItem("fib-hl-chart-request",JSON.stringify(r));window.localStorage.setItem("chartv2.timeframe",r.timeframe);handleBackToChart();}}>{r.symbol}</button></td>
            <td>{r.timeframe}</td>
            <td>{r.hl_price == null ? "—" : `$${r.hl_price.toFixed(4)}`}</td>
            <td>{r.fib_pct == null ? "—" : `${r.fib_pct.toFixed(1)}%`}</td>
            <td>{r.sweep_low == null ? "—" : `$${r.sweep_low.toFixed(4)}`}</td>
            <td>{r.stage === "SWEEP" ? "Sweep watch" : r.stage === "IMMEDIATE" ? "Immediate reclaim" : "Delayed reclaim"}</td>
            <td>{r.signal_time || r.sweep_time ? new Date((r.signal_time || r.sweep_time)!).toLocaleString("en-US",{timeZone:"America/New_York"}) : "—"}</td>
          </tr>)}
        </tbody></table>
        {!fibError && fibSignals.length===0 && <p>No recent signals recorded yet.</p>}
        <small style={{opacity:0.6}}>Historical signals are not necessarily active trading setups.</small>
      </section>
      <AIPatternLab selectedSymbol={symbol} onSelectSymbol={handleSelectSymbol} />

      <div
        style={{
          width: "100%",
          minWidth: 0,
          minHeight: "calc(100vh - 140px)",
        }}
      >
        <ScannerPanel
          mode="workspace"
          selectedSymbol={symbol}
          onSelectSymbol={handleSelectSymbol}
          onWatchlistChange={handleWatchlistChange}
        />
      </div>
    </div>
  );
}
