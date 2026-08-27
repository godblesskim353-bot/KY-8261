import type { AutomaticPairExecutionStatus, PairExecutionCandidate } from "./automatic-pair-execution";

/**
 * This module is purely observational: it never influences trading decisions.
 * It only watches the same read-only candidate/status data the execution
 * supervisor already produces and records what it sees, so "no changes to
 * anything else" (existing arm/pause/edge/FOK logic) stays true.
 *
 * This threshold matches the live trading gate's combined-ask ceiling
 * (MAX_COMBINED_ASK in automatic-pair-execution.ts). It used to be a looser
 * 0.96 "just for visibility," but that left every real submission attempt
 * between 0.96 and 0.99 completely unlogged -- exactly the range where
 * genuine FOK submissions were failing with no visible record of why. Keep
 * this equal to MAX_COMBINED_ASK so every attempt the live gate would ever
 * allow is also captured here.
 */
export const OPPORTUNITY_LOG_THRESHOLD_PUSD = 0.995;

const MAX_LOG_ENTRIES = 300;
// Worst-case round trip for one submission attempt: the CLOB helper process
// has a 20s execFile timeout (see automatic-pair-execution.ts callHelper),
// plus a little margin for the reconciliation call that follows a fill.
const OUTCOME_GRACE_MS = 25_000;
const REJECTION_REASON_PATTERN = /FOK|leg|lifecycle/i;

export type OpportunityOutcome = "OPEN" | "EXECUTED" | "NOT_EXECUTED";

export type OpportunityLogEntry = {
  id: string;
  conditionId: string | null;
  openedAt: string;
  closedAt: string | null;
  thresholdPusd: number;
  entryCombinedAskPusd: number;
  minCombinedAskPusd: number;
  yesBestAskAtOpen: number | null;
  noBestAskAtOpen: number | null;
  durationBelowThresholdMs: number;
  outcome: OpportunityOutcome;
  reason: string | null;
  rejectionInference: string | null;
  shares: number | null;
  costPusd: number | null;
  yesOrderId: string | null;
  noOrderId: string | null;
};

type Phase = "PRICE_WINDOW_OPEN" | "AWAITING_OUTCOME" | "RESOLVED";
type InternalEntry = OpportunityLogEntry & { phase: Phase; graceDeadline: number | null };

export class OpportunityLogStore {
  private entries: InternalEntry[] = [];
  private counter = 0;

  list(limit = 100): OpportunityLogEntry[] {
    return this.entries.slice(0, limit).map(({ phase: _phase, graceDeadline: _graceDeadline, ...entry }) => entry);
  }

  observe(candidate: PairExecutionCandidate, execution: AutomaticPairExecutionStatus): void {
    const now = Date.now();
    const { yesBestAsk, noBestAsk, fresh } = candidate.quotes;
    const combinedAsk = fresh && yesBestAsk !== null && noBestAsk !== null ? yesBestAsk + noBestAsk : null;
    let active: InternalEntry | undefined = this.entries[0];
    if (active?.phase === "RESOLVED") active = undefined;

    if (combinedAsk !== null && combinedAsk < OPPORTUNITY_LOG_THRESHOLD_PUSD) {
      if (!active) {
        active = {
          id: `opp-${++this.counter}`,
          conditionId: candidate.market.conditionId,
          openedAt: new Date(now).toISOString(),
          closedAt: null,
          thresholdPusd: OPPORTUNITY_LOG_THRESHOLD_PUSD,
          entryCombinedAskPusd: combinedAsk,
          minCombinedAskPusd: combinedAsk,
          yesBestAskAtOpen: yesBestAsk,
          noBestAskAtOpen: noBestAsk,
          durationBelowThresholdMs: 0,
          outcome: "OPEN",
          reason: null,
          rejectionInference: null,
          shares: null,
          costPusd: null,
          yesOrderId: null,
          noOrderId: null,
          phase: "PRICE_WINDOW_OPEN",
          graceDeadline: null,
        };
        this.entries.unshift(active);
        if (this.entries.length > MAX_LOG_ENTRIES) this.entries.length = MAX_LOG_ENTRIES;
      } else if (active.phase === "PRICE_WINDOW_OPEN") {
        active.minCombinedAskPusd = Math.min(active.minCombinedAskPusd, combinedAsk);
        active.durationBelowThresholdMs = now - Date.parse(active.openedAt);
      }
    } else if (active?.phase === "PRICE_WINDOW_OPEN") {
      this.closePriceWindow(active, now);
    }

    if (active && active.phase !== "RESOLVED") this.resolveIfPossible(active, candidate, execution, now);
  }

  private closePriceWindow(entry: InternalEntry, now: number): void {
    entry.closedAt = new Date(now).toISOString();
    entry.durationBelowThresholdMs = now - Date.parse(entry.openedAt);
    entry.phase = "AWAITING_OUTCOME";
    entry.graceDeadline = now + OUTCOME_GRACE_MS;
  }

  private resolveIfPossible(
    entry: InternalEntry,
    candidate: PairExecutionCandidate,
    execution: AutomaticPairExecutionStatus,
    now: number,
  ): void {
    const sameWindow = execution.conditionId !== null && execution.conditionId === entry.conditionId;
    const windowRolledOver = entry.conditionId !== null && candidate.market.conditionId !== entry.conditionId;

    if (sameWindow && execution.state === "FILLED") {
      if (entry.phase === "PRICE_WINDOW_OPEN") this.closePriceWindow(entry, now);
      this.resolve(entry, "EXECUTED", "Both FOK legs filled; protected pair executed.", {
        shares: execution.plannedShares,
        costPusd: execution.plannedCostPusd,
        yesOrderId: execution.yesOrderId,
        noOrderId: execution.noOrderId,
      });
      return;
    }
    if (sameWindow && execution.state === "HALTED") {
      if (entry.phase === "PRICE_WINDOW_OPEN") this.closePriceWindow(entry, now);
      this.resolve(entry, "NOT_EXECUTED", execution.reason, {});
      return;
    }
    if (windowRolledOver) {
      if (entry.phase === "PRICE_WINDOW_OPEN") this.closePriceWindow(entry, now);
      this.resolve(
        entry,
        "NOT_EXECUTED",
        `${execution.reason} (The BTC 5-minute window changed before this opportunity's outcome could be confirmed.)`,
        {},
      );
      return;
    }
    if (entry.phase !== "AWAITING_OUTCOME") return;

    // The execution status changed after our price window closed -- that
    // status almost certainly explains what happened to this opportunity.
    if (sameWindow && execution.lastActionAt && Date.parse(execution.lastActionAt) >= Date.parse(entry.closedAt as string)) {
      const rejectionInference = REJECTION_REASON_PATTERN.test(execution.reason) ? this.inferRejection(entry, candidate) : null;
      this.resolve(entry, "NOT_EXECUTED", execution.reason, { rejectionInference });
      return;
    }
    if (entry.graceDeadline !== null && now > entry.graceDeadline) {
      const rejectionInference = REJECTION_REASON_PATTERN.test(execution.reason) ? this.inferRejection(entry, candidate) : null;
      this.resolve(entry, "NOT_EXECUTED", execution.reason, { rejectionInference });
    }
  }

  /**
   * Polymarket's FOK response only reports accepted/not-accepted per leg --
   * it never explains *why* a leg was rejected. This is a best-effort,
   * clearly-labelled inference (not a confirmed cause) from comparing the
   * ask price observed when the opportunity opened to the price observed
   * once we conclude it: if the ask rose, the price likely moved away; if it
   * held steady, the size at that price was more likely taken by someone
   * else first.
   */
  private inferRejection(entry: InternalEntry, candidate: PairExecutionCandidate): string {
    const { yesBestAsk, noBestAsk, fresh } = candidate.quotes;
    if (!fresh || yesBestAsk === null || noBestAsk === null) {
      return "Best-effort inference unavailable: no fresh quote to compare against the opening price.";
    }
    const yesRose = entry.yesBestAskAtOpen !== null && yesBestAsk > entry.yesBestAskAtOpen;
    const noRose = entry.noBestAskAtOpen !== null && noBestAsk > entry.noBestAskAtOpen;
    if (yesRose || noRose) {
      return "Best-effort inference: the YES and/or NO ask price rose after this opportunity opened, consistent with the price moving away before the order could fill.";
    }
    return "Best-effort inference: ask prices held steady, consistent with the available size at that price being taken by another trader before this pair could fill.";
  }

  private resolve(
    entry: InternalEntry,
    outcome: OpportunityOutcome,
    reason: string | null,
    extra: { shares?: number | null; costPusd?: number | null; yesOrderId?: string | null; noOrderId?: string | null; rejectionInference?: string | null },
  ): void {
    entry.outcome = outcome;
    entry.reason = reason;
    entry.shares = extra.shares ?? null;
    entry.costPusd = extra.costPusd ?? null;
    entry.yesOrderId = extra.yesOrderId ?? null;
    entry.noOrderId = extra.noOrderId ?? null;
    entry.rejectionInference = extra.rejectionInference ?? null;
    entry.phase = "RESOLVED";
  }
}
