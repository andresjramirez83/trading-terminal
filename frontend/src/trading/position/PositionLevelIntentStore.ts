// src/trading/position/PositionLevelIntentStore.ts
//
// Small shared optimistic state for chart-driven live stop/target changes.
// The chart, Trading Workspace, and trade synchronizer all run from different
// subscriptions. Alpaca replacement snapshots can briefly report the old
// bracket leg while a moved level is propagating. This store keeps the user's
// most recently accepted level authoritative for a short window so every UI
// surface shows the same risk/reward immediately.

export type PositionLevelIntent = "stop" | "target";

type PendingLevelIntent = {
  price: number;
  expiresAt: number;
};

type SymbolLevelIntents = Partial<
  Record<PositionLevelIntent, PendingLevelIntent>
>;

type Listener = () => void;

const DEFAULT_TTL_MS = 30_000;
const PRICE_EPSILON = 0.000001;
const intents = new Map<string, SymbolLevelIntents>();
const listeners = new Set<Listener>();

function cleanSymbol(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

function validPrice(value: unknown): number {
  const price = Number(value);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // A stale subscriber must not interrupt trading-state propagation.
    }
  }
}

function readIntent(
  symbol: string,
  level: PositionLevelIntent,
): PendingLevelIntent | null {
  const safeSymbol = cleanSymbol(symbol);
  if (!safeSymbol) return null;

  const bucket = intents.get(safeSymbol);
  const pending = bucket?.[level] ?? null;
  if (!pending) return null;

  if (Date.now() >= pending.expiresAt) {
    delete bucket?.[level];
    if (bucket && !bucket.stop && !bucket.target) {
      intents.delete(safeSymbol);
    }
    return null;
  }

  return pending;
}

export function setPositionLevelIntent(
  symbol: string,
  level: PositionLevelIntent,
  price: number,
  ttlMs = DEFAULT_TTL_MS,
): void {
  const safeSymbol = cleanSymbol(symbol);
  const safePrice = validPrice(price);
  if (!safeSymbol || safePrice <= 0) return;

  const bucket = intents.get(safeSymbol) ?? {};
  bucket[level] = {
    price: safePrice,
    expiresAt: Date.now() + Math.max(1_000, ttlMs),
  };
  intents.set(safeSymbol, bucket);
  emit();
}

export function getPositionLevelIntent(
  symbol: string,
  level: PositionLevelIntent,
): number | null {
  return readIntent(symbol, level)?.price ?? null;
}

export function clearPositionLevelIntent(
  symbol: string,
  level: PositionLevelIntent,
  expectedPrice?: number,
): void {
  const safeSymbol = cleanSymbol(symbol);
  const bucket = intents.get(safeSymbol);
  const pending = bucket?.[level];
  if (!bucket || !pending) return;

  if (
    expectedPrice !== undefined &&
    Math.abs(pending.price - validPrice(expectedPrice)) >= PRICE_EPSILON
  ) {
    return;
  }

  delete bucket[level];
  if (!bucket.stop && !bucket.target) intents.delete(safeSymbol);
  emit();
}

/**
 * Returns the level that should be treated as authoritative right now.
 * Once the broker/server snapshot catches the accepted price, the optimistic
 * intent is cleared automatically.
 */
export function resolvePositionLevelIntent(
  symbol: string,
  level: PositionLevelIntent,
  observedPrice: number | null | undefined,
): number {
  const observed = validPrice(observedPrice);
  const pending = readIntent(symbol, level);
  if (!pending) return observed;

  if (observed > 0 && Math.abs(observed - pending.price) < PRICE_EPSILON) {
    clearPositionLevelIntent(symbol, level, pending.price);
    return observed;
  }

  return pending.price;
}

export function subscribePositionLevelIntents(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
