// src/components/ChartPanelV2/ChartToolbarV2.tsx

import type { CrosshairInfo, StudyVisibility } from "../../chart/ChartTypes";
import CrosshairInfoBox from "./CrosshairInfoBox";
import ChartStudyToggles from "./ChartStudyToggles";

type Props = {
  symbol: string;
  timeframe: string;
  crosshairInfo: CrosshairInfo | null;
  studyVisibility: StudyVisibility;
  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (timeframe: string) => void;
  onStudyVisibilityChange: (visibility: StudyVisibility) => void;
};

const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d"];

export default function ChartToolbarV2({
  symbol,
  timeframe,
  crosshairInfo,
  studyVisibility,
  onSymbolChange,
  onTimeframeChange,
  onStudyVisibilityChange,
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
        flexShrink: 0,
        zIndex: 30,
        overflow: "visible",
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
          flexShrink: 0,
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
            flexShrink: 0,
          }}
        >
          {tf.toUpperCase()}
        </button>
      ))}

      <CrosshairInfoBox info={crosshairInfo} />

      <ChartStudyToggles
        visibility={studyVisibility}
        onChange={onStudyVisibilityChange}
      />
    </div>
  );
}
