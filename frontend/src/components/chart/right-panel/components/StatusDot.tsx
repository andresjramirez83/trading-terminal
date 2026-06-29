export type StatusTone = "good" | "warn" | "bad" | "neutral";

export function getToneColor(tone: StatusTone) {
  if (tone === "good") return "#22c55e";
  if (tone === "warn") return "#eab308";
  if (tone === "bad") return "#ef4444";
  return "#64748b";
}

export default function StatusDot({ tone }: { tone: StatusTone }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: 999,
        background: getToneColor(tone),
        boxShadow: `0 0 10px ${getToneColor(tone)}66`,
        flexShrink: 0,
      }}
    />
  );
}