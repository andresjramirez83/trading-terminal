import { useEffect, useRef, useState } from "react";
import type { StudyVisibility } from "../../chart/ChartTypes";

type Props = {
  visibility: StudyVisibility;
  onChange: (visibility: StudyVisibility) => void;
};

const TOGGLES: { key: keyof StudyVisibility; label: string }[] = [
  { key: "vwap", label: "VWAP" },
  { key: "ema9", label: "EMA 9" },
  { key: "ema20", label: "EMA 20" },
  { key: "volume", label: "Volume" },
];

export default function ChartStudyToggles({ visibility, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocumentMouseDown(event: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("mousedown", onDocumentMouseDown);

    return () => {
      document.removeEventListener("mousedown", onDocumentMouseDown);
    };
  }, []);

  const activeCount = TOGGLES.filter((item) => visibility[item.key]).length;

  return (
    <div
      ref={wrapperRef}
      style={{
        position: "relative",
        marginLeft: 12,
        flexShrink: 0,
      }}
    >
      <button
        onClick={() => setOpen((value) => !value)}
        style={{
          height: 28,
          padding: "0 10px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,.14)",
          background: "#0f1115",
          color: "white",
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
        }}
      >
        Studies {activeCount > 0 ? `(${activeCount})` : ""} ▾
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: 34,
            right: 0,
            minWidth: 160,
            padding: 8,
            borderRadius: 8,
            background: "#111827",
            border: "1px solid rgba(255,255,255,.14)",
            boxShadow: "0 12px 30px rgba(0,0,0,.45)",
            zIndex: 100,
          }}
        >
          {TOGGLES.map((item) => {
            const active = visibility[item.key];

            return (
              <label
                key={item.key}
                style={{
                  height: 30,
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  color: "#e5e7eb",
                  fontSize: 13,
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                <input
                  type="checkbox"
                  checked={active}
                  onChange={() =>
                    onChange({
                      ...visibility,
                      [item.key]: !active,
                    })
                  }
                />
                <span>{item.label}</span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}