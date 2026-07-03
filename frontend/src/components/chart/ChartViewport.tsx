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

   
    </main>
  );
});

export default ChartViewport;
