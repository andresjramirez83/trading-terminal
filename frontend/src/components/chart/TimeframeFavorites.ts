// src/components/ChartPanelV2/TimeframeFavorites.ts

import { DEFAULT_TIMEFRAME_FAVORITES, TIMEFRAME_OPTIONS, normalizeTimeframeId } from "./TimeframeRegistry";

const FAVORITES_STORAGE_KEY = "chartv2.timeframe.favorites";
const validIds = new Set(TIMEFRAME_OPTIONS.map((option) => option.id));

function cleanFavorites(values: unknown): string[] {
  if (!Array.isArray(values)) return DEFAULT_TIMEFRAME_FAVORITES;

  const cleaned: string[] = [];
  values.forEach((value) => {
    if (typeof value !== "string") return;
    const id = normalizeTimeframeId(value);
    if (!validIds.has(id)) return;
    if (cleaned.includes(id)) return;
    cleaned.push(id);
  });

  return cleaned.length ? cleaned : DEFAULT_TIMEFRAME_FAVORITES;
}

export function loadTimeframeFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return DEFAULT_TIMEFRAME_FAVORITES;
    return cleanFavorites(JSON.parse(raw));
  } catch {
    return DEFAULT_TIMEFRAME_FAVORITES;
  }
}

export function saveTimeframeFavorites(favorites: string[]): void {
  try {
    localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(cleanFavorites(favorites)));
  } catch {
    // localStorage can fail in private mode. The UI still works for this session.
  }
}

export function toggleTimeframeFavorite(favorites: string[], timeframe: string): string[] {
  const id = normalizeTimeframeId(timeframe);
  if (!validIds.has(id)) return favorites;

  if (favorites.includes(id)) {
    const next = favorites.filter((favorite) => favorite !== id);
    return next.length ? next : favorites;
  }

  return [...favorites, id];
}
