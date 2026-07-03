// src/components/ChartPanelV2/CrosshairInfoBox.tsx

import type { CrosshairInfo } from "../../chart/ChartTypes";

type Props = {
  info: CrosshairInfo | null;
};

function formatPrice(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  return value.toFixed(value >= 10 ? 2 : 4);
}

function formatVolume(value?: number | null): string {
  if (value == null || !Number.isFinite(value)) return "--";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export default function CrosshairInfoBox({ info }: Props) {
  const infoWithRange = info as (CrosshairInfo & { range?: number }) | null;
  const range =
    infoWithRange?.range ??
    (info?.high != null && info?.low != null ? info.high - info.low : null);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontSize: 12,
        color: "#d1d5db",
        whiteSpace: "nowrap",
        marginLeft: 10,
        overflow: "hidden",
      }}
    >
      <span>O {formatPrice(info?.open)}</span>
      <span>H {formatPrice(info?.high)}</span>
      <span>L {formatPrice(info?.low)}</span>
      <span>C {formatPrice(info?.close)}</span>
      <span>R {formatPrice(range)}</span>
      <span>V {formatVolume(info?.volume)}</span>
    </div>
  );
}
