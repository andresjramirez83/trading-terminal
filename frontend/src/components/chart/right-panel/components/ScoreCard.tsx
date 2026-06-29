import PanelCard from "./PanelCard";
import { type StatusTone, getToneColor } from "./StatusDot";

export default function ScoreCard({
  title,
  score,
  subtitle,
  badge,
  tone = "good",
}: {
  title: string;
  score: number | string;
  subtitle: string;
  badge?: string;
  tone?: StatusTone;
}) {
  const color = getToneColor(tone);

  return (
    <PanelCard title={title}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 28, fontWeight: 950, color, lineHeight: 1 }}>
            {score}
          </div>

          <div style={{ marginTop: 5, fontSize: 12, color: "#94a3b8" }}>
            {subtitle}
          </div>
        </div>

        {badge && (
          <div
            style={{
              borderRadius: 999,
              padding: "4px 8px",
              background: `${color}22`,
              color,
              fontSize: 11,
              fontWeight: 900,
              whiteSpace: "nowrap",
            }}
          >
            {badge}
          </div>
        )}
      </div>
    </PanelCard>
  );
}