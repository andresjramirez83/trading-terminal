import { useEffect, useRef, useState } from "react";
import type { StudyVisibility } from "./ChartTypes";

type Props = {
  visibility: StudyVisibility;
  onChange: (visibility: StudyVisibility) => void;
};

const TOGGLES: { key: keyof StudyVisibility; label: string }[] = [
  { key: "vwap", label: "VWAP" },
  { key: "ema9", label: "EMA 9" },
  { key: "ema20", label: "EMA 20" },
  { key: "ema50", label: "EMA 50" },
  { key: "volume", label: "Volume" },
  { key: "vwap3Expansion", label: "VWAP3 Expansion" },
  { key: "bullishFvg", label: "Bullish Fair Value Gaps" },
  { key: "bearishFvg", label: "Bearish Fair Value Gaps" },
  { key: "marketStructure", label: "Auto Market Structure" },
  { key: "demandZones", label: "Auto Demand Zones" },
];

// MOBILE_STUDIES_PHASE20_REPAIR
export default function ChartStudyToggles({ visibility, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onDocumentPointerDown(event: PointerEvent) {
      if (!wrapperRef.current) return;

      if (!wrapperRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener("pointerdown", onDocumentPointerDown);

    return () => {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
    };
  }, []);

  const activeCount = TOGGLES.filter((item) => visibility[item.key]).length;

  function handleButtonClick(event: React.MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();

    const insideMobileStudiesSheet = Boolean(
      event.currentTarget.closest(".mobile-workspace-sheet--studies"),
    );

    if (insideMobileStudiesSheet) {
      setOpen((value) => !value);
      return;
    }

    const isMobile =
      window.matchMedia("(max-width: 767px)").matches ||
      window.matchMedia(
        "(hover: none) and (pointer: coarse) and (max-width: 1024px)",
      ).matches;

    if (isMobile) {
      setOpen(false);

      window.dispatchEvent(
        new CustomEvent("trading-mobile-workspace", {
          detail: {
            workspace: "studies",
            action: "open",
          },
        }),
      );

      return;
    }

    setOpen((value) => !value);
  }

  return (
    <div
      ref={wrapperRef}
      className="chart-study-toggles"
      style={{
        position: "relative",
        marginLeft: 12,
        flexShrink: 0,
      }}
    >
      <button
        type="button"
        className="chart-study-toggles__button"
        onClick={handleButtonClick}
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
        Studies {activeCount > 0 ? `(${activeCount})` : ""} v
      </button>

      {open && (
        <div
          className="chart-study-toggles__menu"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          style={{
            position: "absolute",
            top: 34,
            right: 0,
            minWidth: 230,
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
                  minHeight: 34,
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
