import { execFile } from "node:child_process";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
const API_SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTION_HELPER = path.resolve(API_SERVER_DIR, "scripts/manage_clob_pair.py");
const EXECUTION_JOURNAL_PATH = process.env.POLYMARKET_EXECUTION_JOURNAL_PATH?.trim()
  ? path.resolve(process.env.POLYMARKET_EXECUTION_JOURNAL_PATH.trim())
  : path.resolve(API_SERVER_DIR, ".automatic-pair-execution-journal.json");
const MIN_EDGE = 0.005;
const MAX_COMBINED_ASK = 0.995;
const RECONCILE_INTERVAL_MS = 500;
const RETRY_COOLDOWN_MS = 15_000;
const RESCUE_MERGE_PROFIT_PUSD = 0.02;
const RESCUE_STOP_LOSS_FRACTION = 0.1;
const RESCUE_ORDER_POLL_ATTEMPTS = 4;
const RESCUE_ORDER_POLL_MS = 250;

export type AutomaticPairExecutionStatus = {
  mode: "CLOB_TWO_LEG_FOK";
  enabled: boolean;
  armed: boolean;
  state: "DISABLED" | "PAUSED" | "WAITING_FOR_MARKET" | "ARMED" | "SUBMITTING" | "VERIFYING" | "RECOVERING" | "MERGING" | "FILLED" | "HALTED";
  reason: string;
  lastActionAt: string | null;
  conditionId: string | null;
  yesOrderId: string | null;
  noOrderId: string | null;
  unresolvedLeg: boolean;
  plannedShares: number | null;
  plannedCostPusd: number | null;
  // Purely observational, does not affect any decision: records the last
  // time the bot actually attempted a submission (blockReason === "READY"),
  // the combined ask it attempted at, and the raw outcome/code/detail. This
  // exists because the opportunity log only records entries below its own
  // display threshold, and a fast market can pass READY for well under one
  // poll interval -- this field is set synchronously by the same code path
  // that submits, so it can never miss an attempt the way external polling
  // or a threshold-gated log can.
  lastAttemptAt: string | null;
  lastAttemptCombinedAsk: number | null;
  lastAttemptOutcome: string | null;
  recoveryAction: string | null;
  recoveryOrderId: string | null;
  mergeTxHash: string | null;
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
  quotes: { yesBestAsk: number | null; noBestAsk: number | null; commonDepth: number | null; fresh: boolean };
  walletBalancePusd: number | null;
};

type HelperOrder = { leg?: string; accepted?: boolean; orderId?: string | null };
type HelperResult = {
  ok?: boolean;
  code?: string;
  detail?: string;
  orders?: HelperOrder[];
  cancellationRequested?: boolean;
  noOrdersAccepted?: boolean;
  mergeTxHash?: string;
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
  phase: "SUBMITTING" | "ACKNOWLEDGED" | "RECOVERING" | "HEDGED" | "MERGING" | "UNCONFIRMED";
  conditionId: string | null;
  yesTokenId: string | null;
  noTokenId: string | null;
  yesLimitPrice: number | null;
  noLimitPrice: number | null;
  plannedShares: number | null;
  negRisk: boolean;
  yesOrderId: string | null;
  noOrderId: string | null;
  recoveryOrderId: string | null;
  createdAt: string;
  updatedAt: string;
};

function loadExecutionJournal(): ExecutionJournal | null {
  if (!existsSync(EXECUTION_JOURNAL_PATH)) return null;
  try {
    const parsed = JSON.parse(readFileSync(EXECUTION_JOURNAL_PATH, "utf8")) as Partial<ExecutionJournal>;
    if (
      !["SUBMITTING", "ACKNOWLEDGED", "RECOVERING", "HEDGED", "MERGING", "UNCONFIRMED"].includes(String(parsed.phase)) ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.updatedAt !== "string"
    ) {
      throw new Error("Invalid execution journal");
    }
    return {
      phase: parsed.phase as ExecutionJournal["phase"],
      conditionId: typeof parsed.conditionId === "string" ? parsed.conditionId : null,
      yesTokenId: typeof parsed.yesTokenId === "string" ? parsed.yesTokenId : null,
      noTokenId: typeof parsed.noTokenId === "string" ? parsed.noTokenId : null,
      yesLimitPrice: typeof parsed.yesLimitPrice === "number" ? parsed.yesLimitPrice : null,
      noLimitPrice: typeof parsed.noLimitPrice === "number" ? parsed.noLimitPrice : null,
      plannedShares: typeof parsed.plannedShares === "number" ? parsed.plannedShares : null,
      negRisk: parsed.negRisk === true,
      yesOrderId: typeof parsed.yesOrderId === "string" ? parsed.yesOrderId : null,
      noOrderId: typeof parsed.noOrderId === "string" ? parsed.noOrderId : null,
      recoveryOrderId: typeof parsed.recoveryOrderId === "string" ? parsed.recoveryOrderId : null,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    const timestamp = new Date(0).toISOString();
    return {
      phase: "UNCONFIRMED",
      conditionId: null,
      yesTokenId: null,
      noTokenId: null,
      yesLimitPrice: null,
      noLimitPrice: null,
      plannedShares: null,
      negRisk: false,
      yesOrderId: null,
      noOrderId: null,
      recoveryOrderId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
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
  // An explicit override is trusted as-is: it may be a bare command name (e.g.
  // "python3") meant to be resolved via $PATH, which existsSync() cannot check
  // since it only tests literal filesystem paths, not PATH lookups.
  if (configured) return configured;
  const candidates = [
    // Replit/Nix workspaces install the uv-managed interpreter here.
    path.resolve(process.cwd(), ".pythonlibs/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.pythonlibs/bin/python"),
    // Plain `uv sync` (e.g. on a self-hosted VPS) creates a standard .venv instead.
    path.resolve(process.cwd(), ".venv/bin/python3"),
    path.resolve(process.cwd(), ".venv/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python3"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python"),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function asIso(value: number): string {
  return new Date(value).toISOString();
}

function roundSharesDown(value: number): number {
  // Whole shares keep BUY maker amounts at cent precision when the market
  // price uses the usual two-decimal tick. The Python bridge performs a final
  // signed-order precision check before submitting either leg.
  return Math.floor(value + Number.EPSILON);
}

function isFilled(status: string): boolean {
  return ["MATCHED", "FILLED"].includes(status.toUpperCase());
}

function isTerminalUnfilled(status: string): boolean {
  return ["CANCELED", "CANCELLED", "EXPIRED", "UNMATCHED", "FAILED", "REJECTED"].includes(
    status.toUpperCase(),
  );
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function exactMatchedSize(order: OrderStatus, expected: number): boolean {
  const matched = finiteNumber(order.sizeMatched);
  return isFilled(String(order.status ?? "")) && matched !== null && Math.abs(matched - expected) <= 0.0001;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isCLOBTwoLegBridgeAvailable(): boolean {
  return Boolean(
    executionPython() &&
      existsSync(EXECUTION_HELPER) &&
      process.env.POLYMARKET_PRIVATE_KEY?.trim() &&
      process.env.POLYMARKET_FUNDER?.trim() &&
      process.env.RESIDENTIAL_PROXY_URL?.trim(),
  );
}

export class AutomaticPairExecutionSupervisor {
  private status: AutomaticPairExecutionStatus = {
    mode: "CLOB_TWO_LEG_FOK",
    enabled: false,
    armed: false,
    state: "DISABLED",
    reason: "LIVE_TRADING_ENABLED is not set.",
    lastActionAt: null,
    conditionId: null,
    yesOrderId: null,
    noOrderId: null,
    unresolvedLeg: false,
    plannedShares: null,
    plannedCostPusd: null,
    lastAttemptAt: null,
    lastAttemptCombinedAsk: null,
    lastAttemptOutcome: null,
    recoveryAction: null,
    recoveryOrderId: null,
    mergeTxHash: null,
  };
  private submitting = false;
  private inFlight = false;
  private cancelling = false;
  private recovering = false;
  private reconciling = false;
  private lastReconcileAt = 0;
  private completedConditionId: string | null = null;
  private retryAfterAt = 0;
  private yesTokenId: string | null = null;
  private noTokenId: string | null = null;
  private yesLimitPrice: number | null = null;
  private noLimitPrice: number | null = null;
  private negRisk = false;

  constructor() {
    const journal = loadExecutionJournal();
    if (journal) {
      this.status.state = "HALTED";
      this.status.reason = `An unresolved execution journal (${journal.phase}) requires operator review before trading can resume.`;
      this.status.unresolvedLeg = true;
      this.status.conditionId = journal.conditionId;
      this.status.yesOrderId = journal.yesOrderId;
      this.status.noOrderId = journal.noOrderId;
      this.status.recoveryOrderId = journal.recoveryOrderId;
      this.status.plannedShares = journal.plannedShares;
      this.status.lastActionAt = journal.updatedAt;
      this.yesTokenId = journal.yesTokenId;
      this.noTokenId = journal.noTokenId;
      this.yesLimitPrice = journal.yesLimitPrice;
      this.noLimitPrice = journal.noLimitPrice;
      this.negRisk = journal.negRisk;
    }
  }
  snapshot(): AutomaticPairExecutionStatus {
    return { ...this.status };
  }

  async evaluate(candidate: PairExecutionCandidate): Promise<void> {
    const enabled = process.env.LIVE_TRADING_ENABLED === "true";
    this.status.enabled = enabled;
    // HALTED is an operator/safety terminal state. The periodic watcher must
    // never silently turn it back into DISABLED or ARMED.
    if (this.status.state === "HALTED") return;
    if (!enabled) {
      this.status.armed = false;
      this.setState("DISABLED", "LIVE_TRADING_ENABLED is not set.");
      return;
    }
    if (!this.status.armed) {
      this.setState("PAUSED", "Press START AUTO EXECUTION to begin automatic execution.");
      return;
    }
    if (this.recovering) return;
    if (this.status.unresolvedLeg) {
      this.status.armed = false;
      this.setState("HALTED", "An unresolved execution requires operator review before trading can resume.");
      return;
    }
    if (this.retryAfterAt > Date.now()) {
      this.setState("WAITING_FOR_MARKET", "Execution cooldown is active; automatic retry will continue in 15 seconds.");
      return;
    }
    if (this.inFlight) {
      await this.reconcileIfDue(candidate);
      return;
    }
    if (candidate.market.conditionId && candidate.market.conditionId !== this.completedConditionId && this.status.state === "FILLED") {
      this.clearPair();
      this.setState("ARMED", "New BTC market window observed.");
    }
    if (candidate.market.conditionId && candidate.market.conditionId === this.completedConditionId) {
      this.setState("FILLED", "This BTC market window already completed one protected pair.");
      return;
    }
    const blockReason = this.blockReason(candidate);
    if (blockReason !== "READY") {
      this.setState("WAITING_FOR_MARKET", blockReason);
      return;
    }
    if (this.submitting) return;
    const shares = this.calculateShares(candidate);
    if (shares === null) {
      this.setState("WAITING_FOR_MARKET", "Verified wallet balance or common depth cannot fund one full pair.");
      return;
    }
    await this.submitPair(candidate, shares);
  }

  async emergencyStop(): Promise<AutomaticPairExecutionStatus> {
    this.status.armed = false;
    await this.cancelTrackedOrders("Operator kill switch is active.");
    this.setState("HALTED", "Operator kill switch is active.");
    return this.snapshot();
  }

  async arm(): Promise<AutomaticPairExecutionStatus> {
    if (this.status.state === "HALTED") {
      if (
        this.status.unresolvedLeg ||
        this.inFlight ||
        this.status.yesOrderId ||
        this.status.noOrderId
      ) {
        return this.snapshot();
      }
      this.setState(
        "PAUSED",
        "Execution reset after a clean halt. Press START again to begin.",
      );
    }
    if (process.env.LIVE_TRADING_ENABLED !== "true") {
      this.status.armed = false;
      this.setState("DISABLED", "Server master execution switch is not enabled.");
      return this.snapshot();
    }
    if (!isCLOBTwoLegBridgeAvailable()) {
      this.status.armed = false;
      this.setState("PAUSED", "CLOB two-leg execution bridge or credentials are unavailable.");
      return this.snapshot();
    }
    this.status.armed = true;
    this.setState("ARMED", "Operator armed automatic protected-pair execution.");
    return this.snapshot();
  }

  async pause(): Promise<AutomaticPairExecutionStatus> {
    this.status.armed = false;
    const cancelled = await this.cancelTrackedOrders("Operator paused automatic execution.");
    if (!cancelled) {
      this.status.unresolvedLeg = true;
      this.setState("HALTED", "Pause could not confirm tracked-order cancellation; bot halted.");
    } else if (this.status.state !== "HALTED") {
      this.setState(
        "PAUSED",
        "Operator paused automatic execution. Press START to arm the next protected pair.",
      );
    }
    return this.snapshot();
  }

  private blockReason(candidate: PairExecutionCandidate): string {
    if (!isCLOBTwoLegBridgeAvailable()) return "CLOB two-leg execution bridge or credentials are unavailable.";
    if (!candidate.ready || !candidate.quotes.fresh) return "Fresh CLOB books and BTC reference feed are required.";
    if (!candidate.market.conditionId || !candidate.market.yesTokenId || !candidate.market.noTokenId || candidate.market.endAt === null) {
      return "A verified active BTC 5-minute market is required.";
    }
    const { yesBestAsk, noBestAsk, commonDepth } = candidate.quotes;
    if (yesBestAsk === null || noBestAsk === null || commonDepth === null || yesBestAsk <= 0 || noBestAsk <= 0 || commonDepth < 1) {
      return "Positive two-sided best asks and at least one common share are required.";
    }
    const combined = yesBestAsk + noBestAsk;
    if (combined > MAX_COMBINED_ASK || 1 - combined < MIN_EDGE) return "Combined ask does not meet the protected pair edge threshold.";
    if (candidate.walletBalancePusd === null || !Number.isFinite(candidate.walletBalancePusd) || candidate.walletBalancePusd <= 0) {
      return "A verified positive CLOB collateral balance is required.";
    }
    return "READY";
  }

  private calculateShares(candidate: PairExecutionCandidate): number | null {
    const { yesBestAsk, noBestAsk, commonDepth } = candidate.quotes;
    const wallet = candidate.walletBalancePusd;
    if (yesBestAsk === null || noBestAsk === null || commonDepth === null || wallet === null) return null;
    const shares = roundSharesDown(Math.min(commonDepth, wallet / (yesBestAsk + noBestAsk)));
    return shares >= 1 ? shares : null;
  }

  private async submitPair(candidate: PairExecutionCandidate, shares: number): Promise<void> {
    const { market, quotes } = candidate;
    if (!market.yesTokenId || !market.noTokenId || market.endAt === null || quotes.yesBestAsk === null || quotes.noBestAsk === null) return;
    this.submitting = true;
    this.status.conditionId = market.conditionId;
    this.status.plannedShares = shares;
    this.status.plannedCostPusd = Number((shares * (quotes.yesBestAsk + quotes.noBestAsk)).toFixed(2));
    this.status.lastAttemptAt = new Date().toISOString();
    this.status.lastAttemptCombinedAsk = Number((quotes.yesBestAsk + quotes.noBestAsk).toFixed(4));
    this.status.recoveryAction = null;
    this.status.recoveryOrderId = null;
    this.status.mergeTxHash = null;
    this.yesTokenId = market.yesTokenId;
    this.noTokenId = market.noTokenId;
    this.yesLimitPrice = quotes.yesBestAsk;
    this.noLimitPrice = quotes.noBestAsk;
    this.negRisk = market.negRisk;
    this.setState("SUBMITTING", "Submitting one FOK limit batch for the YES/NO pair.");
    try {
      this.recordExecutionJournal("SUBMITTING");
      const response = await this.callHelper("submit_pair", {
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        yesPrice: quotes.yesBestAsk,
        noPrice: quotes.noBestAsk,
        size: shares,
      });
      const orders = response.orders ?? [];
      this.status.yesOrderId = orders.find((order) => order.leg === "YES")?.orderId ?? null;
      this.status.noOrderId = orders.find((order) => order.leg === "NO")?.orderId ?? null;
      if (response.ok !== true || !this.status.yesOrderId || !this.status.noOrderId) {
        this.status.unresolvedLeg = Boolean(this.status.yesOrderId || this.status.noOrderId);
        this.recordExecutionJournal("UNCONFIRMED");
        const detail = response.code ? ` (${[response.code, response.detail].filter(Boolean).join(": ")})` : "";
        this.status.lastAttemptOutcome = `REJECTED${detail || " (no code returned)"}`;
        const definitelyNoOrdersAccepted =
          response.code === "PAIR_AMOUNT_PRECISION_INVALID" ||
          response.noOrdersAccepted === true;
        if (this.status.unresolvedLeg || !definitelyNoOrdersAccepted) {
          await this.cancelTrackedOrders(`The FOK submission may have left an exposed leg.${detail}`);
          this.status.armed = false;
          this.status.unresolvedLeg = true;
          this.retryAfterAt = 0;
          this.setState(
            "HALTED",
            `One FOK leg may be exposed; automatic retries are disabled pending operator review.${detail}`,
          );
          return;
        }
        clearExecutionJournal();
        this.clearPair();
        this.scheduleCooldown(
          `The FOK batch was rejected before either leg was accepted.${detail}`,
        );
        return;
      }
      this.status.lastAttemptOutcome = "ACCEPTED";
      this.recordExecutionJournal("ACKNOWLEDGED");
      this.inFlight = true;
      this.setState("VERIFYING", "Both FOK orders accepted; confirming matched lifecycle.");
       await this.reconcileIfDue(candidate, true);
    } catch (err) {
      this.status.unresolvedLeg = true;
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 200)})` : "";
      this.status.lastAttemptOutcome = `EXCEPTION${detail || ""}`;
      await this.cancelTrackedOrders(`The protected CLOB batch could not be confirmed.${detail}`);
      this.status.armed = false;
      this.status.unresolvedLeg = true;
      this.retryAfterAt = 0;
      this.setState(
        "HALTED",
        `The protected CLOB batch could not be confirmed; automatic retries are disabled pending operator review.${detail}`,
      );
    } finally {
      this.submitting = false;
    }
  }

  private async reconcileIfDue(candidate: PairExecutionCandidate, force = false): Promise<void> {
    if (
      !this.inFlight ||
      this.cancelling ||
      this.reconciling ||
      (!force && Date.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS)
    ) return;
    const orderIds = [this.status.yesOrderId, this.status.noOrderId].filter((value): value is string => Boolean(value));
    if (orderIds.length !== 2) {
      this.status.unresolvedLeg = true;
      this.inFlight = false;
      await this.cancelTrackedOrders("The two-leg lifecycle has an unresolved order identifier.");
      this.status.armed = false;
      this.setState("HALTED", "The two-leg lifecycle has an unresolved order identifier; operator review is required.");
      return;
    }
    this.reconciling = true;
    this.lastReconcileAt = Date.now();
    try {
      const response = (await this.callHelper("get_orders", { orderIds })) as OrderStatusResult;
      if (response.ok !== true || !response.orders || response.orders.length !== 2) {
        this.status.unresolvedLeg = true;
        const detail = response.code
          ? ` (${[response.code, response.detail].filter(Boolean).join(": ")})`
          : "";
        await this.cancelTrackedOrders(`FOK lifecycle could not be confirmed${detail}.`);
        this.status.armed = false;
        this.status.unresolvedLeg = true;
        this.retryAfterAt = 0;
        this.setState("HALTED", `FOK lifecycle could not be confirmed; operator review is required${detail}.`);
        return;
      }
      const yesOrder = response.orders.find((order) => order.orderId === this.status.yesOrderId);
      const noOrder = response.orders.find((order) => order.orderId === this.status.noOrderId);
      const plannedShares = this.status.plannedShares;
      if (!yesOrder || !noOrder || plannedShares === null) {
        this.status.unresolvedLeg = true;
        this.inFlight = false;
        this.status.armed = false;
        this.setState("HALTED", "FOK lifecycle response could not be mapped to the planned pair.");
        return;
      }
      const yesMatched = finiteNumber(yesOrder.sizeMatched);
      const noMatched = finiteNumber(noOrder.sizeMatched);
      const yesFull = exactMatchedSize(yesOrder, plannedShares);
      const noFull = exactMatchedSize(noOrder, plannedShares);
      const statuses = [String(yesOrder.status ?? "UNKNOWN"), String(noOrder.status ?? "UNKNOWN")];
      if (yesFull && noFull) {
        this.inFlight = false;
        this.status.unresolvedLeg = false;
        this.retryAfterAt = 0;
        this.completedConditionId = this.status.conditionId;
        clearExecutionJournal();
        this.setState("FILLED", "Both FOK legs fully filled. This BTC window is complete.");
        return;
      }
      const oneExactLeg =
        yesFull && noMatched === 0
          ? { filledLeg: "YES" as const, filledOrder: yesOrder, missingOrder: noOrder }
          : noFull && yesMatched === 0
            ? { filledLeg: "NO" as const, filledOrder: noOrder, missingOrder: yesOrder }
            : null;
      if (oneExactLeg) {
        this.inFlight = false;
        await this.recoverSingleLeg(candidate, oneExactLeg);
        return;
      }
      if (
        yesMatched === 0 &&
        noMatched === 0 &&
        statuses.every(isTerminalUnfilled)
      ) {
        this.inFlight = false;
        clearExecutionJournal();
        this.clearPair();
        this.scheduleCooldown("Both FOK legs terminated with zero matched quantity.");
        return;
      }
      this.status.unresolvedLeg = true;
      const detail = ` (statuses: ${statuses.join(", ")}; matched: ${yesMatched ?? "unknown"}/${noMatched ?? "unknown"})`;
      await this.cancelTrackedOrders(`A FOK leg did not produce a confirmed matching fill${detail}.`);
      this.status.armed = false;
      this.retryAfterAt = 0;
      this.setState("HALTED", `A FOK leg did not produce a confirmed matching fill; operator review is required${detail}.`);
    } catch (err) {
      this.status.unresolvedLeg = true;
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 200)})` : "";
      await this.cancelTrackedOrders("FOK lifecycle lookup failed.");
      this.status.armed = false;
      this.retryAfterAt = 0;
      this.setState("HALTED", `FOK lifecycle lookup failed; operator review is required${detail}.`);
    } finally {
      this.reconciling = false;
    }
  }

  private async recoverSingleLeg(
    candidate: PairExecutionCandidate,
    incident: {
      filledLeg: "YES" | "NO";
      filledOrder: OrderStatus;
      missingOrder: OrderStatus;
    },
  ): Promise<void> {
    if (this.recovering) {
      this.haltRecovery("A duplicate single-leg recovery attempt was blocked.");
      return;
    }
    this.recovering = true;
    this.status.unresolvedLeg = true;
    this.status.recoveryAction = "BUY_MISSING_FOR_MERGE";
    this.recordExecutionJournal("RECOVERING");
    this.setState("RECOVERING", `Only ${incident.filledLeg} filled; attempting a +2c complete-set hedge.`);
    try {
      const plannedShares = this.status.plannedShares;
      const conditionId = this.status.conditionId;
      const sameMarket = conditionId && candidate.market.conditionId === conditionId;
      const filledLimitPrice =
        finiteNumber(incident.filledOrder.price) ??
        (incident.filledLeg === "YES" ? this.yesLimitPrice : this.noLimitPrice);
      const missingLeg = incident.filledLeg === "YES" ? "NO" : "YES";
      const missingTokenId = missingLeg === "YES" ? this.yesTokenId : this.noTokenId;
      const filledTokenId = incident.filledLeg === "YES" ? this.yesTokenId : this.noTokenId;
      const missingBestAsk =
        missingLeg === "YES" ? candidate.quotes.yesBestAsk : candidate.quotes.noBestAsk;
      if (
        plannedShares === null ||
        !conditionId ||
        !sameMarket ||
        !candidate.quotes.fresh ||
        filledLimitPrice === null ||
        !missingTokenId ||
        !filledTokenId
      ) {
        this.haltRecovery("Single-leg recovery context or fresh market data is unavailable.");
        return;
      }

      if (!isTerminalUnfilled(String(incident.missingOrder.status ?? ""))) {
        const missingOrderId = incident.missingOrder.orderId;
        if (!missingOrderId || !(await this.cancelOrderIds([missingOrderId]))) {
          this.haltRecovery("The unfilled FOK leg could not be confirmed canceled.");
          return;
        }
      }
      const missingOrderId = incident.missingOrder.orderId;
      const finalMissingStatus = missingOrderId ? await this.pollOrder(missingOrderId) : null;
      if (
        !finalMissingStatus ||
        !isTerminalUnfilled(String(finalMissingStatus.status ?? "")) ||
        finiteNumber(finalMissingStatus.sizeMatched) !== 0
      ) {
        this.haltRecovery("The missing original FOK leg was not re-confirmed terminal with zero matched quantity.");
        return;
      }

      const maxMissingPrice = Math.floor(
        (1 - RESCUE_MERGE_PROFIT_PUSD - filledLimitPrice + Number.EPSILON) * 100,
      ) / 100;
      const canHedgeProfitably =
        missingBestAsk !== null &&
        missingBestAsk > 0 &&
        maxMissingPrice > 0 &&
        missingBestAsk <= maxMissingPrice &&
        candidate.walletBalancePusd !== null &&
        candidate.walletBalancePusd >= maxMissingPrice * plannedShares;

      let mergeCapability: HelperResult = { ok: false, code: "MERGE_NOT_CHECKED" };
      if (canHedgeProfitably) {
        mergeCapability = await this.callHelper("merge_capability", {
          conditionId,
          yesTokenId: this.yesTokenId,
          noTokenId: this.noTokenId,
          size: plannedShares,
          negRisk: this.negRisk,
        });
      }

      if (canHedgeProfitably && mergeCapability.ok === true && mergeCapability.code === "MERGE_CAPABLE") {
        const hedge = await this.callHelper("submit_fok_buy", {
          tokenId: missingTokenId,
          leg: missingLeg,
          price: maxMissingPrice,
          size: plannedShares,
        });
        const hedgeOrderId = hedge.orders?.[0]?.orderId ?? null;
        this.status.recoveryOrderId = hedgeOrderId;
        this.recordExecutionJournal("RECOVERING");
        if (hedge.ok === true && hedgeOrderId) {
          const hedgeStatus = await this.pollOrder(hedgeOrderId);
          if (hedgeStatus && exactMatchedSize(hedgeStatus, plannedShares)) {
            this.status.unresolvedLeg = false;
            this.status.recoveryAction = "MERGE_COMPLETE_SET";
            this.recordExecutionJournal("HEDGED");
            this.setState("MERGING", "Missing leg filled within the +2c target; merging the exact complete set.");
            this.recordExecutionJournal("MERGING");
            const merge = await this.callHelper("merge_positions", {
              conditionId,
              yesTokenId: this.yesTokenId,
              noTokenId: this.noTokenId,
              size: plannedShares,
              negRisk: this.negRisk,
            });
            if (merge.ok === true && merge.code === "MERGE_CONFIRMED" && merge.mergeTxHash) {
              const completedConditionId = this.status.conditionId;
              this.status.mergeTxHash = merge.mergeTxHash;
              this.completedConditionId = completedConditionId;
              clearExecutionJournal();
              this.clearPair({ preserveMergeTxHash: true });
              this.setState("FILLED", "Single-leg incident recovered: missing leg filled and complete set merged to pUSD.");
              return;
            }
            this.status.armed = false;
            this.status.unresolvedLeg = false;
            this.setState(
              "HALTED",
              `Both outcome legs are balanced, but Merge was not confirmed (${merge.code ?? "unknown"}); operator review is required.`,
            );
            return;
          }
          // Once an accepted hedge order cannot be proved zero-fill, selling
          // the original leg could create a new opposite exposure.
          if (
            !hedgeStatus ||
            !isTerminalUnfilled(String(hedgeStatus.status ?? "")) ||
            finiteNumber(hedgeStatus.sizeMatched) !== 0
          ) {
            this.haltRecovery("The missing-leg FOK result is partial or unknown; the original leg will not be sold automatically.");
            return;
          }
        } else if (hedge.noOrdersAccepted !== true) {
          this.haltRecovery("The missing-leg FOK submission outcome is ambiguous.");
          return;
        }
      } else if (canHedgeProfitably) {
        logger.warn(
          { code: mergeCapability.code },
          "Skipped missing-leg hedge because custody-compatible Merge is unavailable",
        );
      }

      this.status.recoveryAction = "SELL_FILLED_AT_10_PERCENT_STOP";
      const stopPrice = Math.ceil(
        filledLimitPrice * (1 - RESCUE_STOP_LOSS_FRACTION) * 100 - Number.EPSILON,
      ) / 100;
      this.setState("RECOVERING", `Profitable hedge unavailable; submitting ${incident.filledLeg} FAK stop at ${stopPrice.toFixed(2)}.`);
      const unwind = await this.callHelper("submit_fak_sell", {
        tokenId: filledTokenId,
        leg: incident.filledLeg,
        price: stopPrice,
        size: plannedShares,
      });
      const unwindOrderId = unwind.orders?.[0]?.orderId ?? null;
      this.status.recoveryOrderId = unwindOrderId;
      this.recordExecutionJournal("RECOVERING");
      if (unwind.ok !== true || !unwindOrderId) {
        this.haltRecovery(`The -10% FAK stop was rejected or unconfirmed (${unwind.code ?? "unknown"}).`);
        return;
      }
      const unwindStatus = await this.pollOrder(unwindOrderId);
      if (!unwindStatus || !exactMatchedSize(unwindStatus, plannedShares)) {
        this.haltRecovery("The -10% FAK stop did not fully flatten the exposed quantity.");
        return;
      }
      clearExecutionJournal();
      this.clearPair();
      this.status.armed = false;
      this.setState("HALTED", "Single-leg exposure was fully unwound by the -10% FAK stop; manual re-arm is required.");
    } catch (err) {
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 180)})` : "";
      this.haltRecovery(`Single-leg recovery failed${detail}.`);
    } finally {
      this.recovering = false;
    }
  }

  private async pollOrder(orderId: string): Promise<OrderStatus | null> {
    for (let attempt = 0; attempt < RESCUE_ORDER_POLL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(RESCUE_ORDER_POLL_MS);
      const response = (await this.callHelper("get_orders", { orderIds: [orderId] })) as OrderStatusResult;
      const order = response.ok === true && response.orders?.length === 1 ? response.orders[0] : null;
      if (!order) continue;
      const matched = finiteNumber(order.sizeMatched);
      if (isFilled(String(order.status ?? "")) || isTerminalUnfilled(String(order.status ?? "")) || (matched !== null && matched > 0)) {
        return order;
      }
    }
    return null;
  }

  private haltRecovery(reason: string): void {
    this.status.armed = false;
    this.status.unresolvedLeg = true;
    this.retryAfterAt = 0;
    this.recordExecutionJournal("UNCONFIRMED");
    this.setState("HALTED", reason);
  }

  private async cancelTrackedOrders(reason: string): Promise<boolean> {
    const orderIds = [this.status.yesOrderId, this.status.noOrderId].filter((value): value is string => Boolean(value));
    const cancelled = await this.cancelOrderIds(orderIds);
    logger.warn({ reason, orderIds }, "Requested cancellation for protected pair");
    return cancelled;
  }

  private async cancelOrderIds(orderIds: string[]): Promise<boolean> {
    if (!orderIds.length || this.cancelling) return true;
    this.cancelling = true;
    let cancelled = true;
    try {
      const response = await this.callHelper("cancel_orders", { orderIds });
      if (response.ok !== true) {
        this.status.unresolvedLeg = true;
        cancelled = false;
      }
    } catch {
      this.status.unresolvedLeg = true;
      cancelled = false;
    } finally {
      this.inFlight = false;
      this.cancelling = false;
    }
    return cancelled;
  }

  private clearPair(options: { preserveMergeTxHash?: boolean } = {}): void {
    this.status.conditionId = null;
    this.status.yesOrderId = null;
    this.status.noOrderId = null;
    this.status.recoveryOrderId = null;
    this.status.recoveryAction = null;
    if (!options.preserveMergeTxHash) this.status.mergeTxHash = null;
    this.status.unresolvedLeg = false;
    this.status.plannedShares = null;
    this.status.plannedCostPusd = null;
    this.yesTokenId = null;
    this.noTokenId = null;
    this.yesLimitPrice = null;
    this.noLimitPrice = null;
    this.negRisk = false;
  }

  private recordExecutionJournal(phase: ExecutionJournal["phase"]): void {
    const now = new Date().toISOString();
    const existing = loadExecutionJournal();
    persistExecutionJournal({
      phase,
      conditionId: this.status.conditionId,
      yesTokenId: this.yesTokenId,
      noTokenId: this.noTokenId,
      yesLimitPrice: this.yesLimitPrice,
      noLimitPrice: this.noLimitPrice,
      plannedShares: this.status.plannedShares,
      negRisk: this.negRisk,
      yesOrderId: this.status.yesOrderId,
      noOrderId: this.status.noOrderId,
      recoveryOrderId: this.status.recoveryOrderId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
  }

  private scheduleCooldown(reason: string): void {
    this.inFlight = false;
    this.retryAfterAt = Date.now() + RETRY_COOLDOWN_MS;
    this.setState("WAITING_FOR_MARKET", `${reason} Automatic retry resumes after a 15-second cooldown.`);
  }

  private async callHelper(
    action:
      | "submit_pair"
      | "submit_fok_buy"
      | "submit_fak_sell"
      | "merge_capability"
      | "merge_positions"
      | "cancel_orders"
      | "get_orders",
    payload: Record<string, unknown>,
  ): Promise<HelperResult> {
    const python = executionPython();
    if (!python || !existsSync(EXECUTION_HELPER)) throw new Error("CLOB execution bridge is unavailable");
    try {
      const { stdout, stderr } = await execFileAsync(
        python,
        [EXECUTION_HELPER, action, JSON.stringify(payload)],
        { timeout: 20_000, maxBuffer: 16 * 1024 },
      );
      if (stderr.trim()) {
        logger.warn({ action, diagnostic: stderr.trim() }, "CLOB helper diagnostic output");
      }
      return JSON.parse(stdout) as HelperResult;
    } catch (error) {
      const errorRecord = error && typeof error === "object" ? (error as { stderr?: unknown }) : null;
      const stderr = typeof errorRecord?.stderr === "string" ? errorRecord.stderr.trim() : "";
      if (stderr) {
        logger.error({ action, diagnostic: stderr }, "CLOB helper failed with diagnostic output");
      }
      throw error;
    }
  }

  private setState(state: AutomaticPairExecutionStatus["state"], reason: string): void {
    const changed = this.status.state !== state || this.status.reason !== reason;
    this.status.state = state;
    this.status.reason = reason;
    if (changed) {
      this.status.lastActionAt = asIso(Date.now());
      logger.info({ state, reason }, "Protected CLOB pair execution state changed");
    }
  }
}