import { API_BASE } from "../../services/api";

export type ChartSyncDocument = {
  items?: unknown[];
  drawings?: unknown[];
  projections?: unknown[];
  exists?: boolean;
  revision?: number;
  updatedAt?: number | string | null;
};

export type ChartWorkspaceSync = {
  symbol: string;
  timeframe: string;
  drawings: {
    timeframe: ChartSyncDocument;
    shared: ChartSyncDocument;
  };
  projections: ChartSyncDocument;
};

type CachedSync = {
  fetchedAt: number;
  value: ChartWorkspaceSync;
};

const CACHE_TTL_MS = 2_000;
const cache = new Map<string, CachedSync>();
const inFlight = new Map<string, Promise<ChartWorkspaceSync>>();

function normalizeSymbol(symbol: string): string {
  return String(symbol || "SPY").trim().toUpperCase();
}

function normalizeTimeframe(timeframe: string): string {
  return String(timeframe || "5m").trim().toLowerCase();
}

function cacheKey(symbol: string, timeframe: string): string {
  return `${normalizeSymbol(symbol)}::${normalizeTimeframe(timeframe)}`;
}

export function invalidateChartWorkspaceSync(
  symbol?: string,
  timeframe?: string,
): void {
  if (!symbol) {
    cache.clear();
    return;
  }

  const normalizedSymbol = normalizeSymbol(symbol);

  if (timeframe) {
    cache.delete(cacheKey(normalizedSymbol, timeframe));
    return;
  }

  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${normalizedSymbol}::`)) {
      cache.delete(key);
    }
  }
}

export async function fetchChartWorkspaceSync(
  symbol: string,
  timeframe: string,
): Promise<ChartWorkspaceSync> {
  const normalizedSymbol = normalizeSymbol(symbol);
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  const key = cacheKey(normalizedSymbol, normalizedTimeframe);
  const now = performance.now();
  const cached = cache.get(key);

  if (cached && now - cached.fetchedAt <= CACHE_TTL_MS) {
    return cached.value;
  }

  const currentRequest = inFlight.get(key);
  if (currentRequest) {
    return currentRequest;
  }

  const request = fetch(
    `${API_BASE}/chart/sync/${encodeURIComponent(normalizedSymbol)}/${encodeURIComponent(normalizedTimeframe)}`,
    {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    },
  )
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(
          `Chart sync failed (${response.status}) for ${normalizedSymbol}/${normalizedTimeframe}`,
        );
      }

      const payload = (await response.json()) as ChartWorkspaceSync;
      cache.set(key, {
        fetchedAt: performance.now(),
        value: payload,
      });
      return payload;
    })
    .finally(() => {
      if (inFlight.get(key) === request) {
        inFlight.delete(key);
      }
    });

  inFlight.set(key, request);
  return request;
}
