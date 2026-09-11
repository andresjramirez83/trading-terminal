// src/components/ChartPanelV2/TimeframeSearch.tsx

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
};

export default function TimeframeSearch({ value, onChange, onSubmit }: Props) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" || !onSubmit) return;
        event.preventDefault();
        onSubmit();
      }}
      placeholder="Search or enter custom (e.g. 7m, 3h)..."
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
