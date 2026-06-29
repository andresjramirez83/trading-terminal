import StatusDot, { type StatusTone, getToneColor } from "./StatusDot";

export type StatusGridItem = {
  label: string;
  value: string;
  tone: StatusTone;
};

export default function StatusGrid({
  items,
}: {
  items: StatusGridItem[];
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 10,
      }}
    >
      {items.map((item) => (
        <div
          key={item.label}
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",

            minHeight: 62,

            padding: 10,

            borderRadius: 10,

            background:
              "linear-gradient(180deg, rgba(255,255,255,.035), rgba(255,255,255,.015))",

            border: "1px solid rgba(255,255,255,.06)",

            transition: "all .15s ease",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 8,
            }}
          >
            <div
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: ".05em",
                textTransform: "uppercase",
                color: "#94a3b8",
              }}
            >
              {item.label}
            </div>

            <StatusDot tone={item.tone} />
          </div>

          <div
            style={{
              fontSize: 16,
              fontWeight: 800,
              color: getToneColor(item.tone),
              lineHeight: 1.15,
              fontVariantNumeric: "tabular-nums",
              wordBreak: "break-word",
            }}
          >
            {item.value}
          </div>
        </div>
      ))}
    </div>
  );
}