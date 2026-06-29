export default function PanelCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      style={{
        position: "relative",
        overflow: "hidden",

        background: "linear-gradient(180deg, #1e293b 0%, #111827 100%)",
        border: "1px solid rgba(255,255,255,0.08)",
        borderRadius: 14,

        padding: 12,
        marginBottom: 10,

        boxShadow:
          "0 1px 2px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.03)",
      }}
    >
      {/* Top Accent */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background:
            "linear-gradient(90deg,#22c55e,#38bdf8,#a855f7,#f59e0b)",
          opacity: 0.75,
        }}
      />

      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: "#cbd5e1",
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {title}
        </div>
      </div>

      {/* Content */}
      <div>{children}</div>
    </section>
  );
}