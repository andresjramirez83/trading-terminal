// src/components/chart/right-panel/widgets/MarketObjectsWidget.tsx

import { useEffect, useMemo, useState } from "react";

import {
  marketObjectRegistry,
} from "../../analysis/market-objects/MarketObjectRegistry";
import type {
  MarketObject,
  MarketObjectRegistrySnapshot,
} from "../../analysis/market-objects/MarketObjectTypes";
import PanelCard from "../components/PanelCard";
import { useDecisionCenter } from "../DecisionCenterContext";

const EMPTY_SNAPSHOT: MarketObjectRegistrySnapshot = {
  objects: [],
  relationships: [],
  activeObjectIds: [],
  watchingObjectIds: [],
  updatedAt: 0,
};

function objectLabel(object: MarketObject): string {
  if (object.presentation?.label) return object.presentation.label;

  const labels: Partial<Record<MarketObject["type"], string>> = {
    demandZone: "Demand Zone",
    supplyZone: "Supply Zone",
    fairValueGap: "Fair Value Gap",
    trendline: "Trendline",
    support: "Support",
    resistance: "Resistance",
    liquidityPool: "Liquidity",
    previousDayHigh: "Previous Day High",
    previousDayLow: "Previous Day Low",
    premarketHigh: "Premarket High",
    premarketLow: "Premarket Low",
    sessionHigh: "Session High",
    sessionLow: "Session Low",
    vwap: "VWAP",
    swingHigh: "Swing High",
    swingLow: "Swing Low",
    marketStructureLeg: "Structure Leg",
    newsCatalyst: "News Catalyst",
    customZone: "Custom Zone",
  };

  return labels[object.type] ?? object.type;
}

function biasColor(object: MarketObject): string {
  if (object.bias === "bullish") return "#22c55e";
  if (object.bias === "bearish") return "#ef4444";
  return "#38bdf8";
}

function sameChartTime(left: MarketObject["updatedTime"], right: MarketObject["updatedTime"]): boolean {
  if (left === undefined || right === undefined) return false;
  if (typeof left === "object" || typeof right === "object") {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return left === right;
}

function interactionStatus(object: MarketObject): {
  label: string;
  color: string;
} {
  const latest = object.memory.interactions[object.memory.interactions.length - 1];

  if (object.geometry.kind === "line") {
    const isCurrentCloseCross =
      (latest?.type === "closedAbove" || latest?.type === "closedBelow") &&
      sameChartTime(latest.time, object.updatedTime);

    if (isCurrentCloseCross) {
      return latest.type === "closedAbove"
        ? { label: "Closed Above", color: "#22c55e" }
        : { label: "Closed Below", color: "#ef4444" };
    }

    const side = object.awareness.proximity?.approachSide;
    if (side === "above") {
      return { label: "Holding Above", color: "#22c55e" };
    }
    if (side === "below") {
      return { label: "Holding Below", color: "#ef4444" };
    }
  }

  if (!latest) return { label: object.bias, color: biasColor(object) };

  const labels: Partial<Record<typeof latest.type, string>> = {
    closedAbove: "Closed Above",
    closedBelow: "Closed Below",
    touched: "Touched",
    entered: "At Line",
    wickRejected: "Wick Rejected",
    bodyRejected: "Body Rejected",
    invalidated: "Invalidated",
    leftObject: "Moved Away",
  };

  const label = labels[latest.type];
  if (!label) return { label: object.bias, color: biasColor(object) };
  if (latest.type === "closedAbove") return { label, color: "#22c55e" };
  if (latest.type === "closedBelow" || latest.type === "invalidated") {
    return { label, color: "#ef4444" };
  }
  return { label, color: "#f59e0b" };
}

function proximityText(object: MarketObject): string {
  const proximity = object.awareness.proximity;
  if (!proximity) return object.status;
  if (proximity.isInside) return "Price inside";
  if (proximity.isWithinAwarenessRadius) {
    return `${Math.round(proximity.approachProgress)}% approaching`;
  }
  return `${proximity.distancePercent.toFixed(2)}% away`;
}

function sortObjects(a: MarketObject, b: MarketObject): number {
  const aProximity = a.awareness.proximity;
  const bProximity = b.awareness.proximity;
  const aInside = aProximity?.isInside ? 1 : 0;
  const bInside = bProximity?.isInside ? 1 : 0;
  if (aInside !== bInside) return bInside - aInside;

  const aWatching = aProximity?.isWithinAwarenessRadius ? 1 : 0;
  const bWatching = bProximity?.isWithinAwarenessRadius ? 1 : 0;
  if (aWatching !== bWatching) return bWatching - aWatching;

  const aDistance = aProximity?.distancePercent ?? Number.POSITIVE_INFINITY;
  const bDistance = bProximity?.distancePercent ?? Number.POSITIVE_INFINITY;
  if (aDistance !== bDistance) return aDistance - bDistance;

  return b.scoring.priority.localeCompare(a.scoring.priority);
}

export default function MarketObjectsWidget() {
  const { report } = useDecisionCenter();
  const [snapshot, setSnapshot] =
    useState<MarketObjectRegistrySnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    setSnapshot(marketObjectRegistry.getSnapshot());
    return marketObjectRegistry.subscribe((_event, nextSnapshot) => {
      setSnapshot(nextSnapshot);
    });
  }, []);

  const symbol = report?.context.symbol?.trim().toUpperCase() ?? "";
  const timeframe = report?.context.timeframe?.trim() ?? "";

  const objects = useMemo(
    () =>
      snapshot.objects
        .filter(
          (object) =>
            object.active &&
            (!symbol || object.symbol === symbol) &&
            (!timeframe || object.timeframe === timeframe),
        )
        .sort(sortObjects),
    [snapshot, symbol, timeframe],
  );

  const watchingCount = objects.filter(
    (object) => object.awareness.proximity?.isWithinAwarenessRadius,
  ).length;

  return (
    <PanelCard title="Market Objects">
      <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
          }}
        >
          <Summary label="Active" value={objects.length} color="#38bdf8" />
          <Summary label="Watching" value={watchingCount} color="#f59e0b" />
        </div>

        {objects.length === 0 ? (
          <div
            style={{
              padding: 10,
              borderRadius: 10,
              background: "rgba(255,255,255,0.03)",
              border: "1px solid rgba(255,255,255,0.06)",
              color: "#94a3b8",
              fontSize: 11,
              lineHeight: 1.45,
            }}
          >
            Draw a demand zone, supply zone, trendline, or level to add market
            awareness.
          </div>
        ) : (
          objects.slice(0, 6).map((object) => (
            <ObjectRow key={object.id} object={object} />
          ))
        )}

        {objects.length > 6 ? (
          <div style={{ color: "#64748b", fontSize: 10, textAlign: "center" }}>
            +{objects.length - 6} more active objects
          </div>
        ) : null}
      </div>
    </PanelCard>
  );
}

function Summary({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div
      style={{
        padding: 8,
        borderRadius: 9,
        background: "rgba(255,255,255,0.03)",
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      <div
        style={{
          color: "#94a3b8",
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: "0.08em",
          textTransform: "uppercase",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          color,
          fontSize: 18,
          fontWeight: 900,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
    </div>
  );
}

function ObjectRow({ object }: { object: MarketObject }) {
  const color = biasColor(object);
  const proximity = object.awareness.proximity;
  const status = interactionStatus(object);

  return (
    <div
      style={{
        padding: 9,
        borderRadius: 10,
        background: "rgba(255,255,255,0.03)",
        border: `1px solid ${color}2e`,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            minWidth: 0,
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              flexShrink: 0,
              borderRadius: 999,
              background: color,
              boxShadow: proximity?.isWithinAwarenessRadius
                ? `0 0 8px ${color}`
                : "none",
            }}
          />
          <span
            style={{
              overflow: "hidden",
              color: "#e2e8f0",
              fontSize: 11,
              fontWeight: 800,
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {objectLabel(object)}
          </span>
        </div>

        <span
          style={{
            flexShrink: 0,
            color: status.color,
            fontSize: 10,
            fontWeight: 800,
            textTransform: "capitalize",
          }}
        >
          {status.label}
        </span>
      </div>

      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          gap: 8,
          marginTop: 6,
          color: "#94a3b8",
          fontSize: 10,
        }}
      >
        <span>{proximityText(object)}</span>
        <span style={{ fontVariantNumeric: "tabular-nums" }}>
          Q {Math.round(object.scoring.quality)} · H {Math.round(object.scoring.health)}
        </span>
      </div>
    </div>
  );
}
