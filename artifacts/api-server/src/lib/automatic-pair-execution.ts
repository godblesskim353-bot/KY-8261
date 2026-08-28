import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
const API_SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTION_HELPER = path.resolve(API_SERVER_DIR, "scripts/manage_clob_pair.py");
const EXECUTION_JOURNAL_PATH = process.env.POLYMARKET_SINGLE_EXECUTION_JOURNAL_PATH?.trim()
  ? path.resolve(process.env.POLYMARKET_SINGLE_EXECUTION_JOURNAL_PATH.trim())
  : path.resolve(API_SERVER_DIR, ".automatic-single-execution-journal.json");

export const MAX_COMBINED_ASK = 1;
export const WALLET_STAKE_FRACTION = 0.1;
/**
 * Absolute price offset, not a wallet-level profit target.
 * Example: entry at 0.65 pUSD sets the sell trigger at 0.70 pUSD.
 */
export const EXIT_TRIGGER_PRICE_OFFSET_PUSD = 0.05;
const RECONCILE_INTERVAL_MS = 500;
const RETRY_COOLDOWN_MS = 15_000;
const EXIT_RETRY_MS = 750;
const ORDER_POLL_ATTEMPTS = 4;
const ORDER_POLL_MS = 250;

export type Direction = "UP" | "DOWN";

export type AutomaticPairExecutionStatus = {
  mode: "CLOB_SINGLE_LEG_DIRECTIONAL_FAK_FAK";
  enabled: boolean;
  armed: boolean;
  state:
    | "DISABLED"
    | "PAUSED"
    | "WAITING_FOR_MARKET"
    | "ARMED"
    | "SUBMITTING"
    | "VERIFYING"
    | "WAITING_FOR_TAKE_PROFIT"
    | "EXITING"
    | "EXIT_RETRYING"
    | "FILLED"
    | "HALTED";
  reason: string;
  lastActionAt: string | null;
  conditionId: string | null;
  side: Direction | null;
  entryOrderId: string | null;
  exitOrderId: string | null;
  unresolvedOrder: boolean;
  plannedShares: number | null;
  plannedCostPusd: number | null;
  entryPricePusd: number | null;
  takeProfitPricePusd: number | null;
  remainingShares: number | null;
  exitSellFloorPusd: number | null;
  exitTriggered: boolean;
  directionReason: string | null;
  entryCombinedAskPusd: number | null;
  lastExitError: string | null;
  lastAttemptAt: string | null;
  lastAttemptCombinedAsk: number | null;
  lastAttemptOutcome: string | null;
};

export type PairExecutionCandidate = {
  ready: boolean;
  market: {
    conditionId: string | null;
    yesTokenId: string | null;
    noTokenId: string | null;
    endAt: number | null;
    negRisk: boolean;
  };
  quotes: {
    yesBestAsk: number | null;
    yesAskSize: number | null;
    noBestAsk: number | null;
    noAskSize: number | null;
    yesBestBid: number | null;
    yesBidSize: number | null;
    noBestBid: number | null;
    noBidSize: number | null;
    yesBidDepth: number | null;
    yesAskDepth: number | null;
    noBidDepth: number | null;
    noAskDepth: number | null;
    combinedAsk: number | null;
    fresh: boolean;
  };
  signal: {
    btcDirection: Direction | null;
    bookDirection: Direction | null;
    selectedDirection: Direction | null;
    confirmed: boolean;
    reason: string;
  };
  walletBalancePusd: number | null;
  inventory: { yesShares: number | null; noShares: number | null };
};

type HelperOrder = { leg?: string; accepted?: boolean; orderId?: string | null };
type HelperResult = {
  ok?: boolean;
  code?: string;
  detail?: string;
  orders?: HelperOrder[];
  noOrdersAccepted?: boolean;
};
type OrderStatus = {
  orderId?: string;
  status?: string;
  sizeMatched?: number | string | null;
  originalSize?: number | string | null;
  price?: number | string | null;
  side?: string | null;
  tokenId?: string | null;
};
type OrderStatusResult = { ok?: boolean; code?: string; detail?: string; orders?: OrderStatus[] };

type ExecutionJournal = {
  phase: "ENTRY" | "POSITION" | "EXITING";
  conditionId: string;
  side: Direction;
  tokenId: string;
  entryOrderId: string | null;
  exitOrderId: string | null;
  entryPricePusd: number;
  plannedShares: number;
  remainingShares: number;
  takeProfitPricePusd: number;
  exitSellFloorPusd: number | null;
  exitTriggered: boolean;
  createdAt: string;
  updatedAt: string;
};

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asIso(value: number): string {
  return new Date(value).toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isFilled(status: string): boolean {
  return ["MATCHED", "FILLED"].includes(status.toUpperCase());
}

function isTerminal(status: string): boolean {
  return ["CANCELED", "CANCELLED", "EXPIRED", "UNMATCHED", "FAILED", "REJECTED"].includes(
    status.toUpperCase(),
  );
}

function roundToCents(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

function roundSharesUpForValidAmounts(
  targetBudgetPusd: number,
  availableWalletPusd: number,
  pricePusd: number,
): number | null {
  if (
    !Number.isFinite(targetBudgetPusd) ||
    !Number.isFinite(availableWalletPusd) ||
    !Number.isFinite(pricePusd) ||
    targetBudgetPusd <= 0 ||
    availableWalletPusd <= 0 ||
    pricePusd <= 0
  ) {
    return null;
  }
  const priceCents = Math.round(pricePusd * 100);
  if (priceCents <= 0) return null;
  // For a cent-tick price, this is the smallest four-decimal share step whose
  // price × size produces a cent-precision maker amount. This directly avoids
  // the invalid-amount rejection seen with arbitrary fractional sizes.
  const validShareStep = (10_000 / greatestCommonDivisor(priceCents, 10_000)) / 10_000;
  const rawShares = targetBudgetPusd / pricePusd;
  const roundedUp = Math.ceil((rawShares - Number.EPSILON) / validShareStep) * validShareStep;
  if (roundedUp * pricePusd > availableWalletPusd + 1e-9) return null;
  return Number(roundedUp.toFixed(4));
}

function loadExecutionJournal(): ExecutionJournal | null {
  if (!existsSync(EXECUTION_JOURNAL_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(EXECUTION_JOURNAL_PATH, "utf8")) as Partial<ExecutionJournal>;
    if (
      !["ENTRY", "POSITION", "EXITING"].includes(String(parsed.phase)) ||
      typeof parsed.conditionId !== "string" ||
      (parsed.side !== "UP" && parsed.side !== "DOWN") ||
      typeof parsed.tokenId !== "string" ||
      typeof parsed.entryPricePusd !== "number" ||
      typeof parsed.plannedShares !== "number" ||
      typeof parsed.remainingShares !== "number" ||
      typeof parsed.takeProfitPricePusd !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      throw new Error("Invalid single-leg execution journal");
    }
    return {
      phase: parsed.phase as ExecutionJournal["phase"],
      conditionId: parsed.conditionId,
      side: parsed.side as Direction,
      tokenId: parsed.tokenId,
      entryOrderId: typeof parsed.entryOrderId === "string" ? parsed.entryOrderId : null,
      exitOrderId: typeof parsed.exitOrderId === "string" ? parsed.exitOrderId : null,
      entryPricePusd: parsed.entryPricePusd,
      plannedShares: parsed.plannedShares,
      remainingShares: parsed.remainingShares,
      takeProfitPricePusd: parsed.takeProfitPricePusd,
      exitSellFloorPusd: typeof parsed.exitSellFloorPusd === "number" ? parsed.exitSellFloorPusd : null,
      exitTriggered: parsed.exitTriggered === true,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function persistExecutionJournal(journal: ExecutionJournal): void {
  const temporaryPath = `${EXECUTION_JOURNAL_PATH}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(journal), { encoding: "utf8", mode: 0o600 });
  renameSync(temporaryPath, EXECUTION_JOURNAL_PATH);
}

function clearExecutionJournal(): void {
  if (existsSync(EXECUTION_JOURNAL_PATH)) unlinkSync(EXECUTION_JOURNAL_PATH);
}

function executionPython(): string | null {
  const configured = process.env.POLYMARKET_EXECUTION_PYTHON?.trim();
  if (configured) return configured;
  const candidates = [
    path.resolve(process.cwd(), ".pythonlibs/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.pythonlibs/bin/python"),
    path.resolve(process.cwd(), ".venv/bin/python3"),
    path.resolve(process.cwd(), ".venv/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python3"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export function isCLOBSingleLegBridgeAvailable(): boolean {
  return Boolean(
    executionPython() &&
      existsSync(EXECUTION_HELPER) &&
      process.env.POLYMARKET_PRIVATE_KEY?.trim() &&
      process.env.POLYMARKET_FUNDER?.trim() &&
      process.env.RESIDENTIAL_PROXY_URL?.trim(),
  );
}

// Kept as a compatibility export for the existing status route.
export const isCLOBTwoLegBridgeAvailable = isCLOBSingleLegBridgeAvailable;

export class AutomaticPairExecutionSupervisor {
  private status: AutomaticPairExecutionStatus = {
    mode: "CLOB_SINGLE_LEG_DIRECTIONAL_FAK_FAK",
    enabled: false,
    armed: false,
    state: "DISABLED",
    reason: "LIVE_TRADING_ENABLED is not set.",
    lastActionAt: null,
    conditionId: null,
    side: null,
    entryOrderId: null,
    exitOrderId: null,
    unresolvedOrder: false,
    plannedShares: null,
    plannedCostPusd: null,
    entryPricePusd: null,
    takeProfitPricePusd: null,
    remainingShares: null,
    exitSellFloorPusd: null,
    exitTriggered: false,
    directionReason: null,
    entryCombinedAskPusd: null,
    lastExitError: null,
    lastAttemptAt: null,
    lastAttemptCombinedAsk: null,
    lastAttemptOutcome: null,
  };
  private submitting = false;
  private reconciling = false;
  private lastReconcileAt = 0;
  private retryAfterAt = 0;
  private completedConditionId: string | null = null;
  private tokenId: string | null = null;
  private entryLimitPrice: number | null = null;
  private positionConfirmed = false;

  constructor() {
    const journal = loadExecutionJournal();
    if (journal) {
      this.status.state = "PAUSED";
      this.status.reason = "An open single-leg execution journal requires START to resume exit supervision.";
      this.status.armed = false;
      this.status.conditionId = journal.conditionId;
      this.status.side = journal.side;
      this.status.entryOrderId = journal.entryOrderId;
      this.status.exitOrderId = journal.exitOrderId;
      this.status.plannedShares = journal.plannedShares;
      this.status.plannedCostPusd = roundToCents(journal.entryPricePusd * journal.plannedShares);
      this.status.entryPricePusd = journal.entryPricePusd;
      this.status.takeProfitPricePusd = journal.takeProfitPricePusd;
      this.status.remainingShares = journal.remainingShares;
      this.status.exitSellFloorPusd = journal.exitSellFloorPusd;
      this.status.exitTriggered = journal.exitTriggered;
      this.tokenId = journal.tokenId;
      this.entryLimitPrice = journal.entryPricePusd;
      this.positionConfirmed = journal.phase === "POSITION" || journal.phase === "EXITING";
      this.status.unresolvedOrder = journal.phase === "ENTRY";
      this.status.lastActionAt = journal.updatedAt;
    }
  }

  snapshot(): AutomaticPairExecutionStatus {
    return { ...this.status };
  }

  async evaluate(candidate: PairExecutionCandidate): Promise<void> {
    const enabled = process.env.LIVE_TRADING_ENABLED === "true";
    this.status.enabled = enabled;
    if (this.status.state === "HALTED") return;
    if (!enabled) {
      this.status.armed = false;
      this.setState("DISABLED", "LIVE_TRADING_ENABLED is not set.");
      return;
    }

    // An active position is always supervised to zero once this supervisor
    // owns it. Entry remains blocked while any exit is unresolved.
    if (this.hasPosition()) {
      await this.managePosition(candidate);
      return;
    }
    if (this.status.entryOrderId) {
      await this.reconcileEntry(candidate);
      return;
    }
    if (this.status.unresolvedOrder) {
      this.setState("VERIFYING", "An entry submission has an unknown result; duplicate entries are blocked.");
      return;
    }
    if (!this.status.armed) {
      this.setState("PAUSED", "Press START AUTO EXECUTION to begin directional execution.");
      return;
    }
    if (this.retryAfterAt > Date.now()) {
      this.setState("WAITING_FOR_MARKET", "Entry cooldown is active; automatic retry will continue.");
      return;
    }
    if (
      candidate.market.conditionId &&
      candidate.market.conditionId !== this.completedConditionId &&
      this.status.state === "FILLED"
    ) {
      this.clearExecution();
      this.setState("ARMED", "New BTC market window observed.");
    }
    if (candidate.market.conditionId && candidate.market.conditionId === this.completedConditionId) {
      this.setState("FILLED", "This BTC market window already completed one directional trade.");
      return;
    }
    const blockReason = this.blockReason(candidate);
    if (blockReason !== "READY") {
      this.setState("WAITING_FOR_MARKET", blockReason);
      return;
    }
    if (this.submitting) return;
    const side = candidate.signal.selectedDirection;
    const ask = side === "UP" ? candidate.quotes.yesBestAsk : candidate.quotes.noBestAsk;
    if (!side || ask === null) return;
    const shares = this.calculateShares(candidate, ask);
    if (shares === null) {
      this.setState("WAITING_FOR_MARKET", "The verified wallet balance cannot fund a valid 10% single-leg order.");
      return;
    }
    await this.submitEntry(candidate, side, ask, shares);
  }

  async emergencyStop(): Promise<AutomaticPairExecutionStatus> {
    this.status.armed = false;
    this.setState("HALTED", "Operator kill switch is active. No new orders or exit retries will be submitted.");
    return this.snapshot();
  }

  async arm(): Promise<AutomaticPairExecutionStatus> {
    if (this.status.state === "HALTED") return this.snapshot();
    if (this.status.unresolvedOrder && !this.status.entryOrderId) return this.snapshot();
    if (process.env.LIVE_TRADING_ENABLED !== "true") {
      this.status.armed = false;
      this.setState("DISABLED", "Server master execution switch is not enabled.");
      return this.snapshot();
    }
    if (!isCLOBSingleLegBridgeAvailable()) {
      this.status.armed = false;
      this.setState("PAUSED", "Single-leg CLOB execution bridge or credentials are unavailable.");
      return this.snapshot();
    }
    this.status.armed = true;
    this.setState(
      this.hasPosition()
        ? "EXIT_RETRYING"
        : "ARMED",
      this.hasPosition()
        ? "Operator resumed supervision of the active position; new entries remain blocked until it is cleared."
        : "Operator armed directional single-leg execution.",
    );
    return this.snapshot();
  }

  async pause(): Promise<AutomaticPairExecutionStatus> {
    this.status.armed = false;
    if (this.hasPosition()) {
      this.setState("EXIT_RETRYING", "New entries are paused; the active position remains under exit supervision.");
    } else if (this.status.entryOrderId) {
      this.setState("VERIFYING", "New entries are paused while the entry order lifecycle is confirmed.");
    } else {
      this.setState("PAUSED", "Operator paused automatic execution.");
    }
    return this.snapshot();
  }

  private blockReason(candidate: PairExecutionCandidate): string {
    if (!isCLOBSingleLegBridgeAvailable()) return "Single-leg CLOB execution bridge or credentials are unavailable.";
    if (!candidate.ready || !candidate.quotes.fresh) return "Fresh Binance, CLOB bid/ask, and orderbook-direction data are required.";
    if (!candidate.market.conditionId || !candidate.market.yesTokenId || !candidate.market.noTokenId || candidate.market.endAt === null) {
      return "A verified active BTC 5-minute market is required.";
    }
    const { yesBestAsk, noBestAsk, combinedAsk } = candidate.quotes;
    if (yesBestAsk === null || noBestAsk === null || combinedAsk === null || yesBestAsk <= 0 || noBestAsk <= 0) {
      return "Both Up and Down asks are required for the <100¢ mispricing gate.";
    }
    if (combinedAsk >= MAX_COMBINED_ASK) {
      return "Entry waits for Up ask + Down ask to be strictly below 100¢.";
    }
    if (!candidate.signal.confirmed || !candidate.signal.selectedDirection) {
      return candidate.signal.reason;
    }
    const selectedAsk = candidate.signal.selectedDirection === "UP" ? yesBestAsk : noBestAsk;
    if (selectedAsk + EXIT_TRIGGER_PRICE_OFFSET_PUSD >= 1) {
      return "Selected token's entry + 0.05 pUSD price trigger would be at or above 1.00 pUSD.";
    }
    if (
      candidate.inventory.yesShares === null ||
      candidate.inventory.noShares === null
    ) {
      return "Verified current inventory is required before a new entry.";
    }
    if (candidate.inventory.yesShares > 0.01 || candidate.inventory.noShares > 0.01) {
      return "Existing Up/Down inventory must be cleared before a new entry.";
    }
    if (candidate.walletBalancePusd === null || !Number.isFinite(candidate.walletBalancePusd) || candidate.walletBalancePusd <= 0) {
      return "A verified positive CLOB collateral balance is required.";
    }
    return "READY";
  }

  private calculateShares(candidate: PairExecutionCandidate, ask: number): number | null {
    if (candidate.walletBalancePusd === null) return null;
    return roundSharesUpForValidAmounts(
      candidate.walletBalancePusd * WALLET_STAKE_FRACTION,
      candidate.walletBalancePusd,
      ask,
    );
  }

  private async submitEntry(
    candidate: PairExecutionCandidate,
    side: Direction,
    ask: number,
    shares: number,
  ): Promise<void> {
    const tokenId = side === "UP" ? candidate.market.yesTokenId : candidate.market.noTokenId;
    if (!tokenId || !candidate.market.conditionId) return;
    this.submitting = true;
    this.status.conditionId = candidate.market.conditionId;
    this.status.side = side;
    this.status.plannedShares = shares;
    this.status.plannedCostPusd = roundToCents(shares * ask);
    this.status.entryPricePusd = ask;
    this.status.takeProfitPricePusd = roundToCents(ask + EXIT_TRIGGER_PRICE_OFFSET_PUSD);
    this.status.remainingShares = shares;
    this.status.directionReason = candidate.signal.reason;
    this.status.entryCombinedAskPusd = candidate.quotes.combinedAsk;
    this.status.lastAttemptAt = new Date().toISOString();
    this.status.lastAttemptCombinedAsk = candidate.quotes.combinedAsk;
    this.status.lastAttemptOutcome = null;
    this.status.lastExitError = null;
    this.status.unresolvedOrder = false;
    this.status.exitTriggered = false;
    this.status.exitSellFloorPusd = null;
    this.tokenId = tokenId;
    this.entryLimitPrice = ask;
    this.setState("SUBMITTING", `Submitting one ${side} market-style FAK buy after the <100¢ mispricing gate.`);
    try {
      this.recordExecutionJournal("ENTRY");
      const response = await this.callHelper("submit_fak_buy", {
        tokenId,
        leg: side,
        price: ask,
        size: shares,
      });
      const orderId = response.orders?.[0]?.orderId ?? null;
      this.status.entryOrderId = orderId;
      if (response.ok !== true || !orderId) {
        const detail = response.code ? ` (${[response.code, response.detail].filter(Boolean).join(": ")})` : "";
        this.status.lastAttemptOutcome = `REJECTED${detail || " (no code returned)"}`;
        clearExecutionJournal();
        this.clearExecution();
        this.scheduleCooldown(`The ${side} FAK entry was rejected before a confirmed fill.${detail}`);
        return;
      }
      this.status.lastAttemptOutcome = "ACCEPTED";
      this.status.unresolvedOrder = true;
      this.recordExecutionJournal("ENTRY");
      this.setState("VERIFYING", `${side} FAK buy accepted; confirming the single-leg fill.`);
      await this.reconcileEntry(candidate);
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message.slice(0, 180)})` : "";
      this.status.lastAttemptOutcome = `EXCEPTION${detail}`;
      this.status.unresolvedOrder = true;
      this.setState("VERIFYING", `Entry lifecycle could not be confirmed; new entries remain blocked${detail}.`);
    } finally {
      this.submitting = false;
    }
  }

  private async reconcileEntry(candidate: PairExecutionCandidate): Promise<void> {
    if (!this.status.entryOrderId || this.reconciling) return;
    if (Date.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS) return;
    this.reconciling = true;
    this.lastReconcileAt = Date.now();
    try {
      const response = await this.callHelper("get_orders", { orderIds: [this.status.entryOrderId] });
      const order = response.ok === true && response.orders?.length === 1 ? response.orders[0] : null;
      if (!order) {
        this.status.unresolvedOrder = true;
        this.setState("VERIFYING", "Entry order status is unavailable; no new entry will be submitted.");
        return;
      }
      const matched = finiteNumber(order.sizeMatched);
      const status = String(order.status ?? "UNKNOWN");
      if (matched !== null && matched > 0 && (isFilled(status) || isTerminal(status) || matched >= (this.status.plannedShares ?? Infinity))) {
        const entryPrice = finiteNumber(order.price) ?? this.entryLimitPrice;
        const plannedShares = this.status.plannedShares;
        if (entryPrice === null || plannedShares === null) {
          this.setState("VERIFYING", "Entry filled quantity or price is incomplete; waiting for another lifecycle read.");
          return;
        }
        this.status.entryPricePusd = entryPrice;
        this.status.plannedCostPusd = roundToCents(entryPrice * matched);
        this.status.remainingShares = matched;
        this.status.takeProfitPricePusd = roundToCents(entryPrice + EXIT_TRIGGER_PRICE_OFFSET_PUSD);
        this.status.unresolvedOrder = false;
        this.positionConfirmed = true;
        this.recordExecutionJournal("POSITION");
        this.setState("WAITING_FOR_TAKE_PROFIT", `${this.status.side} entry filled at ${entryPrice.toFixed(2)}; sell trigger is entry price + 0.05 pUSD (${this.status.takeProfitPricePusd.toFixed(2)}).`);
        return;
      }
      if (matched === 0 && isTerminal(status)) {
        this.status.unresolvedOrder = false;
        clearExecutionJournal();
        this.clearExecution();
        this.scheduleCooldown("The FAK entry terminated with zero matched quantity.");
        return;
      }
      this.status.unresolvedOrder = true;
      this.setState("VERIFYING", `Entry order is ${status}; waiting for a definitive fill result.`);
    } catch (error) {
      const detail = error instanceof Error && error.message ? ` (${error.message.slice(0, 160)})` : "";
      this.status.unresolvedOrder = true;
      this.setState("VERIFYING", `Entry verification failed; new entries remain blocked${detail}.`);
    } finally {
      this.reconciling = false;
    }
  }

  private async managePosition(candidate: PairExecutionCandidate): Promise<void> {
    if (!this.status.side || !this.tokenId || !this.status.remainingShares || this.status.remainingShares <= 0) {
      return;
    }
    if (this.status.exitOrderId) {
      await this.reconcileExit();
      return;
    }
    if (this.retryAfterAt > Date.now()) {
      this.setState("EXIT_RETRYING", "Exit retry cooldown is active; remaining shares stay protected and will be sold until the position is zero.");
      return;
    }
    const bestBid = this.status.side === "UP" ? candidate.quotes.yesBestBid : candidate.quotes.noBestBid;
    if (bestBid === null || !candidate.quotes.fresh) {
      this.setState(
        this.status.exitTriggered ? "EXIT_RETRYING" : "WAITING_FOR_TAKE_PROFIT",
        this.status.exitTriggered
          ? "Waiting for a fresh executable bid; unsold shares will keep retrying until the position is zero."
          : "Waiting for the selected token to reach the entry price + 0.05 pUSD sell trigger.",
      );
      return;
    }
    const target = this.status.takeProfitPricePusd;
    if (target === null) return;
    // Once the target has been reached, use the live best bid as a marketable
    // FAK price. FAK executes immediately against available bids and cancels
    // anything it cannot fill; retries re-read the current bid instead of
    // waiting for the old target/floor to return.
    if (!this.status.exitTriggered && bestBid < target) {
      this.setState("WAITING_FOR_TAKE_PROFIT", `Waiting for ${this.status.side} bid to reach the ${target.toFixed(2)} sell trigger (entry + 0.05 pUSD).`);
      return;
    }
    this.status.exitTriggered = true;
    const marketSellPrice = roundToCents(bestBid);
    this.status.exitSellFloorPusd = marketSellPrice;
    await this.submitExit(marketSellPrice);
  }

  private async submitExit(marketSellPrice: number): Promise<void> {
    if (!this.tokenId || !this.status.side || !this.status.remainingShares || this.status.remainingShares <= 0) return;
    this.status.lastExitError = null;
    this.status.unresolvedOrder = false;
    this.setState("EXITING", `Selling ${this.status.side} immediately with a market-style FAK at the live best bid.`);
    try {
      this.recordExecutionJournal("EXITING");
      const response = await this.callHelper("submit_fak_sell", {
        tokenId: this.tokenId,
        leg: this.status.side,
        price: marketSellPrice,
        size: this.status.remainingShares,
      });
      const orderId = response.orders?.[0]?.orderId ?? null;
      this.status.exitOrderId = orderId;
      if (response.ok !== true || !orderId) {
        this.status.lastExitError = `${response.code ?? "EXIT_REJECTED"}${response.detail ? `: ${response.detail}` : ""}`;
        this.status.unresolvedOrder = false;
        this.retryAfterAt = Date.now() + EXIT_RETRY_MS;
        this.setState("EXIT_RETRYING", `Exit was not completed; retrying until the ${this.status.side} position is zero.`);
        return;
      }
      this.setState("EXITING", "Exit order accepted; confirming the quantity sold.");
      await this.reconcileExit();
    } catch (error) {
      this.status.lastExitError = error instanceof Error ? error.message.slice(0, 180) : "Exit helper failed.";
      this.status.unresolvedOrder = false;
      this.retryAfterAt = Date.now() + EXIT_RETRY_MS;
      this.setState("EXIT_RETRYING", "Exit result is unknown; new entries are paused and unsold shares will keep retrying until the position is zero.");
    }
  }

  private async reconcileExit(): Promise<void> {
    if (!this.status.exitOrderId || this.reconciling) return;
    if (Date.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS) return;
    this.reconciling = true;
    this.lastReconcileAt = Date.now();
    try {
      const response = await this.callHelper("get_orders", { orderIds: [this.status.exitOrderId] });
      const order = response.ok === true && response.orders?.length === 1 ? response.orders[0] : null;
      if (!order) {
        this.status.lastExitError = "Exit order status is temporarily unavailable.";
        this.status.unresolvedOrder = false;
        this.retryAfterAt = Date.now() + EXIT_RETRY_MS;
        this.setState("EXIT_RETRYING", "Exit result is unknown; retrying status and sale until all remaining shares are cleared.");
        return;
      }
      const matched = finiteNumber(order.sizeMatched) ?? 0;
      const currentRemaining = this.status.remainingShares ?? 0;
      this.status.remainingShares = Math.max(0, Number((currentRemaining - matched).toFixed(4)));
      const status = String(order.status ?? "UNKNOWN");
      if (this.status.remainingShares <= 0.0001) {
        const completedConditionId = this.status.conditionId;
        this.status.remainingShares = 0;
        this.status.unresolvedOrder = false;
        this.status.exitOrderId = null;
        this.status.lastExitError = null;
        clearExecutionJournal();
        this.completedConditionId = completedConditionId;
        this.tokenId = null;
        this.entryLimitPrice = null;
        this.positionConfirmed = false;
        this.setState("FILLED", "Position fully sold after the entry + 0.05 pUSD sell trigger.");
        return;
      }
      this.status.exitOrderId = null;
      this.status.unresolvedOrder = false;
      this.status.lastExitError = isTerminal(status) ? `Exit ${status.toLowerCase()} with ${this.status.remainingShares} shares remaining.` : null;
      this.retryAfterAt = Date.now() + EXIT_RETRY_MS;
      this.recordExecutionJournal("EXITING");
      this.setState("EXIT_RETRYING", `Exit incomplete (${status}); ${this.status.remainingShares} shares remain and will keep retrying until the position is zero.`);
    } catch (error) {
      this.status.lastExitError = error instanceof Error ? error.message.slice(0, 180) : "Exit status lookup failed.";
      this.status.unresolvedOrder = false;
      this.retryAfterAt = Date.now() + EXIT_RETRY_MS;
      this.setState("EXIT_RETRYING", "Exit status is unknown; retrying until all remaining shares are cleared, without new entries.");
    } finally {
      this.reconciling = false;
    }
  }

  private hasPosition(): boolean {
    return this.positionConfirmed && this.status.remainingShares !== null && this.status.remainingShares > 0.0001;
  }

  private clearExecution(options: { preserveCompletion?: boolean } = {}): void {
    this.status.conditionId = options.preserveCompletion ? this.status.conditionId : null;
    this.status.side = null;
    this.status.entryOrderId = null;
    this.status.exitOrderId = null;
    this.status.unresolvedOrder = false;
    this.status.plannedShares = null;
    this.status.plannedCostPusd = null;
    this.status.entryPricePusd = null;
    this.status.takeProfitPricePusd = null;
    this.status.remainingShares = null;
    this.status.exitSellFloorPusd = null;
    this.status.exitTriggered = false;
    this.status.directionReason = null;
    this.status.entryCombinedAskPusd = null;
    this.tokenId = null;
    this.entryLimitPrice = null;
    this.positionConfirmed = false;
  }

  private scheduleCooldown(reason: string): void {
    this.retryAfterAt = Date.now() + RETRY_COOLDOWN_MS;
    this.setState("WAITING_FOR_MARKET", `${reason} Automatic retry resumes after a short cooldown.`);
  }

  private recordExecutionJournal(phase: ExecutionJournal["phase"]): void {
    if (
      !this.status.conditionId ||
      !this.status.side ||
      !this.tokenId ||
      this.status.entryPricePusd === null ||
      this.status.plannedShares === null ||
      this.status.remainingShares === null ||
      this.status.takeProfitPricePusd === null
    ) {
      return;
    }
    const now = new Date().toISOString();
    const existing = loadExecutionJournal();
    persistExecutionJournal({
      phase,
      conditionId: this.status.conditionId,
      side: this.status.side,
      tokenId: this.tokenId,
      entryOrderId: this.status.entryOrderId,
      exitOrderId: this.status.exitOrderId,
      entryPricePusd: this.status.entryPricePusd,
      plannedShares: this.status.plannedShares,
      remainingShares: this.status.remainingShares,
      takeProfitPricePusd: this.status.takeProfitPricePusd,
      exitSellFloorPusd: this.status.exitSellFloorPusd,
      exitTriggered: this.status.exitTriggered,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private async callHelper(
    action: "submit_fak_buy" | "submit_fak_sell" | "get_orders",
    payload: Record<string, unknown>,
  ): Promise<HelperResult & OrderStatusResult> {
    const python = executionPython();
    if (!python || !existsSync(EXECUTION_HELPER)) throw new Error("Single-leg CLOB execution bridge is unavailable");
    const { stdout, stderr } = await execFileAsync(
      python,
      [EXECUTION_HELPER, action, JSON.stringify(payload)],
      { timeout: 20_000, maxBuffer: 16 * 1024 },
    );
    if (stderr.trim()) logger.warn({ action, diagnostic: stderr.trim() }, "CLOB helper diagnostic output");
    return JSON.parse(stdout) as HelperResult & OrderStatusResult;
  }

  private setState(state: AutomaticPairExecutionStatus["state"], reason: string): void {
    const changed = this.status.state !== state || this.status.reason !== reason;
    this.status.state = state;
    this.status.reason = reason;
    if (changed) {
      this.status.lastActionAt = asIso(Date.now());
      logger.info({ state, reason }, "Directional single-leg execution state changed");
    }
  }
}