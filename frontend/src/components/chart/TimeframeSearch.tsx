// src/components/ChartPanelV2/TimeframeSearch.tsx

type Props = {
  value: string;
  onChange: (value: string) => void;
};

export default function TimeframeSearch({ value, onChange }: Props) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder="Search timeframe..."
      autoFocus
      style={{
        width: "100%",
        height: 32,
        background: "rgba(2,6,23,.92)",
        border: "1px solid rgba(148,163,184,.24)",
        borderRadius: 9,
        color: "#e5e7eb",
        outline: "none",
        padding: "0 10px",
        fontSize: 12,
        fontWeight: 800,
        boxSizing: "border-box",
      }}
    />
  );
}
