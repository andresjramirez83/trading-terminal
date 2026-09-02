import ChartPanel from "../components/chart/ChartPanel";

export default function ChartV2Page() {
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
