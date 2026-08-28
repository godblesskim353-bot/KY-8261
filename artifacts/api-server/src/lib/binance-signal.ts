export type BinanceDirection = "UP" | "DOWN";

export type BinanceDepthLevel = { price: number; size: number };
export type BinanceAggressiveTrade = {
  direction: BinanceDirection;
  quantityBtc: number;
  at: number;
};

export const BINANCE_DEPTH_IMBALANCE_RATIO = 4;
export const BINANCE_AGGRESSIVE_TRADE_BTC = 10;
export const BINANCE_CONFIRMATION_WINDOW_MS = 50;

export function topThreeDepthDirection(
  bids: BinanceDepthLevel[],
  asks: BinanceDepthLevel[],
): { direction: BinanceDirection | null; ratio: number | null } {
  const bidVolume = bids.slice(0, 3).reduce((total, level) => total + level.size, 0);
  const askVolume = asks.slice(0, 3).reduce((total, level) => total + level.size, 0);
  if (!Number.isFinite(bidVolume) || !Number.isFinite(askVolume) || bidVolume <= 0 || askVolume <= 0) {
    return { direction: null, ratio: null };
  }
  if (bidVolume >= askVolume * BINANCE_DEPTH_IMBALANCE_RATIO) {
    return { direction: "UP", ratio: bidVolume / askVolume };
  }
  if (askVolume >= bidVolume * BINANCE_DEPTH_IMBALANCE_RATIO) {
    return { direction: "DOWN", ratio: askVolume / bidVolume };
  }
  return { direction: null, ratio: Math.max(bidVolume / askVolume, askVolume / bidVolume) };
}

/** Counts only trades after the wall observation and during its 50 ms confirmation window. */
export function aggressiveVolumeAfterWall(
  trades: BinanceAggressiveTrade[],
  direction: BinanceDirection,
  wallObservedAt: number | null,
): number {
  if (wallObservedAt === null) return 0;
  return trades.reduce((total, trade) => {
    if (
      trade.direction === direction &&
      trade.at >= wallObservedAt &&
      trade.at <= wallObservedAt + BINANCE_CONFIRMATION_WINDOW_MS
    ) {
      return total + trade.quantityBtc;
    }
    return total;
  }, 0);
}

export function isBinanceEntryConfirmed(
  direction: BinanceDirection | null,
  aggressiveVolumeBtc: number,
): boolean {
  return direction !== null && aggressiveVolumeBtc > BINANCE_AGGRESSIVE_TRADE_BTC;
}

export function calculateDefensePrice(entryPricePusd: number): number | null {
  if (!Number.isFinite(entryPricePusd) || entryPricePusd <= 0 || entryPricePusd >= 1) return null;
  const price = 1 - entryPricePusd - 0.02;
  return price > 0 && price < 1 ? Number(price.toFixed(2)) : null;
}

export function calculateDynamicHedgeBudget(
  initialCostPusd: number,
  oppositeAskPusd: number,
  availableWalletPusd: number,
): { budgetPusd: number; targetPusd: number } | null {
  if (
    !Number.isFinite(initialCostPusd) ||
    !Number.isFinite(oppositeAskPusd) ||
    !Number.isFinite(availableWalletPusd) ||
    initialCostPusd <= 0 ||
    oppositeAskPusd <= 0 ||
    availableWalletPusd <= 0 ||
    oppositeAskPusd >= 0.95
  ) {
    return null;
  }
  const targetPusd = oppositeAskPusd <= 0.7 ? 0.85 : 0.95;
  const rawBudget = (initialCostPusd * oppositeAskPusd) / (targetPusd - oppositeAskPusd);
  return {
    budgetPusd: Number(Math.min(rawBudget, initialCostPusd * 20, availableWalletPusd).toFixed(2)),
    targetPusd,
  };
}

/** Valid CLOB BUY precision, floored so wallet and requested budget are never exceeded. */
export function calculateValidBuyShares(
  budgetPusd: number,
  availableWalletPusd: number,
  pricePusd: number,
): number | null {
  if (!Number.isFinite(budgetPusd) || !Number.isFinite(availableWalletPusd) || !Number.isFinite(pricePusd) || budgetPusd <= 0 || availableWalletPusd <= 0 || pricePusd <= 0) return null;
  const cents = Math.round(pricePusd * 100);
  const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
  const step = (10_000 / gcd(cents, 10_000)) / 10_000;
  const cap = Math.min(budgetPusd, availableWalletPusd);
  const shares = Math.floor((cap / pricePusd + 1e-10) / step) * step;
  return shares > 0 && shares * pricePusd <= cap + 1e-8 ? Number(shares.toFixed(4)) : null;
}