export const MIN_ENTRY_PRICE_PUSD = 0.4;
export const MAX_ENTRY_PRICE_PUSD = 0.75;

export function isEntryPriceWithinBand(price: number): boolean {
  return Number.isFinite(price) && price >= MIN_ENTRY_PRICE_PUSD && price <= MAX_ENTRY_PRICE_PUSD;
}