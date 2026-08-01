// src/components/chart/right-panel/widgets/MarketStoryWidget.tsx

import PanelCard from "../components/PanelCard";
import { useDecisionCenter } from "../DecisionCenterContext";

function confidencePercent(value: number | undefined): number {
  if (!Number.isFinite(value)) return 0;

  const normalized = value as number;
  return Math.round(
    Math.max(0, Math.min(100, normalized <= 1 ? normalized * 100 : normalized)),
  );
}

function confidenceColor(value: number): string {
  if (value >= 70) return "#22c55e";
  if (value >= 45) return "#f59e0b";
  return "#94a3b8";
}

function displayStatus(
  status: string,
  isEvaluating: boolean,
): string {
  if (isEvaluating) return "evaluating";
  return status || "idle";
}

function Thesis({
  label,
  text,
  tone,
}: {
  label: string;
  text: string;
  tone: "bullish" | "bearish";
}) {
  const color = tone === "bullish" ? "#22c55e" : "#ef4444";

  return (
    <div
      style={{
        padding: 10,
        borderRadius: 10,
        background: "rgba(255,255,255,0.035)",
        border: `1px solid ${color}33`,
      }}
    >
      <div
        style={{
          marginBottom: 5,
          fontSize: 10,
          fontWeight: 850,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          color,
        }}
      >
        {label}
      </div>

      <div
        style={{
          fontSize: 11,
          lineHeight: 1.5,
          color: "#cbd5e1",
        }}
      >
        {text}
      </div>
    </div>
  );
}

export default function MarketStoryWidget() {
  const {
    marketStory,
    memory,
    status,
    error,
    isEvaluating,
  } = useDecisionCenter();

  const confidence = confidencePercent(marketStory?.confidence);
  const eventCount = memory?.events.length ?? 0;
  const sequenceCount = memory?.activeSequences.length ?? 0;
  const currentStatus = displayStatus(status, isEvaluating);
  const keyEvents = marketStory?.keyEvents ?? [];

  return (
    <PanelCard title="Market Story">
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {error ? (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              border: "1px solid rgba(239,68,68,0.35)",
              background: "rgba(239,68,68,0.08)",
              color: "#fca5a5",
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            {error}
          </div>
        ) : null}

        <div
          style={{
            padding: "12px 11px",
            borderRadius: 11,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(56,189,248,0.22)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
              marginBottom: 7,
            }}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 900,
                lineHeight: 1.25,
                color: "#f8fafc",
              }}
            >
              {marketStory?.headline ??
                (isEvaluating
                  ? "Evaluating Market Context"
                  : "Waiting for Market Context")}
            </div>

            <div
              style={{
                flexShrink: 0,
                padding: "4px 7px",
                borderRadius: 999,
                background: `${confidenceColor(confidence)}18`,
                border: `1px solid ${confidenceColor(confidence)}44`,
                color: confidenceColor(confidence),
                fontSize: 10,
                fontWeight: 900,
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {confidence}%
            </div>
          </div>

          <div
            style={{
              fontSize: 11,
              lineHeight: 1.55,
              color: "#cbd5e1",
            }}
          >
            {marketStory?.summary ??
              "The intelligence engine will build the market story as meaningful events develop."}
          </div>
        </div>

        <div
          style={{
            height: 7,
            borderRadius: 999,
            overflow: "hidden",
            background: "rgba(255,255,255,0.07)",
          }}
        >
          <div
            style={{
              width: `${confidence}%`,
              height: "100%",
              borderRadius: 999,
              background: confidenceColor(confidence),
              transition: "width 160ms ease",
            }}
          />
        </div>

        <Thesis
          label="Bullish Thesis"
          tone="bullish"
          text={
            marketStory?.bullishThesis ??
            "No strong bullish evidence has developed."
          }
        />

        <Thesis
          label="Bearish Thesis"
          tone="bearish"
          text={
            marketStory?.bearishThesis ??
            "No strong bearish evidence has developed."
          }
        />

        {keyEvents.length > 0 ? (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div
              style={{
                marginBottom: 7,
                fontSize: 10,
                fontWeight: 850,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: "#94a3b8",
              }}
            >
              Latest Events
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
              {keyEvents
                .slice(-4)
                .reverse()
                .map((event, index) => (
                  <div
                    key={`${event}-${index}`}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "6px 1fr",
                      gap: 7,
                      alignItems: "start",
                      fontSize: 10.5,
                      lineHeight: 1.4,
                      color: "#cbd5e1",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        marginTop: 4,
                        borderRadius: 999,
                        background: "#38bdf8",
                      }}
                    />
                    <span>{event}</span>
                  </div>
                ))}
            </div>
          </div>
        ) : null}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 7,
          }}
        >
          <Stat label="Status" value={currentStatus} />
          <Stat label="Events" value={String(eventCount)} />
          <Stat label="Sequences" value={String(sequenceCount)} />
        </div>
      </div>
    </PanelCard>
  );
}

function Stat({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div
      style={{
        minWidth: 0,
        padding: 8,
        borderRadius: 9,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div
        style={{
          marginBottom: 4,
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "#64748b",
        }}
      >
        {label}
      </div>

      <div
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 11,
          fontWeight: 850,
          color: "#e2e8f0",
          textTransform: label === "Status" ? "capitalize" : undefined,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}
