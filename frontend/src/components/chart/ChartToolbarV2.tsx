// src/components/ChartPanelV2/ChartToolbarV2.tsx

import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { CrosshairInfo, LiveStatus, StudyVisibility } from "../chart/ChartTypes";
import CrosshairInfoBox from "./CrosshairInfoBox";
import ChartStudyToggles from "./ChartStudyToggles";
import TimeframeButton from "./TimeframeButton";
import TimeframeMenu from "./TimeframeMenu";
import { loadTimeframeFavorites, saveTimeframeFavorites } from "./TimeframeFavorites";
import { getTimeframeOption, getTimeframeShortLabel, normalizeTimeframeId } from "./TimeframeRegistry";

type Props = {
  symbol: string;
  timeframe: string;
  liveStatus: LiveStatus;
  crosshairInfo: CrosshairInfo | null;
  studyVisibility: StudyVisibility;
  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (timeframe: string) => void;
  onStudyVisibilityChange: (visibility: StudyVisibility) => void;
};

export default function ChartToolbarV2({
  symbol,
  timeframe,
  liveStatus,
  crosshairInfo,
  studyVisibility,
  onSymbolChange,
  onTimeframeChange,
  onStudyVisibilityChange,
}: Props) {
  const location = useLocation();
  const onScanner = location.pathname === "/scanner";
  const isLive = liveStatus === "live" || liveStatus === "connected";
  const [menuOpen, setMenuOpen] = useState(false);
  const [favorites, setFavorites] = useState<string[]>(() => loadTimeframeFavorites());

  const activeId = normalizeTimeframeId(timeframe);

  useEffect(() => {
    saveTimeframeFavorites(favorites);
  }, [favorites]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

      const value = Number(event.key);
      if (!Number.isInteger(value) || value < 1 || value > 9) return;

      const target = favorites[value - 1];
      if (!target) return;
      onTimeframeChange(target);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [favorites, onTimeframeChange]);

  const favoriteOptions = useMemo(
    () => favorites.map((id) => getTimeframeOption(id)).filter(Boolean),
    [favorites]
  );

  function handleTimeframeChange(nextTimeframe: string) {
    onTimeframeChange(normalizeTimeframeId(nextTimeframe));
  }

  return (
    <div
      style={{
        position: "relative",
        height: 42,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "0 10px",
        background: "linear-gradient(180deg, #171b22 0%, #11151b 100%)",
        borderBottom: "1px solid rgba(255,255,255,.08)",
        color: "#e5e7eb",
        flexShrink: 0,
        zIndex: 30,
        overflow: "visible",
      }}
    >
      <input
        value={symbol}
        onChange={(e) => onSymbolChange(e.target.value.toUpperCase())}
        style={{
          width: 90,
          height: 28,
          background: "#070b12",
          color: "white",
          border: "1px solid rgba(148,163,184,.28)",
          borderRadius: 7,
          padding: "0 9px",
          fontWeight: 900,
          flexShrink: 0,
          outline: "none",
        }}
      />

      {favoriteOptions.map((option) => {
        if (!option) return null;
        const active = activeId === option.id;

        return (
          <TimeframeButton
            key={option.id}
            label={option.shortLabel}
            title={`${option.label}  •  shortcut ${favorites.indexOf(option.id) + 1}`}
            active={active}
            onClick={() => handleTimeframeChange(option.id)}
          />
        );
      })}

      <button
        type="button"
        onClick={() => setMenuOpen((current) => !current)}
        title="More timeframes"
        style={{
          height: 28,
          padding: "0 10px",
          borderRadius: 7,
          border: menuOpen ? "1px solid rgba(56,189,248,.55)" : "1px solid rgba(255,255,255,.11)",
          background: menuOpen ? "rgba(14,165,233,.16)" : "#080c13",
          color: "white",
          cursor: "pointer",
          fontWeight: 950,
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        {getTimeframeOption(activeId) ? "More ▾" : `${getTimeframeShortLabel(activeId)} ▾`}
      </button>

      <TimeframeMenu
        open={menuOpen}
        activeTimeframe={timeframe}
        favorites={favorites}
        onClose={() => setMenuOpen(false)}
        onSelect={handleTimeframeChange}
        onFavoritesChange={setFavorites}
      />

      <CrosshairInfoBox info={crosshairInfo} />

      <ChartStudyToggles visibility={studyVisibility} onChange={onStudyVisibilityChange} />

      <div style={{ flex: 1 }} />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: 3,
          borderRadius: 999,
          background: "rgba(2,6,23,.96)",
          border: "1px solid rgba(56,189,248,.26)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,.07)",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            padding: "7px 12px",
            borderRadius: 999,
            background: isLive ? "rgba(34,197,94,.16)" : "rgba(245,158,11,.14)",
            border: isLive ? "1px solid rgba(34,197,94,.55)" : "1px solid rgba(245,158,11,.55)",
            color: isLive ? "#4ade80" : "#fbbf24",
            fontSize: 11,
            fontWeight: 950,
            letterSpacing: 0.7,
            lineHeight: 1,
          }}
        >
          {isLive ? "LIVE" : "CONNECTING"}
        </span>

        <Link
          to="/chart"
          style={{
            padding: "7px 15px",
            borderRadius: 999,
            textDecoration: "none",
            fontSize: 12,
            fontWeight: 950,
            color: !onScanner ? "#031525" : "#cbd5e1",
            background: !onScanner ? "linear-gradient(180deg, #67e8f9 0%, #38bdf8 100%)" : "transparent",
            boxShadow: !onScanner ? "0 0 14px rgba(56,189,248,.2)" : "none",
            lineHeight: 1,
          }}
        >
          Chart
        </Link>

        <Link
          to="/scanner"
          style={{
            padding: "7px 15px",
            borderRadius: 999,
            textDecoration: "none",
            fontSize: 12,
            fontWeight: 950,
            color: onScanner ? "#031525" : "#cbd5e1",
            background: onScanner ? "linear-gradient(180deg, #67e8f9 0%, #38bdf8 100%)" : "transparent",
            boxShadow: onScanner ? "0 0 14px rgba(56,189,248,.2)" : "none",
            lineHeight: 1,
          }}
        >
          Scanner
        </Link>
      </div>
    </div>
  );
}
