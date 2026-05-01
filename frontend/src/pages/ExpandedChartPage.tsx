import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import TradingViewExpandedChart from "../components/TradingViewExpandedChart";

export default function ExpandedChartPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const initialSymbol = (searchParams.get("symbol") || "AAPL").toUpperCase();
  const initialTf = searchParams.get("tf") || "1m";

  const [symbol, setSymbol] = useState(initialSymbol);
  const [timeframe, setTimeframe] = useState(initialTf);

  const loadChart = () => {
    const nextSymbol = symbol.trim().toUpperCase() || "AAPL";
    setSearchParams({ symbol: nextSymbol, tf: timeframe });
    setSymbol(nextSymbol);
  };

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
          <div style={{ fontSize: 28, fontWeight: 700 }}>
            Expanded Chart
          </div>
          <div style={{ fontSize: 13, opacity: 0.7 }}>
            TradingView widget with indicators and chart tools
          </div>
        </div>

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="Ticker"
            style={{
              width: 140,
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "#071731",
              color: "white",
              fontSize: 16,
            }}
          />

          <select
            value={timeframe}
            onChange={(e) => setTimeframe(e.target.value)}
            style={{
              padding: "10px 12px",
              borderRadius: 8,
              border: "1px solid rgba(255,255,255,0.15)",
              background: "#071731",
              color: "white",
              fontSize: 15,
            }}
          >
            <option value="1m">1m</option>
            <option value="5m">5m</option>
            <option value="15m">15m</option>
            <option value="30m">30m</option>
            <option value="1h">1h</option>
            <option value="1d">1d</option>
          </select>

          <button
            onClick={loadChart}
            style={{
              padding: "10px 14px",
              borderRadius: 8,
              border: "1px solid #4ea1ff",
              background: "#12396b",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 700,
            }}
          >
            Load
          </button>

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
          minHeight: 700,
          background: "#0a1f44",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 14,
          overflow: "hidden",
        }}
      >
        <TradingViewExpandedChart
          symbol={(searchParams.get("symbol") || "AAPL").toUpperCase()}
          timeframe={searchParams.get("tf") || "1m"}
        />
      </div>
    </div>
  );
}
