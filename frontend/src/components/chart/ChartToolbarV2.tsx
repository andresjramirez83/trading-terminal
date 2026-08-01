// src/components/chart/ChartToolbarV2.tsx

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Link, useLocation } from "react-router-dom";
import type {
  CrosshairInfo,
  LiveStatus,
  StudyVisibility,
} from "../chart/ChartTypes";
import type {
  MarketDataMode,
  ReplaySnapshot,
  ReplaySpeed,
} from "../../trading/replay/ReplayTypes";
import CrosshairInfoBox from "./CrosshairInfoBox";
import ChartStudyToggles from "./ChartStudyToggles";
import TimeframeButton from "./TimeframeButton";
import TimeframeMenu from "./TimeframeMenu";
import {
  loadTimeframeFavorites,
  saveTimeframeFavorites,
} from "./TimeframeFavorites";
import {
  getTimeframeOption,
  getTimeframeShortLabel,
  normalizeTimeframeId,
} from "./TimeframeRegistry";

const REPLAY_SPEEDS: ReplaySpeed[] = [
  0.25,
  0.5,
  1,
  2,
  5,
  10,
  25,
  50,
  100,
];

type Props = {
  symbol: string;
  timeframe: string;
  liveStatus: LiveStatus;
  crosshairInfo: CrosshairInfo | null;
  studyVisibility: StudyVisibility;

  marketDataMode: MarketDataMode;
  replaySnapshot: ReplaySnapshot;
  practiceTradingDate: string;

  onSymbolChange: (symbol: string) => void;
  onTimeframeChange: (timeframe: string) => void;
  onStudyVisibilityChange: (visibility: StudyVisibility) => void;

  onMarketDataModeChange: (mode: MarketDataMode) => void;
  onReplayPlay: () => void;
  onReplayPause: () => void;
  onReplayReset: () => void;
  onReplayStepBackward: () => void;
  onReplayStepForward: () => void;
  onReplaySeek: (index: number) => void;
  onReplaySpeedChange: (speed: ReplaySpeed) => void;
  onPracticeTradingDateChange: (tradingDate: string) => void;
};

const compactButton: CSSProperties = {
  height: 27,
  minWidth: 28,
  padding: "0 8px",
  borderRadius: 7,
  border: "1px solid rgba(148,163,184,.22)",
  background: "#080c13",
  color: "#e2e8f0",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 900,
  lineHeight: 1,
  flexShrink: 0,
};

function formatReplayTime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "Waiting for data";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(value * 1000));
}

export default function ChartToolbarV2({
  symbol,
  timeframe,
  liveStatus,
  crosshairInfo,
  studyVisibility,
  marketDataMode,
  replaySnapshot,
  practiceTradingDate,
  onSymbolChange,
  onTimeframeChange,
  onStudyVisibilityChange,
  onMarketDataModeChange,
  onReplayPlay,
  onReplayPause,
  onReplayReset,
  onReplayStepBackward,
  onReplayStepForward,
  onReplaySeek,
  onReplaySpeedChange,
  onPracticeTradingDateChange,
}: Props) {
  const location = useLocation();
  const onScanner = location.pathname === "/scanner";
  const isConnected =
    liveStatus === "live" || liveStatus === "connected";
  const isReplay = marketDataMode === "replay";
  const isPlaying = replaySnapshot.state === "playing";
  const replayReady =
    replaySnapshot.bars.length > 0 &&
    replaySnapshot.state !== "loading";

  const [menuOpen, setMenuOpen] = useState(false);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const modeMenuRef = useRef<HTMLDivElement | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() =>
    loadTimeframeFavorites(),
  );

  const activeId = normalizeTimeframeId(timeframe);
  const maxReplayIndex = Math.max(
    0,
    replaySnapshot.bars.length - 1,
  );

  useEffect(() => {
    saveTimeframeFavorites(favorites);
  }, [favorites]);

  useEffect(() => {
    function handleDocumentPointerDown(event: PointerEvent) {
      if (
        modeMenuRef.current &&
        !modeMenuRef.current.contains(event.target as Node)
      ) {
        setModeMenuOpen(false);
      }
    }

    document.addEventListener(
      "pointerdown",
      handleDocumentPointerDown,
    );

    return () => {
      document.removeEventListener(
        "pointerdown",
        handleDocumentPointerDown,
      );
    };
  }, []);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        event.target instanceof HTMLSelectElement
      ) {
        return;
      }

      const value = Number(event.key);
      if (!Number.isInteger(value) || value < 1 || value > 9) {
        return;
      }

      const target = favorites[value - 1];
      if (!target) return;

      onTimeframeChange(target);
    }

    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [favorites, onTimeframeChange]);

  const favoriteOptions = useMemo(
    () =>
      favorites
        .map((id) => getTimeframeOption(id))
        .filter(Boolean),
    [favorites],
  );

  function handleTimeframeChange(nextTimeframe: string) {
    onTimeframeChange(normalizeTimeframeId(nextTimeframe));
  }

  function selectMode(mode: MarketDataMode) {
    setModeMenuOpen(false);
    onMarketDataModeChange(mode);
  }

  return (
    <div
      style={{
        position: "relative",
        height: 42,
        display: "flex",
        alignItems: "center",
        gap: 7,
        padding: "0 10px",
        background:
          "linear-gradient(180deg, #171b22 0%, #11151b 100%)",
        borderBottom: "1px solid rgba(255,255,255,.08)",
        color: "#e5e7eb",
        flexShrink: 0,
        zIndex: 30,
        overflow: "visible",
      }}
    >
      <input
        value={symbol}
        onChange={(event) =>
          onSymbolChange(event.target.value.toUpperCase())
        }
        style={{
          width: 82,
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
            title={`${option.label} • shortcut ${
              favorites.indexOf(option.id) + 1
            }`}
            active={active}
            onClick={() =>
              handleTimeframeChange(option.id)
            }
          />
        );
      })}

      <button
        type="button"
        onClick={() =>
          setMenuOpen((current) => !current)
        }
        title="More timeframes"
        style={{
          height: 28,
          padding: "0 10px",
          borderRadius: 7,
          border: menuOpen
            ? "1px solid rgba(56,189,248,.55)"
            : "1px solid rgba(255,255,255,.11)",
          background: menuOpen
            ? "rgba(14,165,233,.16)"
            : "#080c13",
          color: "white",
          cursor: "pointer",
          fontWeight: 950,
          flexShrink: 0,
          lineHeight: 1,
        }}
      >
        {getTimeframeOption(activeId)
          ? "More ▾"
          : `${getTimeframeShortLabel(activeId)} ▾`}
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

      <ChartStudyToggles
        visibility={studyVisibility}
        onChange={onStudyVisibilityChange}
      />

      <div style={{ flex: 1, minWidth: 8 }} />

      {isReplay ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            minWidth: 0,
            padding: "3px 6px",
            borderRadius: 9,
            border: "1px solid rgba(59,130,246,.25)",
            background: "rgba(15,23,42,.66)",
            boxShadow:
              "inset 0 1px 0 rgba(255,255,255,.035)",
          }}
        >
          <button
            type="button"
            style={compactButton}
            disabled={!replayReady}
            onClick={onReplayStepBackward}
            title="Previous candle"
          >
            ◀
          </button>

          <button
            type="button"
            style={{
              ...compactButton,
              minWidth: 52,
              color: isPlaying ? "#fca5a5" : "#86efac",
              borderColor: isPlaying
                ? "rgba(239,68,68,.34)"
                : "rgba(34,197,94,.34)",
            }}
            disabled={!replayReady}
            onClick={
              isPlaying
                ? onReplayPause
                : onReplayPlay
            }
          >
            {isPlaying ? "Pause" : "Play"}
          </button>

          <button
            type="button"
            style={compactButton}
            disabled={!replayReady}
            onClick={onReplayStepForward}
            title="Next candle"
          >
            ▶
          </button>

          <button
            type="button"
            style={{
              ...compactButton,
              padding: "0 7px",
              color: "#94a3b8",
            }}
            disabled={!replayReady}
            onClick={onReplayReset}
          >
            Reset
          </button>

          <select
            value={replaySnapshot.speed}
            onChange={(event) =>
              onReplaySpeedChange(
                Number(event.target.value) as ReplaySpeed,
              )
            }
            title="Replay speed"
            style={{
              ...compactButton,
              minWidth: 58,
              appearance: "auto",
              padding: "0 5px",
            }}
          >
            {REPLAY_SPEEDS.map((speed) => (
              <option key={speed} value={speed}>
                {speed}x
              </option>
            ))}
          </select>

          <input
            type="range"
            min={0}
            max={maxReplayIndex}
            value={Math.min(
              replaySnapshot.currentIndex,
              maxReplayIndex,
            )}
            disabled={!replayReady}
            onChange={(event) =>
              onReplaySeek(Number(event.target.value))
            }
            aria-label="Replay timeline"
            title="Replay timeline"
            style={{
              width: 122,
              minWidth: 70,
              accentColor: "#38bdf8",
              cursor: replayReady ? "pointer" : "default",
            }}
          />

          <input
            type="date"
            value={practiceTradingDate}
            onChange={(event) =>
              onPracticeTradingDateChange(event.target.value)
            }
            title="Replay trading date"
            aria-label="Replay trading date"
            style={{
              ...compactButton,
              width: 126,
              minWidth: 126,
              padding: "0 7px",
              colorScheme: "dark",
              color: "#bfdbfe",
              borderColor: "rgba(59,130,246,.42)",
              background: "#080c13",
            }}
          />

          <span
            title={
              replaySnapshot.bars.length
                ? `${replaySnapshot.currentIndex + 1} of ${
                    replaySnapshot.bars.length
                  } candles`
                : "Replay data"
            }
            style={{
              minWidth: 116,
              maxWidth: 140,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "#bfdbfe",
              fontSize: 10,
              fontWeight: 850,
              letterSpacing: 0.15,
            }}
          >
            {replaySnapshot.state === "loading"
              ? "Loading replay…"
              : formatReplayTime(
                  replaySnapshot.currentTime,
                )}
          </span>
        </div>
      ) : null}

      <div
        ref={modeMenuRef}
        style={{
          position: "relative",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          onClick={() =>
            setModeMenuOpen((current) => !current)
          }
          title="Market data mode"
          style={{
            height: 30,
            padding: "0 11px",
            borderRadius: 999,
            border: isReplay
              ? "1px solid rgba(59,130,246,.62)"
              : isConnected
                ? "1px solid rgba(34,197,94,.55)"
                : "1px solid rgba(245,158,11,.55)",
            background: isReplay
              ? "rgba(37,99,235,.20)"
              : isConnected
                ? "rgba(34,197,94,.14)"
                : "rgba(245,158,11,.14)",
            color: isReplay
              ? "#93c5fd"
              : isConnected
                ? "#4ade80"
                : "#fbbf24",
            cursor: "pointer",
            fontSize: 10,
            fontWeight: 950,
            letterSpacing: 0.75,
            lineHeight: 1,
          }}
        >
          {isReplay
            ? "REPLAY ▾"
            : isConnected
              ? "LIVE ▾"
              : "CONNECTING ▾"}
        </button>

        {modeMenuOpen ? (
          <div
            style={{
              position: "absolute",
              top: 35,
              right: 0,
              width: 154,
              padding: 6,
              borderRadius: 9,
              border:
                "1px solid rgba(148,163,184,.22)",
              background: "rgba(8,12,19,.98)",
              boxShadow:
                "0 16px 38px rgba(0,0,0,.48)",
              zIndex: 100,
            }}
          >
            <button
              type="button"
              onClick={() => selectMode("live")}
              style={{
                ...compactButton,
                width: "100%",
                height: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                border: "none",
                background:
                  marketDataMode === "live"
                    ? "rgba(34,197,94,.14)"
                    : "transparent",
                color:
                  marketDataMode === "live"
                    ? "#86efac"
                    : "#cbd5e1",
              }}
            >
              <span>Live market</span>
              <span>
                {marketDataMode === "live" ? "●" : ""}
              </span>
            </button>

            <button
              type="button"
              onClick={() => selectMode("replay")}
              style={{
                ...compactButton,
                width: "100%",
                height: 34,
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                border: "none",
                background:
                  marketDataMode === "replay"
                    ? "rgba(59,130,246,.16)"
                    : "transparent",
                color:
                  marketDataMode === "replay"
                    ? "#93c5fd"
                    : "#cbd5e1",
              }}
            >
              <span>Trade replay</span>
              <span>
                {marketDataMode === "replay" ? "●" : ""}
              </span>
            </button>

            <div
              style={{
                marginTop: 4,
                padding: "7px 9px 3px",
                borderTop:
                  "1px solid rgba(148,163,184,.12)",
                color: "#64748b",
                fontSize: 9,
                fontWeight: 800,
              }}
            >
              Practice mode coming next
            </div>
          </div>
        ) : null}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 3,
          padding: 3,
          borderRadius: 999,
          background: "rgba(2,6,23,.96)",
          border: "1px solid rgba(56,189,248,.22)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,.07)",
          flexShrink: 0,
        }}
      >
        <Link
          to="/chart"
          style={{
            padding: "7px 13px",
            borderRadius: 999,
            textDecoration: "none",
            fontSize: 11,
            fontWeight: 950,
            color: !onScanner ? "#031525" : "#cbd5e1",
            background: !onScanner
              ? "linear-gradient(180deg, #67e8f9 0%, #38bdf8 100%)"
              : "transparent",
            boxShadow: !onScanner
              ? "0 0 14px rgba(56,189,248,.2)"
              : "none",
            lineHeight: 1,
          }}
        >
          Chart
        </Link>

        <Link
          to="/scanner"
          style={{
            padding: "7px 13px",
            borderRadius: 999,
            textDecoration: "none",
            fontSize: 11,
            fontWeight: 950,
            color: onScanner ? "#031525" : "#cbd5e1",
            background: onScanner
              ? "linear-gradient(180deg, #67e8f9 0%, #38bdf8 100%)"
              : "transparent",
            boxShadow: onScanner
              ? "0 0 14px rgba(56,189,248,.2)"
              : "none",
            lineHeight: 1,
          }}
        >
          Scanner
        </Link>
      </div>
    </div>
  );
}