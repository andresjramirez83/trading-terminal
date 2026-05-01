import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ScannerPanel from "../components/ScannerPanel";

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

  if (!cleaned.length) return;

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
            onClick={() => navigate("/")}
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
            Back to Terminal
          </button>
        </div>
      </div>

      <div
        style={{
          height: "calc(100vh - 120px)",
          minHeight: 0,
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
