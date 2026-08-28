import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ENTRY_PRICE_AGGRESSION_PUSD,
  MAX_ENTRY_PRICE_PUSD,
  MIN_ENTRY_PRICE_PUSD,
  calculateEntryLimitPrice,
  isEntryPriceWithinBand,
} from "../src/lib/entry-price-band.ts";
import { createAutomaticPairExecutionSupervisor, type SupervisorHelper } from "../src/lib/automatic-pair-execution.ts";
import {
  aggressiveVolumeAfterWall,
  calculateValidBuyShares,
  calculateDefensePrice,
  calculateDynamicHedgeBudget,
  isBinanceEntryConfirmed,
  topThreeDepthDirection,
} from "../src/lib/binance-signal.ts";

test("Binance entry requires a 4x top-three wall and more than 10 BTC within 50 ms", () => {
  assert.deepEqual(
    topThreeDepthDirection(
      [{ price: 1, size: 4 }, { price: 0.99, size: 4 }, { price: 0.98, size: 4 }],
      [{ price: 1.01, size: 1 }, { price: 1.02, size: 1 }, { price: 1.03, size: 1 }],
    ),
    { direction: "UP", ratio: 4 },
  );
  const volume = aggressiveVolumeAfterWall([
    { direction: "UP", quantityBtc: 10, at: 1_010 },
    { direction: "UP", quantityBtc: 0.01, at: 1_050 },
    { direction: "UP", quantityBtc: 2, at: 1_051 },
  ], "UP", 1_000);
  assert.equal(volume, 10.01);
  assert.equal(isBinanceEntryConfirmed("UP", volume), true);
  assert.equal(isBinanceEntryConfirmed("UP", 10), false);
});

test("defense price is precisely entry complement less two cents", () => {
  assert.equal(calculateDefensePrice(0.65), 0.33);
  assert.equal(calculateDefensePrice(0.99), null);
});

test("dynamic hedge budget selects target and respects twenty-times and wallet caps", () => {
  assert.deepEqual(calculateDynamicHedgeBudget(10, 0.7, 1_000), {
    budgetPusd: 46.67,
    targetPusd: 0.85,
  });
  assert.deepEqual(calculateDynamicHedgeBudget(10, 0.9, 1_000), {
    budgetPusd: 180,
    targetPusd: 0.95,
  });
  assert.deepEqual(calculateDynamicHedgeBudget(10, 0.94, 50), {
    budgetPusd: 50,
    targetPusd: 0.95,
  });
});

test("CLOB precision sizing never exceeds either supplied budget cap", () => {
  // 42-cent BUYs must use a share step that produces an integral cent maker amount.
  const shares = calculateValidBuyShares(10, 9.99, 0.42);
  assert.equal(shares, 23.5);
  assert.ok(shares! * 0.42 <= 9.99);
  assert.equal(Number.isInteger(shares! * 10_000), true);
  assert.equal(Math.round(shares! * 0.42 * 100), 987);
});

test("entry price band includes both configured boundaries", () => {
  assert.equal(isEntryPriceWithinBand(MIN_ENTRY_PRICE_PUSD), true);
  assert.equal(isEntryPriceWithinBand(MAX_ENTRY_PRICE_PUSD), true);
});

test("entry price band rejects prices outside the configured boundaries", () => {
  assert.equal(isEntryPriceWithinBand(0.39), false);
  assert.equal(isEntryPriceWithinBand(0.83), false);
  assert.equal(isEntryPriceWithinBand(Number.NaN), false);
});

test("entry limit adds two cents without exceeding the hard cap", () => {
  assert.equal(calculateEntryLimitPrice(0.4), 0.42);
  assert.equal(calculateEntryLimitPrice(0.7), 0.7 + ENTRY_PRICE_AGGRESSION_PUSD);
  assert.equal(calculateEntryLimitPrice(0.8), MAX_ENTRY_PRICE_PUSD);
  assert.equal(calculateEntryLimitPrice(MAX_ENTRY_PRICE_PUSD), MAX_ENTRY_PRICE_PUSD);
  assert.equal(calculateEntryLimitPrice(0.83), null);
});

const candidate = (conditionId = "condition-1") => ({
  ready: true,
  market: { conditionId, yesTokenId: "up-token", noTokenId: "down-token", endAt: Date.now() + 60_000, negRisk: false },
  quotes: { yesBestAsk: .6, noBestAsk: .4, yesBestBid: .59, noBestBid: .39, fresh: true },
  signal: { btcDirection: "UP" as const, bookDirection: "UP" as const, selectedDirection: "UP" as const, confirmed: true, reason: "test signal" },
  walletBalancePusd: 100, walletFresh: true,
  inventory: { yesShares: 0, noShares: 0, fresh: true },
});
const journal = () => path.join(mkdtempSync(path.join(tmpdir(), "dual-track-")), "journal.json");

test("stop while entry submission is pending fences subsequent defense submission", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  let release!: (value: any) => void;
  const pending = new Promise<any>((resolve) => { release = resolve; });
  const actions: string[] = [];
  const helper: SupervisorHelper = async (action) => {
    actions.push(action);
    if (action === "submit_fak_buy") return pending;
    if (action === "get_orders") return { ok: true, orders: [{ status: "CANCELED", sizeMatched: 0 }] };
    return { ok: true, orders: [] };
  };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: journal(), helper, bridgeAvailable: true });
  await supervisor.arm();
  const evaluation = supervisor.evaluate(candidate());
  await new Promise((resolve) => setImmediate(resolve));
  await supervisor.emergencyStop();
  release({ ok: true, orders: [{ orderId: "entry-1" }] });
  await evaluation;
  await supervisor.evaluate(candidate());
  assert.equal(actions.includes("submit_gtc_buy"), false);
  assert.equal(supervisor.snapshot().state, "HALTED");
});

test("stop reconciles an accepted filled entry and retains exposed journal fail-closed", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const file = journal();
  let release!: (value: any) => void;
  const pending = new Promise<any>((resolve) => { release = resolve; });
  const actions: string[] = [];
  const helper: SupervisorHelper = async (action) => {
    actions.push(action);
    if (action === "submit_fak_buy") return pending;
    if (action === "get_orders") return { ok: true, orders: [{ status: "FILLED", sizeMatched: 5, executedPrice: .61 }] };
    return { ok: true, orders: [] };
  };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: file, helper, bridgeAvailable: true });
  await supervisor.arm();
  const evaluation = supervisor.evaluate(candidate());
  await new Promise((resolve) => setImmediate(resolve));
  await supervisor.emergencyStop();
  release({ ok: true, orders: [{ orderId: "filled-after-stop" }] });
  await evaluation;
  await supervisor.evaluate(candidate());
  assert.deepEqual(actions, ["submit_fak_buy", "get_orders"]);
  assert.equal(actions.includes("submit_gtc_buy"), false);
  assert.notEqual(supervisor.snapshot().state, "HALTED");
  assert.equal(supervisor.snapshot().state, "PAUSED");
  assert.equal(supervisor.snapshot().remainingShares, 5);
  assert.equal(existsSync(file), true);
});

test("stop with ambiguous accepted-entry status remains paused with journal", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const file = journal(); const actions: string[] = [];
  const helper: SupervisorHelper = async (action) => {
    actions.push(action);
    if (action === "submit_fak_buy") return { ok: true, orders: [{ orderId: "entry-live" }] };
    if (action === "get_orders") return { ok: true, orders: [{ status: "LIVE", sizeMatched: 0 }] };
    return { ok: true, orders: [] };
  };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: file, helper, bridgeAvailable: true });
  await supervisor.arm();
  // Set the durable stop after submission has entered verification.
  await supervisor.evaluate(candidate());
  await supervisor.emergencyStop();
  assert.equal(supervisor.snapshot().state, "PAUSED");
  assert.equal(existsSync(file), true);
  assert.equal(actions.includes("submit_gtc_buy"), false);
});

test("ambiguous accepted submission recovers uniquely by client metadata", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const actions: string[] = []; let first = true;
  const helper: SupervisorHelper = async (action) => {
    actions.push(action);
    if (action === "submit_fak_buy" && first) { first = false; throw new Error("timeout"); }
    if (action === "recover_order") return { ok: true, orders: [{ orderId: "entry-recovered" }] };
    if (action === "get_orders") return { ok: true, orders: [{ orderId: "entry-recovered", status: "FILLED", sizeMatched: 16.5, executedPrice: .59 }] };
    if (action === "submit_gtc_buy") return { ok: true, orders: [{ orderId: "defense-1" }] };
    return { ok: true, orders: [] };
  };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: journal(), helper, bridgeAvailable: true });
  await supervisor.arm(); await supervisor.evaluate(candidate()); await supervisor.arm(); await supervisor.evaluate(candidate());
  assert.deepEqual(actions.slice(0, 4), ["submit_fak_buy", "recover_order", "get_orders", "submit_gtc_buy"]);
  assert.equal(supervisor.snapshot().defenseOrderId, "defense-1");
});

test("partial defense fill cancels and re-reads without another track submission", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const actions: string[] = []; let reads = 0;
  const helper: SupervisorHelper = async (action) => {
    actions.push(action);
    if (action === "submit_fak_buy") return { ok: true, orders: [{ orderId: "entry" }] };
    if (action === "submit_gtc_buy") return { ok: true, orders: [{ orderId: "defense" }] };
    if (action === "cancel_orders") return { ok: true };
    if (action === "get_orders") {
      reads += 1;
      if (reads === 1) return { ok: true, orders: [{ status: "FILLED", sizeMatched: 16.5, executedPrice: .6 }] };
      if (reads === 2) return { ok: true, orders: [{ status: "LIVE", sizeMatched: 2 }] };
      return { ok: true, orders: [{ status: "CANCELED", sizeMatched: 2 }] };
    }
    return { ok: true, orders: [] };
  };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: journal(), helper, bridgeAvailable: true });
  await supervisor.arm(); await supervisor.evaluate(candidate()); await new Promise((resolve) => setTimeout(resolve, 110)); await supervisor.evaluate(candidate());
  assert.deepEqual(actions.filter((a) => a === "cancel_orders"), ["cancel_orders"]);
  assert.equal(actions.some((a) => a === "submit_fak_sell"), false);
  assert.equal(supervisor.snapshot().state, "SETTLEMENT_WAIT");
  assert.equal(supervisor.snapshot().defenseMatchedShares, 2);
});

test("COMPLETE journal blocks same condition after restart and permits a new condition", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const file = journal();
  writeFileSync(file, JSON.stringify({ phase: "COMPLETE", conditionId: "condition-1", side: "UP", tokenId: "up-token", oppositeTokenId: "down-token", entryOrderId: null, defenseOrderId: null, secondEntryOrderId: null, exitOrderId: null, entryPricePusd: .6, shares: 10, defensePricePusd: .38, secondSide: null, secondShares: null, secondEntryPricePusd: null, secondTargetPusd: null, branch: "A", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
  const actions: string[] = [];
  const helper: SupervisorHelper = async (action) => { actions.push(action); return action === "submit_fak_buy" ? { ok: true, orders: [{ orderId: "new-entry" }] } : { ok: true, orders: [] }; };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: file, helper, bridgeAvailable: true });
  await supervisor.arm(); await supervisor.evaluate(candidate("condition-1"));
  assert.equal(actions.length, 0);
  await supervisor.evaluate(candidate("condition-2"));
  assert.equal(actions[0], "submit_fak_buy");
});

test("filled entry without executedPrice fail-closes and never submits defense", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const actions: string[] = [];
  const helper: SupervisorHelper = async (action) => { actions.push(action); if (action === "submit_fak_buy") return { ok: true, orders: [{ orderId: "entry" }] }; if (action === "get_orders") return { ok: true, orders: [{ status: "FILLED", sizeMatched: 10 }] }; return { ok: true, orders: [] }; };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: journal(), helper, bridgeAvailable: true });
  await supervisor.arm(); await supervisor.evaluate(candidate());
  assert.equal(supervisor.snapshot().state, "PAUSED");
  assert.equal(actions.includes("submit_gtc_buy"), false);
});

test("stop during pending Track-A exit reconciles partial result without false HALTED", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const file = journal(); const actions: string[] = [];
  let releaseSell!: (value: any) => void;
  const pendingSell = new Promise<any>((resolve) => { releaseSell = resolve; });
  const helper: SupervisorHelper = async (action, payload) => {
    actions.push(action);
    if (action === "submit_fak_buy") return { ok: true, orders: [{ orderId: "entry" }] };
    if (action === "submit_gtc_buy") return { ok: true, orders: [{ orderId: "defense" }] };
    if (action === "cancel_orders") return { ok: true };
    if (action === "submit_fak_sell") return pendingSell;
    if (action === "get_orders") {
      const id = (payload.orderIds as string[])[0];
      if (id === "entry") return { ok: true, orders: [{ status: "FILLED", sizeMatched: 16.5, executedPrice: .6 }] };
      if (id === "defense") return { ok: true, orders: [{ status: actions.includes("cancel_orders") ? "CANCELED" : "LIVE", sizeMatched: 0 }] };
      return { ok: true, orders: [{ status: "CANCELED", sizeMatched: 4 }] };
    }
    return { ok: true, orders: [] };
  };
  const supervisor = createAutomaticPairExecutionSupervisor({ journalPath: file, helper, bridgeAvailable: true });
  await supervisor.arm(); await supervisor.evaluate(candidate());
  await new Promise((resolve) => setTimeout(resolve, 110));
  const highBid = candidate(); highBid.quotes.yesBestBid = .7;
  const exiting = supervisor.evaluate(highBid);
  await new Promise((resolve) => setImmediate(resolve));
  await supervisor.emergencyStop();
  releaseSell({ ok: true, orders: [{ orderId: "track-a-exit" }] });
  await exiting; await supervisor.evaluate(highBid);
  assert.equal(supervisor.snapshot().state, "PAUSED");
  assert.equal(supervisor.snapshot().remainingShares, 12.5);
  assert.equal(existsSync(file), true);
  assert.equal(actions.filter((action) => action === "submit_fak_sell").length, 1);
});

test("corrupted journal restarts fail-closed and ARM remains blocked", async () => {
  process.env.LIVE_TRADING_ENABLED = "true";
  const file = journal(); writeFileSync(file, "{not-json");
  const actions: string[] = [];
  const supervisor = createAutomaticPairExecutionSupervisor({
    journalPath: file,
    bridgeAvailable: true,
    helper: async (action) => { actions.push(action); return { ok: true, orders: [] }; },
  });
  assert.equal(supervisor.snapshot().state, "PAUSED");
  await supervisor.arm(); await supervisor.evaluate(candidate());
  assert.equal(supervisor.snapshot().armed, false);
  assert.equal(supervisor.snapshot().state, "PAUSED");
  assert.equal(actions.length, 0);
  assert.equal(existsSync(file), true);
});