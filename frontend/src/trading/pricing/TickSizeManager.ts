export function getTickSize(price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    return 0.01;
  }

  return price >= 1 ? 0.01 : 0.0001;
}

export function roundToTick(price: number): number {
  if (!Number.isFinite(price) || price <= 0) {
    return 0;
  }

  const tickSize = getTickSize(price);
  const rounded = Math.round(price / tickSize) * tickSize;
  const decimals = tickSize === 0.01 ? 2 : 4;

  return Number(rounded.toFixed(decimals));
}

export function formatTickPrice(price: number): string {
  if (!Number.isFinite(price) || price <= 0) {
    return "";
  }

  const tickSize = getTickSize(price);
  const decimals = tickSize === 0.01 ? 2 : 4;

  return roundToTick(price).toFixed(decimals);
}