// src/trading/replay/ReplayControls.tsx

import type {
  MarketDataMode,
  ReplaySnapshot,
  ReplaySpeed,
} from "./ReplayTypes";

const SPEEDS: ReplaySpeed[] = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];

interface ReplayControlsProps {
  mode: MarketDataMode;
  snapshot: ReplaySnapshot;
  onModeChange: (mode: MarketDataMode) => void;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onStepBackward: () => void;
  onStepForward: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speed: ReplaySpeed) => void;
}

function formatReplayTime(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";

  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value * 1000));
}


function formatStartMode(
  startMode:
    | NonNullable<ReplaySnapshot["session"]>["startMode"]
    | undefined,
): string {
  switch (startMode) {
    case "previous-close":
      return "Previous Close";
    case "after-hours":
      return "After Hours";
    case "overnight":
      return "Overnight";
    case "premarket":
      return "Premarket";
    case "seven-am-pacific":
      return "7:00 AM Pacific";
    case "custom":
      return "Custom Time";
    case "market-open":
    default:
      return "Market Open";
  }
}

const buttonStyle: React.CSSProperties = {
  border: "1px solid rgba(148,163,184,.25)",
  background: "rgba(30,41,59,.72)",
  color: "#e2e8f0",
  borderRadius: 6,
  minHeight: 28,
  padding: "4px 9px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 700,
};

export default function ReplayControls({
  mode,
  snapshot,
  onModeChange,
  onPlay,
  onPause,
  onReset,
  onStepBackward,
  onStepForward,
  onSeek,
  onSpeedChange,
}: ReplayControlsProps) {
  const isReplay = mode === "replay";
  const maxIndex = Math.max(0, snapshot.bars.length - 1);
  const isPlaying = snapshot.state === "playing";
  const controlsDisabled =
    !isReplay ||
    snapshot.state === "loading" ||
    snapshot.bars.length === 0;

  const session = snapshot.session ?? null;

  return (
    <div
      style={{
        minHeight: 40,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 10px",
        borderBottom: "1px solid rgba(148,163,184,.16)",
        background: "#0d1013",
        color: "#cbd5e1",
        fontFamily:
          "Inter, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        flexWrap: "wrap",
      }}
    >
      <button
        type="button"
        style={{
          ...buttonStyle,
          background:
            mode === "live"
              ? "rgba(22,163,74,.22)"
              : "rgba(30,41,59,.72)",
          borderColor:
            mode === "live"
              ? "rgba(34,197,94,.55)"
              : "rgba(148,163,184,.25)",
        }}
        onClick={() => onModeChange("live")}
      >
        Live
      </button>

      <button
        type="button"
        style={{
          ...buttonStyle,
          background:
            mode === "replay"
              ? "rgba(37,99,235,.24)"
              : "rgba(30,41,59,.72)",
          borderColor:
            mode === "replay"
              ? "rgba(59,130,246,.65)"
              : "rgba(148,163,184,.25)",
        }}
        onClick={() => onModeChange("replay")}
      >
        Replay
      </button>

      <span
        style={{
          width: 1,
          height: 22,
          background: "rgba(148,163,184,.22)",
          margin: "0 2px",
        }}
      />

      {isReplay && session ? (
        <>
          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: "#bfdbfe",
              border: "1px solid rgba(59,130,246,.28)",
              borderRadius: 6,
              padding: "4px 7px",
              background: "rgba(37,99,235,.1)",
            }}
            title="Selected replay trading date"
          >
            {session.tradingDate}
          </span>

          <span
            style={{
              fontSize: 10,
              fontWeight: 800,
              color: "#cbd5e1",
              border: "1px solid rgba(148,163,184,.22)",
              borderRadius: 6,
              padding: "4px 7px",
              background: "rgba(30,41,59,.55)",
            }}
            title="Replay session start mode"
          >
            {formatStartMode(session.startMode)}
          </span>
        </>
      ) : null}

      <button
        type="button"
        style={buttonStyle}
        disabled={controlsDisabled}
        onClick={isPlaying ? onPause : onPlay}
      >
        {isPlaying ? "Pause" : "Play"}
      </button>

      <button
        type="button"
        style={buttonStyle}
        disabled={controlsDisabled}
        onClick={onStepBackward}
        title="Previous candle"
      >
        ◀
      </button>

      <button
        type="button"
        style={buttonStyle}
        disabled={controlsDisabled}
        onClick={onStepForward}
        title="Next candle"
      >
        ▶
      </button>

      <button
        type="button"
        style={buttonStyle}
        disabled={controlsDisabled}
        onClick={onReset}
      >
        Reset
      </button>

      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        Speed
        <select
          value={snapshot.speed}
          disabled={!isReplay}
          onChange={(event) =>
            onSpeedChange(Number(event.target.value) as ReplaySpeed)
          }
          style={{
            ...buttonStyle,
            minHeight: 28,
            padding: "3px 7px",
          }}
        >
          {SPEEDS.map((speed) => (
            <option key={speed} value={speed}>
              {speed}x
            </option>
          ))}
        </select>
      </label>

      <input
        type="range"
        min={0}
        max={maxIndex}
        value={Math.min(snapshot.currentIndex, maxIndex)}
        disabled={controlsDisabled}
        onChange={(event) => onSeek(Number(event.target.value))}
        style={{
          flex: "1 1 180px",
          minWidth: 140,
          maxWidth: 420,
        }}
        aria-label="Replay position"
      />

      <span
        style={{
          fontSize: 11,
          color: "#94a3b8",
          minWidth: 76,
          textAlign: "right",
        }}
      >
        {snapshot.bars.length
          ? `${snapshot.currentIndex + 1} / ${snapshot.bars.length}`
          : "No data"}
      </span>

      <strong
        style={{
          fontSize: 11,
          color: isReplay ? "#93c5fd" : "#86efac",
          minWidth: 165,
        }}
      >
        {isReplay ? formatReplayTime(snapshot.currentTime) : "Live market data"}
      </strong>

      {snapshot.state === "loading" ? (
        <span style={{ fontSize: 11, color: "#facc15" }}>
          Loading replay…
        </span>
      ) : null}

      {isReplay && session ? (
        <span
          style={{
            fontSize: 10,
            color: "#94a3b8",
            whiteSpace: "nowrap",
          }}
          title="Loaded replay session coverage"
        >
          {[
            session.loadedPreviousRegularSession
              ? "Prev RTH"
              : null,
            session.loadedAfterHours
              ? "AH"
              : null,
            session.loadedOvernight
              ? "Overnight"
              : null,
            session.loadedPremarket
              ? "Premarket"
              : null,
          ]
            .filter(Boolean)
            .join(" • ") || "Selected session"}
        </span>
      ) : null}

      {snapshot.error ? (
        <span style={{ fontSize: 11, color: "#fca5a5" }}>
          {snapshot.error}
        </span>
      ) : null}
    </div>
  );
}