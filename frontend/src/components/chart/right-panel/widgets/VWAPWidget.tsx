import PanelCard from "../components/PanelCard";

function Row({
  label,
  value,
  color = "#e5e7eb",
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        fontSize: 12,
      }}
    >
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ color, fontWeight: 900 }}>{value}</span>
    </div>
  );
}

export default function VWAPWidget() {
  return (
    <PanelCard title="VWAP Score">
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        <Row label="Price vs VWAP" value="Above" color="#22c55e" />
        <Row label="VWAP Slope" value="Rising" color="#22c55e" />
        <Row label="VWAP Reclaim" value="Confirmed" color="#22c55e" />
      </div>
    </PanelCard>
  );
}