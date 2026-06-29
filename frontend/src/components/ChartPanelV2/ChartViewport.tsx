// src/components/ChartPanelV2/ChartViewport.tsx

import { forwardRef } from "react";
import type { LiveStatus } from "../../chart/ChartTypes";

type Props = {
  liveStatus: LiveStatus;
};

const ChartViewport = forwardRef<HTMLDivElement, Props>(function ChartViewport(
  { liveStatus },
  ref
) {
  return (
    <main
      style={{
        position: "relative",
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
        background: "#111315",
      }}
    >
      <div
        ref={ref}
        style={{
          width: "100%",
          height: "100%",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      />

      <div
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          padding: "6px 10px",
          borderRadius: 6,
          background:
            liveStatus === "live"
              ? "#16a34a"
              : liveStatus === "connecting"
              ? "#f59e0b"
              : "#dc2626",
          color: "white",
          fontWeight: 700,
          fontSize: 12,
          lineHeight: 1,
          userSelect: "none",
          pointerEvents: "none",
          zIndex: 20,
          boxShadow: "0 4px 12px rgba(0,0,0,.25)",
        }}
      >
        {liveStatus === "live"
          ? "LIVE"
          : liveStatus === "connecting"
          ? "CONNECTING..."
          : "DISCONNECTED"}
      </div>
    </main>
  );
});

export default ChartViewport;
