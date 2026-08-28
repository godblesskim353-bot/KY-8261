export const MIN_ENTRY_PRICE_PUSD = 0.4;
export const MAX_ENTRY_PRICE_PUSD = 0.82;
export const ENTRY_PRICE_AGGRESSION_PUSD = 0.02;

export function isEntryPriceWithinBand(price: number): boolean {
  return Number.isFinite(price) && price >= MIN_ENTRY_PRICE_PUSD && price <= MAX_ENTRY_PRICE_PUSD;
}

export function calculateEntryLimitPrice(ask: number): number | null {
  if (!isEntryPriceWithinBand(ask)) return null;
  const aggressivePrice = Math.round((ask + ENTRY_PRICE_AGGRESSION_PUSD + Number.EPSILON) * 100) / 100;
  return Math.min(aggressivePrice, MAX_ENTRY_PRICE_PUSD);
}