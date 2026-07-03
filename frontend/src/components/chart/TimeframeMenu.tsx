// src/components/ChartPanelV2/TimeframeMenu.tsx

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import TimeframeSearch from "./TimeframeSearch";
import {
  TIMEFRAME_GROUPS,
  TIMEFRAME_OPTIONS,
  getTimeframeOption,
  normalizeTimeframeId,
  type TimeframeOption,
} from "./TimeframeRegistry";
import { toggleTimeframeFavorite } from "./TimeframeFavorites";

type Props = {
  open: boolean;
  activeTimeframe: string;
  favorites: string[];
  onClose: () => void;
  onSelect: (timeframe: string) => void;
  onFavoritesChange: (favorites: string[]) => void;
};

function optionMatches(option: TimeframeOption, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return option.search.includes(normalized) || option.label.toLowerCase().includes(normalized);
}

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div style={{ marginTop: 12 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          color: "#93a4bb",
          fontSize: 10,
          fontWeight: 950,
          letterSpacing: 1.1,
          textTransform: "uppercase",
          marginBottom: 7,
        }}
      >
        <span>{title}</span>
        <span style={{ height: 1, flex: 1, background: "rgba(148,163,184,.16)" }} />
      </div>
      {children}
    </div>
  );
}

export default function TimeframeMenu({
  open,
  activeTimeframe,
  favorites,
  onClose,
  onSelect,
  onFavoritesChange,
}: Props) {
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeId = normalizeTimeframeId(activeTimeframe);

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: MouseEvent) {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(event.target as Node)) onClose();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const favoriteOptions = useMemo(
    () => favorites.map((id) => getTimeframeOption(id)).filter(Boolean) as TimeframeOption[],
    [favorites]
  );

  if (!open) return null;

  const renderOption = (option: TimeframeOption) => {
    const active = option.id === activeId;
    const favorite = favorites.includes(option.id);

    return (
      <button
        type="button"
        key={option.id}
        onClick={() => {
          onSelect(option.id);
          onClose();
        }}
        style={{
          width: "100%",
          height: 34,
          display: "grid",
          gridTemplateColumns: "26px 1fr 30px",
          alignItems: "center",
          gap: 8,
          border: active ? "1px solid rgba(56,189,248,.55)" : "1px solid transparent",
          borderRadius: 9,
          background: active ? "rgba(14,165,233,.16)" : "transparent",
          color: active ? "#e0f2fe" : "#dbe4ef",
          cursor: "pointer",
          padding: "0 8px",
          textAlign: "left",
        }}
      >
        <span style={{ color: active ? "#38bdf8" : "rgba(148,163,184,.55)", fontWeight: 950 }}>
          {active ? "✓" : ""}
        </span>
        <span style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontSize: 12, fontWeight: 900 }}>{option.label}</span>
          <span style={{ fontSize: 10, color: "#7f8ea3", fontWeight: 950 }}>{option.shortLabel}</span>
        </span>
        <span
          role="button"
          tabIndex={0}
          title={favorite ? "Remove favorite" : "Add favorite"}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onFavoritesChange(toggleTimeframeFavorite(favorites, option.id));
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            onFavoritesChange(toggleTimeframeFavorite(favorites, option.id));
          }}
          style={{
            justifySelf: "end",
            width: 24,
            height: 24,
            borderRadius: 999,
            display: "grid",
            placeItems: "center",
            color: favorite ? "#fbbf24" : "#64748b",
            fontSize: 14,
            fontWeight: 950,
          }}
        >
          {favorite ? "★" : "☆"}
        </span>
      </button>
    );
  };

  const hasQuery = query.trim().length > 0;

  return (
    <div
      ref={menuRef}
      style={{
        position: "absolute",
        top: 38,
        left: 108,
        width: 310,
        maxHeight: "min(620px, calc(100vh - 70px))",
        overflowY: "auto",
        padding: 12,
        background: "linear-gradient(180deg, rgba(15,23,42,.98), rgba(2,6,23,.98))",
        border: "1px solid rgba(148,163,184,.22)",
        boxShadow: "0 18px 55px rgba(0,0,0,.48), inset 0 1px 0 rgba(255,255,255,.06)",
        borderRadius: 14,
        zIndex: 1000,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ color: "#e5e7eb", fontSize: 13, fontWeight: 950 }}>Timeframes</div>
        <button
          type="button"
          onClick={onClose}
          style={{
            border: "1px solid rgba(148,163,184,.18)",
            background: "rgba(15,23,42,.85)",
            color: "#94a3b8",
            width: 26,
            height: 26,
            borderRadius: 8,
            cursor: "pointer",
            fontWeight: 950,
          }}
        >
          ×
        </button>
      </div>

      <TimeframeSearch value={query} onChange={setQuery} />

      {!hasQuery && (
        <Section title="Favorites">
          <div style={{ display: "grid", gap: 3 }}>{favoriteOptions.map(renderOption)}</div>
        </Section>
      )}

      {TIMEFRAME_GROUPS.map((group) => {
        const options = TIMEFRAME_OPTIONS.filter((option) => option.group === group && optionMatches(option, query));
        if (!options.length) return null;

        return (
          <Section key={group} title={hasQuery ? `${group} results` : group}>
            <div style={{ display: "grid", gap: 3 }}>{options.map(renderOption)}</div>
          </Section>
        );
      })}
    </div>
  );
}
