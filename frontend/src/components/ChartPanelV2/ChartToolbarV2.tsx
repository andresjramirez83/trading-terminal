// src/components/NewChart/ChartToolbarV2.tsx

type Props = {
  symbol: string;
  timeframe: string;
  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (timeframe: string) => void;
};

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

export default function ChartToolbarV2({
  symbol,
  timeframe,
  onSymbolChange,
  onTimeframeChange,
}: Props) {
  return (
    <div
      style={{
        height: 42,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        background: "#181b1f",
        borderBottom: "1px solid rgba(255,255,255,.08)",
        color: "#e5e7eb",
        zIndex: 30,
      }}
    >
      <input
        value={symbol}
        onChange={(e) => onSymbolChange(e.target.value.toUpperCase())}
        style={{
          width: 90,
          height: 28,
          background: "#0f1115",
          color: "white",
          border: "1px solid rgba(255,255,255,.15)",
          borderRadius: 6,
          padding: "0 8px",
          fontWeight: 700,
        }}
      />

      {TIMEFRAMES.map((tf) => (
        <button
          key={tf}
          onClick={() => onTimeframeChange(tf)}
          style={{
            height: 28,
            padding: "0 10px",
            borderRadius: 6,
            border: "1px solid rgba(255,255,255,.12)",
            background: timeframe === tf ? "#2563eb" : "#0f1115",
            color: "white",
            cursor: "pointer",
            fontWeight: 700,
          }}
        >
          {tf.toUpperCase()}
        </button>
      ))}
    </div>
  );
}