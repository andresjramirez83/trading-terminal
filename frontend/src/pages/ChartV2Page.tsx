import { useEffect } from "react";
import ChartPanel from "../components/chart/ChartPanel";

export default function ChartV2Page() {
  // CHART_VIEWPORT_LOCK_20260904
  // The browser page itself must never scroll while the chart is open.
  // Scrolling is intentionally delegated to internal workspaces such as
  // the right info panel. Restore previous styles when leaving /chart.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    const previousHtmlOverflow = html.style.overflow;
    const previousBodyOverflow = body.style.overflow;
    const previousBodyOverscroll = body.style.overscrollBehavior;

    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";

    return () => {
      html.style.overflow = previousHtmlOverflow;
      body.style.overflow = previousBodyOverflow;
      body.style.overscrollBehavior = previousBodyOverscroll;
    };
  }, []);

  return (
    <div
      className="chart-v2-page"
      style={{
        width: "100vw",
        height: "100vh",
        background: "#111",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <ChartPanel />
    </div>
  );
}
