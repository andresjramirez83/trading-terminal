// src/components/chart/studies/SessionBandsStudy.ts

import type { IChartApi, Time } from "lightweight-charts";
import type { ChartSessionBandKey, ChartSettings } from "../ChartSettingsTypes";
import type { CleanBar } from "../ChartTypes";

const NEW_YORK_TIME_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function getEasternMinutes(time: Time): number | null {
  const timestamp =
    typeof time === "number"
      ? time * 1000
      : typeof time === "string"
        ? Date.parse(time)
        : time && typeof time === "object" && "year" in time
          ? Date.UTC(time.year, time.month - 1, time.day)
          : NaN;

  if (!Number.isFinite(timestamp)) return null;

  const parts = NEW_YORK_TIME_PARTS_FORMATTER.formatToParts(new Date(timestamp));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? NaN);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? NaN);

  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;

  const normalizedHour = hour === 24 ? 0 : hour;
  return normalizedHour * 60 + minute;
}

function getSessionBandKey(time: Time): ChartSessionBandKey | null {
  const minutes = getEasternMinutes(time);
  if (minutes == null) return null;

  if (minutes >= 4 * 60 && minutes < 9 * 60 + 30) return "premarket";
  if (minutes >= 9 * 60 + 30 && minutes < 16 * 60) return "regular";
  if (minutes >= 16 * 60 && minutes < 20 * 60) return "afterHours";

  return null;
}

function getSessionBandColor(
  key: ChartSessionBandKey,
  opacity: number,
): string {
  if (key === "premarket") return `rgba(59, 130, 246, ${opacity})`;
  if (key === "regular") return `rgba(255, 255, 255, ${opacity * 0.45})`;
  return `rgba(168, 85, 247, ${opacity})`;
}

function isSessionBandEnabled(settings: ChartSettings, key: ChartSessionBandKey): boolean {
  const sessionBands = settings.sessionBands;

  if (!sessionBands.enabled) return false;
  if (key === "premarket") return sessionBands.premarket;
  if (key === "regular") return sessionBands.regular;
  return sessionBands.afterHours;
}

export function renderSessionBands(params: {
  chart: IChartApi;
  overlay: HTMLDivElement;
  bars: CleanBar[];
  settings: ChartSettings;
}): void {
  const { chart, overlay, bars, settings } = params;
  const sessionBands = settings.sessionBands;

  overlay.replaceChildren();

  if (!sessionBands.enabled || !bars.length) return;

  const timeScale = chart.timeScale();
  const points = bars
    .map((bar) => {
      const x = timeScale.timeToCoordinate(bar.time);
      const key = getSessionBandKey(bar.time);

      if (x == null || key == null || !isSessionBandEnabled(settings, key)) {
        return null;
      }

      return { x, key };
    })
    .filter(Boolean) as Array<{ x: number; key: ChartSessionBandKey }>;

  if (!points.length) return;

  const segments: Array<{
    left: number;
    right: number;
    key: ChartSessionBandKey;
  }> = [];

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const previous = points[index - 1];
    const next = points[index + 1];

    const left =
      previous != null
        ? (previous.x + current.x) / 2
        : current.x - Math.max(2, next ? Math.abs(next.x - current.x) / 2 : 4);
    const right =
      next != null
        ? (current.x + next.x) / 2
        : current.x + Math.max(2, previous ? Math.abs(current.x - previous.x) / 2 : 4);

    const last = segments[segments.length - 1];

    if (last && last.key === current.key && Math.abs(left - last.right) <= 2) {
      last.right = right;
    } else {
      segments.push({
        left,
        right,
        key: current.key,
      });
    }
  }

  const opacity = Math.max(0, Math.min(0.25, sessionBands.opacity));
  const fragment = document.createDocumentFragment();

  for (const segment of segments) {
    const width = segment.right - segment.left;
    if (width <= 0) continue;

    const band = document.createElement("div");
    band.style.position = "absolute";
    band.style.top = "0";
    band.style.bottom = "0";
    band.style.left = `${segment.left}px`;
    band.style.width = `${width}px`;
    band.style.background = getSessionBandColor(segment.key, opacity);

    fragment.appendChild(band);
  }

  overlay.appendChild(fragment);
}
