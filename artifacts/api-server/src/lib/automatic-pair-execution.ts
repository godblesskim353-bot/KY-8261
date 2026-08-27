import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { logger } from "./logger";

const execFileAsync = promisify(execFile);
const API_SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXECUTION_HELPER = path.resolve(API_SERVER_DIR, "scripts/manage_clob_pair.py");
const MIN_EDGE = 0.01;
const MAX_COMBINED_ASK = 0.99;
const TAIL_CUTOFF_MS = 20_000;
const RECONCILE_INTERVAL_MS = 500;
const RETRY_COOLDOWN_MS = 15_000;

export type AutomaticPairExecutionStatus = {
  mode: "CLOB_TWO_LEG_FOK";
  enabled: boolean;
  armed: boolean;
  state: "DISABLED" | "PAUSED" | "WAITING_FOR_MARKET" | "ARMED" | "SUBMITTING" | "VERIFYING" | "FILLED" | "HALTED";
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
};

export type PairExecutionCandidate = {
  ready: boolean;
  market: { conditionId: string | null; yesTokenId: string | null; noTokenId: string | null; endAt: number | null };
  quotes: { yesBestAsk: number | null; noBestAsk: number | null; commonDepth: number | null; fresh: boolean };
  walletBalancePusd: number | null;
};

type HelperOrder = { leg?: string; accepted?: boolean; orderId?: string | null };
type HelperResult = { ok?: boolean; code?: string; detail?: string; orders?: HelperOrder[]; cancellationRequested?: boolean };
type OrderStatus = { orderId?: string; status?: string; sizeMatched?: number | string | null };
type OrderStatusResult = { ok?: boolean; orders?: OrderStatus[] };

function executionPython(): string | null {
  const configured = process.env.POLYMARKET_EXECUTION_PYTHON?.trim();
  const candidates = [
    configured,
    // Replit/Nix workspaces install the uv-managed interpreter here.
    path.resolve(process.cwd(), ".pythonlibs/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.pythonlibs/bin/python"),
    // Plain `uv sync` (e.g. on a self-hosted VPS) creates a standard .venv instead.
    path.resolve(process.cwd(), ".venv/bin/python3"),
    path.resolve(process.cwd(), ".venv/bin/python"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python3"),
    path.resolve(API_SERVER_DIR, "../../.venv/bin/python"),
  ].filter((value): value is string => Boolean(value));
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function asIso(value: number): string {
  return new Date(value).toISOString();
}

function roundSharesDown(value: number): number {
  return Math.floor((value + Number.EPSILON) * 100) / 100;
}

function isFilled(status: string): boolean {
  return ["MATCHED", "FILLED"].includes(status.toUpperCase());
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
  };
  private submitting = false;
  private inFlight = false;
  private cancelling = false;
  private lastReconcileAt = 0;
  private completedConditionId: string | null = null;
  private retryAfterAt = 0;
  // Set only by an operator action (pause/emergencyStop) during this process's
  // lifetime. A fresh process (e.g. after a host restart or redeploy) always
  // starts with this false, so evaluate() below re-arms automatically instead
  // of sitting in PAUSED waiting for a manual START click. This trades the
  // per-restart manual confirmation step for uptime: once LIVE_TRADING_ENABLED
  // is on, the operator has already accepted 24/7 live execution, and a host
  // restart should not silently stop the bot until someone notices.
  private manuallyStopped = false;

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
      if (!this.manuallyStopped && isCLOBTwoLegBridgeAvailable()) {
        this.status.armed = true;
        this.setState("ARMED", "Automatically resumed protected-pair execution after a server restart.");
      } else {
        this.setState("PAUSED", "Press START AUTO EXECUTION to begin 24/7 automatic execution.");
        return;
      }
    }
    if (this.status.unresolvedLeg) {
      if (Date.now() < this.retryAfterAt) {
        this.setState("WAITING_FOR_MARKET", "Protected-pair recovery cooldown is active; automatic reconciliation will retry in 15 seconds.");
        return;
      }
      await this.recoverOutstandingPair();
      return;
    }
    if (this.retryAfterAt > Date.now()) {
      this.setState("WAITING_FOR_MARKET", "Execution cooldown is active; automatic retry will continue in 15 seconds.");
      return;
    }
    if (this.inFlight) {
      await this.reconcileIfDue();
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
    this.manuallyStopped = true;
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
    this.manuallyStopped = false;
    this.status.armed = true;
    this.setState("ARMED", "Operator armed automatic protected-pair execution.");
    return this.snapshot();
  }

  async pause(): Promise<AutomaticPairExecutionStatus> {
    this.status.armed = false;
    this.manuallyStopped = true;
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
    if (candidate.market.endAt - Date.now() <= TAIL_CUTOFF_MS) return "Tail cutoff is active for this BTC window.";
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
    this.setState("SUBMITTING", "Submitting one FOK limit batch for the YES/NO pair.");
    try {
      const response = await this.callHelper("submit_pair", {
        yesTokenId: market.yesTokenId,
        noTokenId: market.noTokenId,
        yesPrice: quotes.yesBestAsk,
        noPrice: quotes.noBestAsk,
        size: shares,
        expiration: Math.floor((market.endAt - TAIL_CUTOFF_MS) / 1000),
      });
      const orders = response.orders ?? [];
      this.status.yesOrderId = orders.find((order) => order.leg === "YES")?.orderId ?? null;
      this.status.noOrderId = orders.find((order) => order.leg === "NO")?.orderId ?? null;
      if (response.ok !== true || !this.status.yesOrderId || !this.status.noOrderId) {
        this.status.unresolvedLeg = Boolean(this.status.yesOrderId || this.status.noOrderId);
        const detail = response.code ? ` (${[response.code, response.detail].filter(Boolean).join(": ")})` : "";
        this.status.lastAttemptOutcome = `REJECTED${detail || " (no code returned)"}`;
        const cancelled = await this.cancelTrackedOrders(`The FOK batch was not fully accepted.${detail}`);
        if (cancelled) this.clearPair();
        this.scheduleCooldown(
          response.cancellationRequested
            ? `One FOK leg was not accepted; cancellation was requested.${detail}`
            : `The FOK batch was not fully accepted.${detail}`,
        );
        return;
      }
      this.status.lastAttemptOutcome = "ACCEPTED";
      this.inFlight = true;
      this.setState("VERIFYING", "Both FOK orders accepted; confirming matched lifecycle.");
      await this.reconcileIfDue(true);
    } catch (err) {
      this.status.unresolvedLeg = Boolean(this.status.yesOrderId || this.status.noOrderId);
      const detail = err instanceof Error && err.message ? ` (${err.message.slice(0, 200)})` : "";
      this.status.lastAttemptOutcome = `EXCEPTION${detail || ""}`;
      if (this.status.unresolvedLeg) {
        const cancelled = await this.cancelTrackedOrders(`The protected CLOB batch could not be confirmed.${detail}`);
        if (cancelled) this.clearPair();
      } else {
        this.clearPair();
      }
      this.scheduleCooldown(`The protected CLOB batch could not be confirmed.${detail}`);
    } finally {
      this.submitting = false;
    }
  }

  private async reconcileIfDue(force = false): Promise<void> {
    if (!this.inFlight || this.cancelling || (!force && Date.now() - this.lastReconcileAt < RECONCILE_INTERVAL_MS)) return;
    const orderIds = [this.status.yesOrderId, this.status.noOrderId].filter((value): value is string => Boolean(value));
    if (orderIds.length !== 2) {
      this.status.unresolvedLeg = true;
      this.inFlight = false;
      const cancelled = await this.cancelTrackedOrders("The two-leg lifecycle has an unresolved order identifier.");
      if (cancelled) this.clearPair();
      this.scheduleCooldown("The two-leg lifecycle has an unresolved order identifier.");
      return;
    }
    this.lastReconcileAt = Date.now();
    try {
      const response = (await this.callHelper("get_orders", { orderIds })) as OrderStatusResult;
      if (response.ok !== true || !response.orders || response.orders.length !== 2) {
        this.status.unresolvedLeg = true;
        const cancelled = await this.cancelTrackedOrders("FOK lifecycle could not be confirmed.");
        if (cancelled) this.clearPair();
        this.scheduleCooldown("FOK lifecycle could not be confirmed.");
        return;
      }
      const statuses = response.orders.map((order) => String(order.status ?? "UNKNOWN"));
      if (statuses.every(isFilled)) {
        this.inFlight = false;
        this.status.unresolvedLeg = false;
        this.retryAfterAt = 0;
        this.completedConditionId = this.status.conditionId;
        this.setState("FILLED", "Both FOK legs fully filled. This BTC window is complete.");
        return;
      }
      this.status.unresolvedLeg = true;
      const cancelled = await this.cancelTrackedOrders("A FOK leg did not produce a confirmed matching fill.");
      if (cancelled) this.clearPair();
      this.scheduleCooldown("A FOK leg did not produce a confirmed matching fill.");
    } catch {
      this.status.unresolvedLeg = true;
      const cancelled = await this.cancelTrackedOrders("FOK lifecycle lookup failed.");
      if (cancelled) this.clearPair();
      this.scheduleCooldown("FOK lifecycle lookup failed.");
    }
  }

  private async recoverOutstandingPair(): Promise<void> {
    const orderIds = [this.status.yesOrderId, this.status.noOrderId].filter(
      (value): value is string => Boolean(value),
    );
    if (!orderIds.length) {
      this.clearPair();
      this.scheduleCooldown("Previous pair had no recoverable order identifiers.");
      return;
    }
    this.inFlight = true;
    this.setState("VERIFYING", "Checking the previous pair before automatic retry.");
    await this.reconcileIfDue(true);
  }

  private async cancelTrackedOrders(reason: string): Promise<boolean> {
    const orderIds = [this.status.yesOrderId, this.status.noOrderId].filter((value): value is string => Boolean(value));
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
      logger.warn({ reason, orderIds }, "Requested cancellation for protected pair");
    }
    return cancelled;
  }

  private clearPair(): void {
    this.status.conditionId = null;
    this.status.yesOrderId = null;
    this.status.noOrderId = null;
    this.status.unresolvedLeg = false;
    this.status.plannedShares = null;
    this.status.plannedCostPusd = null;
  }

  private scheduleCooldown(reason: string): void {
    this.inFlight = false;
    this.retryAfterAt = Date.now() + RETRY_COOLDOWN_MS;
    this.setState("WAITING_FOR_MARKET", `${reason} Automatic retry resumes after a 15-second cooldown.`);
  }

  private async callHelper(action: "submit_pair" | "cancel_orders" | "get_orders", payload: Record<string, unknown>): Promise<HelperResult> {
    const python = executionPython();
    if (!python || !existsSync(EXECUTION_HELPER)) throw new Error("CLOB execution bridge is unavailable");
    const { stdout } = await execFileAsync(python, [EXECUTION_HELPER, action, JSON.stringify(payload)], { timeout: 20_000, maxBuffer: 16 * 1024 });
    return JSON.parse(stdout) as HelperResult;
  }

  private setState(state: AutomaticPairExecutionStatus["state"], reason: string): void {
    const changed = this.status.state !== state || this.status.reason !== reason;
    this.status.state = state;
    this.status.reason = reason;
    if (changed) {
      this.status.lastActionAt = asIso(Date.now());
      logger.info({ state }, "Protected CLOB pair execution state changed");
    }
  }
}