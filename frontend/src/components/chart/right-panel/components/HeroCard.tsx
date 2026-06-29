import PanelCard from "./PanelCard";
import StatusDot, { type StatusTone, getToneColor } from "./StatusDot";

export type HeroCardItem = {
  label: string;
  tone: StatusTone;
};

export default function HeroCard({
  title,
  score,
  status,
  items,
}: {
  title: string;
  score: number;
  status: string;
  items: HeroCardItem[];
}) {
  const tone: StatusTone = score >= 80 ? "good" : score >= 60 ? "warn" : "bad";
  const color = getToneColor(tone);

  return (
    <PanelCard title={title}>
      <div style={{ textAlign: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 34, fontWeight: 950, color, lineHeight: 1 }}>
          {score}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            fontWeight: 900,
            color,
            textTransform: "uppercase",
            letterSpacing: ".08em",
          }}
        >
          {status}
        </div>
      </div>

      <div
        style={{
          height: 7,
          borderRadius: 999,
          background: "#020617",
          overflow: "hidden",
          marginBottom: 11,
        }}
      >
        <div
          style={{
            width: `${score}%`,
            height: "100%",
            borderRadius: 999,
            background: color,
          }}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {items.map((item) => (
          <div
            key={item.label}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: 12,
            }}
          >
            <span style={{ color: "#e5e7eb" }}>{item.label}</span>
            <StatusDot tone={item.tone} />
          </div>
        ))}
      </div>
    </PanelCard>
  );
}