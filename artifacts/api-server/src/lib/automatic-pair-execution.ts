import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { calculateDefensePrice, calculateDynamicHedgeBudget, calculateValidBuyShares } from "./binance-signal";
import { isEntryPriceWithinBand, MAX_ENTRY_PRICE_PUSD } from "./entry-price-band";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
const API_SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTION_HELPER = path.resolve(API_SERVER_DIR, "scripts/manage_clob_pair.py");
const JOURNAL = process.env.POLYMARKET_SINGLE_EXECUTION_JOURNAL_PATH?.trim()
  ? path.resolve(process.env.POLYMARKET_SINGLE_EXECUTION_JOURNAL_PATH.trim())
  : path.resolve(API_SERVER_DIR, ".automatic-single-execution-journal.json");
export const INITIAL_ENTRY_BUDGET_PUSD = 1;
export const EXIT_TRIGGER_PRICE_OFFSET_PUSD = 0.05;
export type Direction = "UP" | "DOWN";
type Phase = "ENTRY" | "DEFENSE" | "TRACK_A" | "TRACK_C_ENTRY" | "TRACK_C_EXIT" | "SETTLEMENT_WAIT" | "COMPLETE";

export type AutomaticPairExecutionStatus = {
  mode: "BINANCE_DUAL_TRACK_FAK_GTC";
  enabled: boolean; armed: boolean;
  state: "DISABLED" | "PAUSED" | "WAITING_FOR_MARKET" | "ARMED" | "SUBMITTING" | "VERIFYING" | "PLACING_DEFENSE" | "WAITING_DUAL_TRACK" | "CANCELING_DEFENSE" | "TRACK_C_SUBMITTING" | "TRACK_C_WAITING_TAKE_PROFIT" | "EXITING" | "SETTLEMENT_WAIT" | "FILLED" | "HALTED";
  reason: string; lastActionAt: string | null; conditionId: string | null; side: Direction | null;
  entryOrderId: string | null; defenseOrderId: string | null; secondEntryOrderId: string | null; exitOrderId: string | null;
  unresolvedOrder: boolean; plannedShares: number | null; plannedCostPusd: number | null; entryPricePusd: number | null;
  defensePricePusd: number | null; defenseShares: number | null; defenseMatchedShares: number | null; takeProfitPricePusd: number | null; remainingShares: number | null;
  secondSide: Direction | null; secondShares: number | null; secondEntryPricePusd: number | null; secondTargetPusd: number | null;
  directionReason: string | null; branch: "A" | "B" | "C" | null; lastError: string | null;
};

export type PairExecutionCandidate = {
  ready: boolean;
  market: { conditionId: string | null; yesTokenId: string | null; noTokenId: string | null; endAt: number | null; negRisk: boolean };
  quotes: { yesBestAsk: number | null; yesAskSize?: number | null; noBestAsk: number | null; noAskSize?: number | null; yesBestBid: number | null; yesBidSize?: number | null; noBestBid: number | null; noBidSize?: number | null; yesBidDepth?: number | null; yesAskDepth?: number | null; noBidDepth?: number | null; noAskDepth?: number | null; combinedAsk?: number | null; fresh: boolean };
  signal: { btcDirection: Direction | null; bookDirection: Direction | null; selectedDirection: Direction | null; confirmed: boolean; reason: string };
  walletBalancePusd: number | null; walletFresh?: boolean; inventory: { yesShares: number | null; noShares: number | null; fresh?: boolean };
};
type Order = { orderId?: string; status?: string; sizeMatched?: number | string | null; executedPrice?: number | string | null; price?: number | string | null };
type Result = { ok?: boolean; code?: string; detail?: string; orders?: Order[] };
type Journal = { phase: Phase; conditionId: string; side: Direction; tokenId: string; oppositeTokenId: string; entryOrderId: string | null; defenseOrderId: string | null; secondEntryOrderId: string | null; exitOrderId: string | null; submissionId?: string | null; stopRequested?: boolean; entryPricePusd: number; shares: number; defensePricePusd: number | null; defenseMatchedShares?: number | null; secondSide: Direction | null; secondShares: number | null; secondEntryPricePusd: number | null; secondTargetPusd: number | null; branch: "A" | "B" | "C" | null; createdAt: string; updatedAt: string };

const n = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
const iso = (v: number) => new Date(v).toISOString();
const terminal = (s: string) => ["CANCELED", "CANCELLED", "EXPIRED", "UNMATCHED", "FAILED", "REJECTED"].includes(s.toUpperCase());
const filled = (s: string) => ["MATCHED", "FILLED"].includes(s.toUpperCase());
const opposite = (side: Direction): Direction => side === "UP" ? "DOWN" : "UP";
const cents = (v: number) => Number(v.toFixed(2));
/** Largest valid four-decimal CLOB BUY size whose cent maker amount is within both caps. */
export const sharesFor = calculateValidBuyShares;
type JournalLoad = { kind: "ABSENT" } | { kind: "VALID"; journal: Journal } | { kind: "INVALID"; reason: string };
function load(journalPath = JOURNAL): JournalLoad {
  if (!existsSync(journalPath)) return { kind: "ABSENT" };
  try {
    const j = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
    return ["ENTRY", "DEFENSE", "TRACK_A", "TRACK_C_ENTRY", "TRACK_C_EXIT", "SETTLEMENT_WAIT", "COMPLETE"].includes(j.phase) && Boolean(j.conditionId && j.tokenId && j.oppositeTokenId) && (j.side === "UP" || j.side === "DOWN")
      ? { kind: "VALID", journal: j }
      : { kind: "INVALID", reason: "Journal schema validation failed." };
  } catch (error) { return { kind: "INVALID", reason: error instanceof Error ? error.message : "Journal is unreadable." }; }
}
function save(j: Journal, journalPath = JOURNAL) { const tmp = `${journalPath}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(j), { mode: 0o600 }); renameSync(tmp, journalPath); }
function clear(journalPath = JOURNAL) { if (existsSync(journalPath)) unlinkSync(journalPath); }
function python(): string | null {
  const configured = process.env.POLYMARKET_EXECUTION_PYTHON?.trim(); if (configured) return configured;
  return [path.resolve(process.cwd(), ".pythonlibs/bin/python"), path.resolve(API_SERVER_DIR, "../../.pythonlibs/bin/python"), path.resolve(process.cwd(), ".venv/bin/python3")].find(existsSync) ?? null;
}
export function isCLOBSingleLegBridgeAvailable(): boolean { return Boolean(python() && existsSync(EXECUTION_HELPER) && process.env.POLYMARKET_PRIVATE_KEY?.trim() && process.env.POLYMARKET_FUNDER?.trim() && process.env.RESIDENTIAL_PROXY_URL?.trim()); }
export const isCLOBTwoLegBridgeAvailable = isCLOBSingleLegBridgeAvailable;
export type SupervisorHelper = (action: "submit_fak_buy" | "submit_fak_sell" | "submit_gtc_buy" | "cancel_orders" | "get_orders" | "recover_order", payload: Record<string, unknown>) => Promise<Result>;
export type SupervisorOptions = { journalPath?: string; helper?: SupervisorHelper; bridgeAvailable?: boolean };

export class AutomaticPairExecutionSupervisor {
  private status: AutomaticPairExecutionStatus = { mode: "BINANCE_DUAL_TRACK_FAK_GTC", enabled: false, armed: false, state: "DISABLED", reason: "LIVE_TRADING_ENABLED is not set.", lastActionAt: null, conditionId: null, side: null, entryOrderId: null, defenseOrderId: null, secondEntryOrderId: null, exitOrderId: null, unresolvedOrder: false, plannedShares: null, plannedCostPusd: null, entryPricePusd: null, defensePricePusd: null, defenseShares: null, defenseMatchedShares: null, takeProfitPricePusd: null, remainingShares: null, secondSide: null, secondShares: null, secondEntryPricePusd: null, secondTargetPusd: null, directionReason: null, branch: null, lastError: null };
  private tokenId: string | null = null; private oppositeTokenId: string | null = null; private phase: Phase | null = null;
  private completed: string | null = null; private busy = false; private lastPoll = 0;
  private stopRequested = false; private submissionId: string | null = null;
  private invalidJournal = false;
  private readonly journalPath: string; private readonly helperOverride?: SupervisorHelper; private readonly bridgeAvailableOverride?: boolean;
  constructor(options: SupervisorOptions = {}) {
    this.journalPath = options.journalPath ?? JOURNAL; this.helperOverride = options.helper; this.bridgeAvailableOverride = options.bridgeAvailable;
    const loaded = load(this.journalPath);
    if (loaded.kind === "ABSENT") return;
    if (loaded.kind === "INVALID") {
      this.invalidJournal = true;
      this.set("PAUSED", `Execution journal is invalid or unreadable (${loaded.reason}); ARM is blocked pending explicit operator/account reconciliation.`);
      return;
    }
    const j = loaded.journal;
    if (j.phase === "COMPLETE") { this.completed = j.conditionId; this.set("PAUSED", "Recovered terminal condition marker; manual ARM is required for a new condition."); return; }
    this.phase = j.phase; this.tokenId = j.tokenId; this.oppositeTokenId = j.oppositeTokenId; this.stopRequested = j.stopRequested === true; this.submissionId = j.submissionId ?? null;
    Object.assign(this.status, { state: "PAUSED", reason: "Recovered journal requires manual ARM; all order outcomes will be reconciled first.", armed: false, conditionId: j.conditionId, side: j.side, entryOrderId: j.entryOrderId, defenseOrderId: j.defenseOrderId, secondEntryOrderId: j.secondEntryOrderId, exitOrderId: j.exitOrderId, entryPricePusd: j.entryPricePusd, plannedShares: j.shares, plannedCostPusd: cents(j.entryPricePusd * j.shares), remainingShares: j.shares, defensePricePusd: j.defensePricePusd, defenseShares: j.shares, defenseMatchedShares: j.defenseMatchedShares ?? null, secondSide: j.secondSide, secondShares: j.secondShares, secondEntryPricePusd: j.secondEntryPricePusd, secondTargetPusd: j.secondTargetPusd, branch: j.branch });
  }
  snapshot() { return { ...this.status }; }
  async arm() { if (this.status.state === "HALTED" || this.invalidJournal) { if (this.invalidJournal) this.set("PAUSED", "ARM blocked: invalid execution journal requires explicit operator/account reconciliation."); return this.snapshot(); } if (process.env.LIVE_TRADING_ENABLED !== "true" || !this.bridgeAvailable()) { this.set("PAUSED", "Live execution bridge, credentials, or master switch is unavailable."); return this.snapshot(); } this.status.armed = true; this.set(this.phase ? "VERIFYING" : "ARMED", this.phase ? "Manual arm accepted; reconciling recovered dual-track journal." : "Manual arm accepted; waiting for Binance-confirmed entry."); return this.snapshot(); }
  async pause() { this.status.armed = false; this.set("PAUSED", "Operator paused entries; active journal is retained and no destructive action is inferred."); return this.snapshot(); }
  async emergencyStop() {
    this.status.armed = false;
    this.stopRequested = true; this.persist();
    if (this.busy) { this.set("PAUSED", "Durable stop fence is set; in-flight work may only reconcile and cannot submit another order."); return this.snapshot(); }
    this.busy = true;
    try {
      await this.finalizeStop();
      return this.snapshot();
    } catch (e) { this.unknown("Emergency stop encountered an unknown defense cancellation outcome."); return this.snapshot(); }
    finally { this.busy = false; }
  }
  async evaluate(c: PairExecutionCandidate): Promise<void> {
    this.status.enabled = process.env.LIVE_TRADING_ENABLED === "true";
    if (!this.status.enabled) return void this.set("DISABLED", "LIVE_TRADING_ENABLED is not set.");
    if (this.status.state === "HALTED" || this.busy) return;
    this.busy = true;
    try {
      if (this.stopRequested) { await this.finalizeStop(); return; }
      if (this.phase) await this.manage(c);
      else await this.enter(c);
    } catch (e) { this.status.unresolvedOrder = true; this.status.lastError = e instanceof Error ? e.message.slice(0, 180) : "Unknown execution error"; this.set("PAUSED", "Order lifecycle is unknown; fail-closed until manual reconciliation."); }
    finally { this.busy = false; }
  }
  private async enter(c: PairExecutionCandidate) {
    if (this.stopRequested) return;
    if (!this.status.armed) return void this.set("PAUSED", "Manual ARM is required after every restart.");
    if (this.completed === c.market.conditionId) return void this.set("FILLED", "One trade has already completed for this five-minute condition.");
    if (this.completed && this.completed !== c.market.conditionId) { clear(this.journalPath); this.completed = null; }
    const bad = this.entryBlock(c); if (bad) return void this.set("WAITING_FOR_MARKET", bad);
    const side = c.signal.selectedDirection!; const ask = side === "UP" ? c.quotes.yesBestAsk! : c.quotes.noBestAsk!;
    const limit = cents(Math.min(ask + 0.01, MAX_ENTRY_PRICE_PUSD)); const shares = sharesFor(INITIAL_ENTRY_BUDGET_PUSD, c.walletBalancePusd!, limit);
    if (!shares) return void this.set("WAITING_FOR_MARKET", "Verified wallet cannot fund a valid fixed 1.00 pUSD initial order.");
    this.status.conditionId = c.market.conditionId; this.status.side = side; this.status.plannedShares = shares; this.status.remainingShares = shares; this.status.plannedCostPusd = cents(shares * limit); this.status.entryPricePusd = limit; this.status.directionReason = c.signal.reason; this.tokenId = side === "UP" ? c.market.yesTokenId! : c.market.noTokenId!; this.oppositeTokenId = side === "UP" ? c.market.noTokenId! : c.market.yesTokenId!; this.phase = "ENTRY"; this.persist();
    this.set("SUBMITTING", `Submitting ${side} FAK BUY at observed ask + 0.01, capped at 0.82.`);
    this.submissionId = this.newSubmissionId(); this.persist();
    const r = await this.helper("submit_fak_buy", { tokenId: this.tokenId, leg: side, price: limit, size: shares, clientId: this.submissionId }); const id = r.orders?.[0]?.orderId ?? null;
    if (this.stopRequested) { this.status.entryOrderId = id; this.persist(); return; }
    if (!r.ok || !id) { clear(this.journalPath); this.reset(); return void this.set("WAITING_FOR_MARKET", `Initial FAK was rejected: ${r.code ?? "UNKNOWN"}.`); }
    this.status.entryOrderId = id; this.status.unresolvedOrder = true; this.persist(); await this.reconcileEntry();
  }
  private entryBlock(c: PairExecutionCandidate): string | null {
    if (!this.bridgeAvailable()) return "CLOB bridge or credentials unavailable.";
    if (!c.ready || !c.quotes.fresh) return "Fresh Binance, market, and CLOB quotes are required.";
    if (!c.market.conditionId || !c.market.yesTokenId || !c.market.noTokenId || c.market.endAt === null) return "Verified active BTC five-minute market required.";
    if (!c.signal.confirmed || !c.signal.selectedDirection) return c.signal.reason;
    const ask = c.signal.selectedDirection === "UP" ? c.quotes.yesBestAsk : c.quotes.noBestAsk;
    if (ask === null || !isEntryPriceWithinBand(ask)) return "Selected observed ask must be within the server-side 0.40–0.82 cap.";
    if (c.walletFresh === false || c.walletBalancePusd === null || c.walletBalancePusd <= 0) return "Fresh verified positive wallet balance required.";
    if (c.walletBalancePusd < INITIAL_ENTRY_BUDGET_PUSD) return "Verified wallet must contain at least 1.00 pUSD for the fixed initial entry.";
    if (c.inventory.fresh === false || c.inventory.yesShares === null || c.inventory.noShares === null || c.inventory.yesShares > .01 || c.inventory.noShares > .01) return "Fresh zero Up/Down inventory is required.";
    return null;
  }
  private async manage(c: PairExecutionCandidate) {
    if (!this.status.armed) return void this.set("PAUSED", "Manual ARM required to resume the persisted order lifecycle.");
    if (this.phase === "ENTRY") return void await this.reconcileEntry();
    if (this.phase === "DEFENSE") return void await this.reconcileDefense();
    if (this.phase === "TRACK_C_ENTRY") return void await this.reconcileSecondEntry();
    if (this.phase === "TRACK_C_EXIT") return void await this.manageSecondExit(c);
    if (this.phase === "SETTLEMENT_WAIT") {
      if (c.market.conditionId && c.market.conditionId !== this.status.conditionId) { this.phase = "COMPLETE"; this.persist(); this.completed = this.status.conditionId; this.reset(); return void await this.enter(c); }
      return void this.set("SETTLEMENT_WAIT", "Defense fill is confirmed; take-profit actions are disabled pending market settlement.");
    }
    await this.reconcileDefense();
    if (this.phase !== "TRACK_A") return;
    const side = this.status.side!; const bid = side === "UP" ? c.quotes.yesBestBid : c.quotes.noBestBid;
    const reversal = c.signal.confirmed && c.signal.selectedDirection === opposite(side);
    if (reversal) return void await this.startTrackC(c);
    if (bid !== null && c.quotes.fresh && this.status.entryPricePusd !== null && bid >= this.status.entryPricePusd + .05) await this.startTrackA(bid);
    else this.set("WAITING_DUAL_TRACK", "Defense is resting; waiting for original +0.05 bid or confirmed opposite Binance reversal.");
  }
  private async reconcileEntry() {
    if (!this.status.entryOrderId) this.status.entryOrderId = await this.recover(this.tokenId);
    const o = await this.order(this.status.entryOrderId); if (!o) return void this.unknown("Initial FAK status unavailable.");
    const matched = n(o.sizeMatched) ?? 0; const st = String(o.status ?? "UNKNOWN");
    const executed = n(o.executedPrice);
    if (matched > 0 && (filled(st) || terminal(st))) {
      if (executed === null || executed <= 0) return void this.unknown("Initial fill price cannot be proven from CLOB execution data.");
      this.status.remainingShares = matched; this.status.plannedShares = matched; this.status.entryPricePusd = executed; this.status.plannedCostPusd = cents(matched * executed); this.status.unresolvedOrder = false; this.phase = "DEFENSE"; this.persist(); return void await this.placeDefense();
    }
    if (matched === 0 && terminal(st)) { clear(this.journalPath); this.reset(); return void this.set("WAITING_FOR_MARKET", "Initial FAK ended with no fill."); }
    this.set("VERIFYING", `Initial FAK is ${st}; duplicate entries are blocked.`);
  }
  private async placeDefense() {
    if (this.stopRequested) return;
    const price = calculateDefensePrice(this.status.entryPricePusd!); if (!price || !this.oppositeTokenId) return void this.unknown("Cannot calculate valid defense order.");
    this.status.defensePricePusd = price; this.status.defenseShares = this.status.remainingShares; this.set("PLACING_DEFENSE", "Initial fill confirmed; placing opposite GTC defense before monitoring either track."); this.persist();
    this.submissionId = this.newSubmissionId(); this.persist();
    const r = await this.helper("submit_gtc_buy", { tokenId: this.oppositeTokenId, leg: opposite(this.status.side!), price, size: this.status.remainingShares, clientId: this.submissionId });
    const id = r.orders?.[0]?.orderId ?? null; if (!r.ok || !id) return void this.unknown(`Defense GTC rejected: ${r.code ?? "UNKNOWN"}.`);
    if (this.stopRequested) { this.status.defenseOrderId = id; this.persist(); return; }
    this.status.defenseOrderId = id; this.phase = "TRACK_A"; this.persist(); await this.reconcileDefense();
  }
  private async reconcileDefense() {
    if (!this.status.defenseOrderId) this.status.defenseOrderId = await this.recover(this.oppositeTokenId);
    if (!this.status.defenseOrderId) return void this.unknown("Defense order recovery was not unique.");
    if (Date.now() - this.lastPoll < 100) return; this.lastPoll = Date.now();
    const o = await this.order(this.status.defenseOrderId); if (!o) return void this.unknown("Defense status unavailable.");
    const matched = n(o.sizeMatched) ?? 0; const required = this.status.defenseShares ?? this.status.remainingShares ?? Infinity; const st = String(o.status ?? "UNKNOWN");
    this.status.defenseMatchedShares = matched;
    if (matched >= required - .0001 || (matched > 0 && filled(st))) { this.status.branch = "B"; this.phase = "SETTLEMENT_WAIT"; this.persist(); return void this.set("SETTLEMENT_WAIT", "Defense GTC fully filled; original take-profit and secondary actions are permanently disabled."); }
    if (matched > .0001) {
      this.status.branch = "B"; this.persist(); this.set("CANCELING_DEFENSE", "Defense partially filled; canceling and reconciling its remaining GTC before settlement wait.");
      if (!await this.cancelDefense()) {
        if (this.phase === "SETTLEMENT_WAIT") return;
        return void this.unknown("Partial defense remaining GTC cannot be conclusively canceled.");
      }
      this.phase = "SETTLEMENT_WAIT"; this.persist(); return void this.set("SETTLEMENT_WAIT", "Partial defense GTC was canceled and reconciled; take-profit actions are disabled pending settlement.");
    }
    if (terminal(st)) return void this.unknown(`Defense became ${st} without a fill.`);
  }
  private async cancelDefense(): Promise<boolean> {
    if (!this.status.defenseOrderId) return false;
    const r = await this.helper("cancel_orders", { orderIds: [this.status.defenseOrderId] }); if (!r.ok) return false;
    const o = await this.order(this.status.defenseOrderId); if (!o) return false;
    const matched = n(o.sizeMatched) ?? 0;
    if (matched > .0001) { this.status.defenseMatchedShares = matched; this.status.branch = "B"; this.phase = "SETTLEMENT_WAIT"; this.persist(); this.set("SETTLEMENT_WAIT", "Defense cancellation raced a fill; settlement wait is mandatory."); return false; }
    if (!terminal(String(o.status ?? ""))) return false;
    this.status.defenseOrderId = null; return true;
  }
  private async startTrackA(bid: number) {
    this.status.branch = "A"; this.set("CANCELING_DEFENSE", "Original bid reached +0.05; canceling and reconciling defense before original FAK sale."); if (!await this.cancelDefense()) { if (this.phase === "SETTLEMENT_WAIT") return; return void this.unknown("Defense cancellation is not conclusively reconciled."); }
    this.phase = "TRACK_A"; this.persist(); await this.sell(this.tokenId!, this.status.side!, this.status.remainingShares!, bid, "A");
  }
  private async startTrackC(c: PairExecutionCandidate) {
    if (this.stopRequested) return;
    this.status.branch = "C"; this.set("CANCELING_DEFENSE", "Confirmed opposite Binance wall/flow reversal; canceling defense before secondary entry."); if (!await this.cancelDefense()) { if (this.phase === "SETTLEMENT_WAIT") return; return void this.unknown("Defense cancellation is not conclusively reconciled."); }
    const side = opposite(this.status.side!); const ask = side === "UP" ? c.quotes.yesBestAsk : c.quotes.noBestAsk; if (ask === null || c.walletBalancePusd === null) return void this.unknown("Fresh opposite ask and verified wallet required for reversal.");
    const plan = calculateDynamicHedgeBudget(this.status.plannedCostPusd!, ask, c.walletBalancePusd); const limit = cents(ask + .02); if (!plan || limit >= 1) return void this.unknown("Reversal hedge budget or price is invalid.");
    const shares = sharesFor(plan.budgetPusd, c.walletBalancePusd, limit); if (!shares) return void this.unknown("Verified wallet cannot fund reversal hedge.");
    this.status.secondSide = side; this.status.secondShares = shares; this.status.secondEntryPricePusd = limit; this.status.secondTargetPusd = plan.targetPusd; this.phase = "TRACK_C_ENTRY"; this.persist(); this.set("TRACK_C_SUBMITTING", `Submitting opposite FAK BUY; target is ${plan.targetPusd.toFixed(2)}.`);
    this.submissionId = this.newSubmissionId(); this.persist();
    const r = await this.helper("submit_fak_buy", { tokenId: this.oppositeTokenId!, leg: side, price: limit, size: shares, clientId: this.submissionId }); const id = r.orders?.[0]?.orderId ?? null;
    if (this.stopRequested) { this.status.secondEntryOrderId = id; this.persist(); return; }
    if (!r.ok || !id) return void this.unknown(`Secondary FAK rejected: ${r.code ?? "UNKNOWN"}.`); this.status.secondEntryOrderId = id; this.persist(); await this.reconcileSecondEntry();
  }
  private async reconcileSecondEntry() {
    if (!this.status.secondEntryOrderId) this.status.secondEntryOrderId = await this.recover(this.oppositeTokenId);
    const o = await this.order(this.status.secondEntryOrderId); if (!o) return void this.unknown("Secondary FAK status unavailable.");
    const matched = n(o.sizeMatched) ?? 0; const st = String(o.status ?? "UNKNOWN");
    const executed = n(o.executedPrice);
    if (matched > 0 && (filled(st) || terminal(st))) {
      if (executed === null || executed <= 0) return void this.unknown("Secondary fill price cannot be proven from CLOB execution data.");
      this.status.secondShares = matched; this.status.secondEntryPricePusd = executed; this.phase = "TRACK_C_EXIT"; this.persist(); return void this.set("TRACK_C_WAITING_TAKE_PROFIT", "Secondary opposite position filled; original position remains for settlement.");
    }
    if (matched === 0 && terminal(st)) return void this.unknown("Secondary FAK terminated with zero fill; original position remains for settlement.");
    this.set("VERIFYING", `Secondary FAK is ${st}; duplicate secondary orders are blocked.`);
  }
  private async manageSecondExit(c: PairExecutionCandidate) {
    const bid = this.status.secondSide === "UP" ? c.quotes.yesBestBid : c.quotes.noBestBid;
    if (bid === null || !c.quotes.fresh || this.status.secondTargetPusd === null || bid < this.status.secondTargetPusd) return void this.set("TRACK_C_WAITING_TAKE_PROFIT", "Waiting for secondary opposite bid to reach dynamic target; original remains for settlement.");
    await this.sell(this.oppositeTokenId!, this.status.secondSide!, this.status.secondShares!, bid, "C");
  }
  private async sell(tokenId: string, side: Direction, size: number, bid: number, branch: "A" | "C") {
    if (this.stopRequested) return;
    this.submissionId = this.newSubmissionId(); this.persist();
    this.set("EXITING", `Submitting ${side} FAK SELL at current best bid.`); const r = await this.helper("submit_fak_sell", { tokenId, leg: side, price: cents(bid), size, clientId: this.submissionId }); const id = r.orders?.[0]?.orderId ?? null;
    if (this.stopRequested) { this.status.exitOrderId = id; this.persist(); return; }
    if (!r.ok || !id) return void this.unknown(`FAK sell rejected: ${r.code ?? "UNKNOWN"}.`); this.status.exitOrderId = id; this.persist();
    const o = await this.order(id); if (!o) return void this.unknown("FAK sell status unavailable."); const matched = n(o.sizeMatched) ?? 0;
    if (matched + .0001 < size) return void this.unknown("FAK sell partial or unknown; no duplicate sale will be submitted.");
    if (branch === "A") { const condition = this.status.conditionId; this.phase = "COMPLETE"; this.persist(); this.reset(); this.completed = condition; this.set("FILLED", "Track A original take-profit completed; condition is closed to further trades."); }
    else { this.phase = "SETTLEMENT_WAIT"; this.persist(); this.set("SETTLEMENT_WAIT", "Track C secondary take-profit completed; original position remains for settlement."); }
  }
  private async order(id: string | null): Promise<Order | null> { if (!id) return null; const r = await this.helper("get_orders", { orderIds: [id] }); return r.ok && r.orders?.length === 1 ? r.orders[0] : null; }
  private async recover(tokenId: string | null): Promise<string | null> {
    if (!tokenId || !this.submissionId) return null;
    const r = await this.helper("recover_order", { tokenId, clientId: this.submissionId });
    if (r.ok && r.orders?.length === 1 && typeof r.orders[0].orderId === "string") return r.orders[0].orderId;
    this.status.unresolvedOrder = true; this.persist();
    this.set("HALTED", "Submission recovery produced zero or multiple matches; operator reconciliation is required.");
    return null;
  }
  private async helper(action: "submit_fak_buy" | "submit_fak_sell" | "submit_gtc_buy" | "cancel_orders" | "get_orders" | "recover_order", payload: Record<string, unknown>): Promise<Result> {
    if (this.stopRequested && action.startsWith("submit_")) throw new Error("STOP_FENCE");
    if (this.helperOverride) return this.helperOverride(action, payload);
    const p = python(); if (!p || !existsSync(EXECUTION_HELPER)) throw new Error("CLOB execution bridge unavailable");
    const { stdout, stderr } = await execFileAsync(p, [EXECUTION_HELPER, action, JSON.stringify(payload)], { timeout: 20_000, maxBuffer: 16 * 1024 });
    if (stderr.trim()) logger.warn({ action, diagnostic: stderr.trim() }, "CLOB helper diagnostic"); return JSON.parse(stdout) as Result;
  }
  private persist() { if (!this.phase || !this.status.conditionId || !this.status.side || !this.tokenId || !this.oppositeTokenId || this.status.entryPricePusd === null || this.status.plannedShares === null) return; const loaded = load(this.journalPath); const createdAt = loaded.kind === "VALID" ? loaded.journal.createdAt : iso(Date.now()); save({ phase: this.phase, conditionId: this.status.conditionId, side: this.status.side, tokenId: this.tokenId, oppositeTokenId: this.oppositeTokenId, entryOrderId: this.status.entryOrderId, defenseOrderId: this.status.defenseOrderId, secondEntryOrderId: this.status.secondEntryOrderId, exitOrderId: this.status.exitOrderId, submissionId: this.submissionId, stopRequested: this.stopRequested, entryPricePusd: this.status.entryPricePusd, shares: this.status.plannedShares, defensePricePusd: this.status.defensePricePusd, defenseMatchedShares: this.status.defenseMatchedShares, secondSide: this.status.secondSide, secondShares: this.status.secondShares, secondEntryPricePusd: this.status.secondEntryPricePusd, secondTargetPusd: this.status.secondTargetPusd, branch: this.status.branch, createdAt, updatedAt: iso(Date.now()) }, this.journalPath); }
  private bridgeAvailable() { return this.bridgeAvailableOverride ?? isCLOBSingleLegBridgeAvailable(); }
  private newSubmissionId() { return `0x${createHash("sha256").update(randomUUID()).digest("hex")}`; }
  private async finalizeStop() {
    if (this.phase === "ENTRY") {
      if (!this.status.entryOrderId) this.status.entryOrderId = await this.recover(this.tokenId);
      if (!this.status.entryOrderId) return void this.unknown("Deferred stop cannot uniquely recover the initial FAK.");
      const order = await this.order(this.status.entryOrderId);
      if (!order) return void this.unknown("Deferred stop cannot determine initial FAK status.");
      const matched = n(order.sizeMatched) ?? 0;
      const status = String(order.status ?? "UNKNOWN");
      if (matched > 0) {
        const executed = n(order.executedPrice);
        this.status.remainingShares = matched;
        this.status.plannedShares = matched;
        if (executed !== null && executed > 0) {
          this.status.entryPricePusd = executed;
          this.status.plannedCostPusd = cents(executed * matched);
        }
        this.status.unresolvedOrder = true;
        this.persist();
        return void this.set("PAUSED", "Stop reconciled a filled initial FAK; exposed inventory is journaled and requires operator reconciliation. No defense was submitted.");
      }
      if (!terminal(status)) return void this.unknown(`Deferred stop found initial FAK status ${status}; holdings remain unknown.`);
    }
    if (this.phase === "TRACK_A" && (this.status.exitOrderId || this.status.state === "EXITING")) {
      if (!this.status.exitOrderId && this.submissionId) this.status.exitOrderId = await this.recover(this.tokenId);
      if (!this.status.exitOrderId) return void this.unknown("Deferred stop cannot uniquely recover the Track-A exit; original holdings remain exposed.");
      const order = await this.order(this.status.exitOrderId);
      if (!order) return void this.unknown("Deferred stop cannot determine Track-A exit status.");
      const matched = n(order.sizeMatched) ?? 0;
      const required = this.status.remainingShares ?? this.status.plannedShares ?? Infinity;
      const status = String(order.status ?? "UNKNOWN");
      if (matched >= required - .0001 && (filled(status) || terminal(status))) {
        this.stopRequested = false;
        this.phase = "COMPLETE";
        this.persist();
        this.completed = this.status.conditionId;
        return void this.set("HALTED", "Deferred stop confirmed the Track-A exit fully completed; no tracked holdings remain.");
      }
      this.status.remainingShares = Math.max(0, Number((required - matched).toFixed(4)));
      this.status.unresolvedOrder = true;
      this.persist();
      return void this.set("PAUSED", `Track-A exit is ${status} with ${matched} matched; residual/unknown holdings require operator reconciliation.`);
    }
    if (this.phase === "TRACK_C_ENTRY" || this.phase === "TRACK_C_EXIT") {
      const id = this.phase === "TRACK_C_ENTRY" ? this.status.secondEntryOrderId : this.status.exitOrderId;
      const order = await this.order(id);
      if (!order) return void this.unknown("Deferred stop cannot determine secondary entry/exit status.");
      this.status.unresolvedOrder = true;
      this.persist();
      return void this.set("PAUSED", "Stop reconciled an active secondary entry/exit lifecycle; journaled holdings require operator reconciliation.");
    }
    if (!this.status.defenseOrderId && this.phase === "DEFENSE") this.status.defenseOrderId = await this.recover(this.oppositeTokenId);
    if (this.status.state === "HALTED" && !this.status.defenseOrderId) return;
    if (this.status.defenseOrderId && !await this.cancelDefense()) return void this.unknown("Deferred stop cannot conclusively reconcile defense.");
    this.stopRequested = false; this.persist(); this.set("HALTED", "Deferred stop completed; known resting defense is conclusively reconciled and submissions remain fenced.");
  }
  private unknown(reason: string) { this.status.unresolvedOrder = true; this.persist(); this.set("PAUSED", `${reason} Fail-closed: manual ARM/reconciliation is required.`); }
  private reset() { this.phase = null; this.tokenId = null; this.oppositeTokenId = null; Object.assign(this.status, { conditionId: null, side: null, entryOrderId: null, defenseOrderId: null, secondEntryOrderId: null, exitOrderId: null, unresolvedOrder: false, plannedShares: null, plannedCostPusd: null, entryPricePusd: null, defensePricePusd: null, defenseShares: null, defenseMatchedShares: null, takeProfitPricePusd: null, remainingShares: null, secondSide: null, secondShares: null, secondEntryPricePusd: null, secondTargetPusd: null, directionReason: null, branch: null, lastError: null }); }
  private set(state: AutomaticPairExecutionStatus["state"], reason: string) { const changed = this.status.state !== state || this.status.reason !== reason; this.status.state = state; this.status.reason = reason; if (changed) { this.status.lastActionAt = iso(Date.now()); logger.info({ state, reason }, "Binance dual-track execution state changed"); } }
}
export function createAutomaticPairExecutionSupervisor(options: SupervisorOptions = {}) { return new AutomaticPairExecutionSupervisor(options); }