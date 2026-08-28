import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Router, type IRouter } from "express";
import {
  GetPolymarketMarketQueryParams,
  GetPolymarketCompoundQueryParams,
  GetPolymarketMarketResponse,
  GetPolymarketStatusResponse,
} from "@workspace/api-zod";
import {
  calculateFinalExecutionStake,
} from "../lib/compound";
import { isCLOBSingleLegBridgeAvailable } from "../lib/automatic-pair-execution";
import { liveMarketData } from "../lib/live-market-data";

const execFileAsync = promisify(execFile);
const router: IRouter = Router();

const CLOB_TIME_URL = "https://clob.polymarket.com/time";
const CLOB_MARKET_URL = "https://clob.polymarket.com/clob-markets";

function proxyUrl(): string | undefined {
  return process.env.RESIDENTIAL_PROXY_URL?.trim();
}

function credentialsConfigured(): boolean {
  return Boolean(
    process.env.POLYMARKET_PRIVATE_KEY?.trim() &&
      process.env.POLYMARKET_FUNDER?.trim(),
  );
}

async function curlThroughProxy(url: string): Promise<string> {
  const proxy = proxyUrl();

  if (!proxy) {
    throw new Error("RESIDENTIAL_PROXY_URL is not configured");
  }

  const { stdout } = await execFileAsync(
    "curl",
    [
      "--silent",
      "--show-error",
      "--fail",
      "--location",
      "--max-time",
      "10",
      "--proxy",
      proxy,
      url,
    ],
    { maxBuffer: 1024 * 1024 },
  );

  return stdout;
}

async function isProxyReachable(): Promise<boolean> {
  try {
    await curlThroughProxy(CLOB_TIME_URL);
    return true;
  } catch {
    return false;
  }
}

router.get("/polymarket/status", async (_req, res) => {
  const proxyConfigured = Boolean(proxyUrl());
  const proxyReachable = proxyConfigured && (await isProxyReachable());
  const liveTradingEnabled = process.env.LIVE_TRADING_ENABLED === "true";
  const hasCredentials = credentialsConfigured();
  const executionAvailable = isCLOBSingleLegBridgeAvailable();

  const data = GetPolymarketStatusResponse.parse({
    mode: proxyReachable && liveTradingEnabled && executionAvailable ? "LIVE_ARMED" : proxyReachable ? "LIVE_READ_ONLY" : "MOCK",
    proxyConfigured,
    proxyReachable,
    credentialsConfigured: hasCredentials,
    liveTradingEnabled,
    executionAvailable,
    message: proxyReachable && executionAvailable
      ? liveTradingEnabled
        ? "Binance perpetual top-three 4x depth plus >10 BTC aggressive flow in 50 ms drives a fixed 1.00 pUSD FAK entry at ask + 0.01 (0.40–0.82 cap), immediately protected by an opposite GTC defense and dual-track reconciliation."
        : "Binance-driven dual-track CLOB execution is installed but disabled by LIVE_TRADING_ENABLED."
      : "The proxy guard is closed. Live requests are blocked and the dashboard remains in mock mode.",
  });

  res.json(data);
});

router.get("/polymarket/live", (_req, res) => {
  res.json(liveMarketData.snapshot());
});

router.post("/polymarket/execution/stop", async (_req, res) => {
  res.json(await liveMarketData.emergencyStopExecution());
});

router.post("/polymarket/execution/arm", async (_req, res) => {
  res.json(await liveMarketData.armExecution());
});

router.post("/polymarket/execution/pause", async (_req, res) => {
  res.json(await liveMarketData.pauseExecution());
});

router.get("/polymarket/compound", (req, res) => {
  if (
    req.query.commonDepth === undefined ||
    req.query.combinedAsk === undefined
  ) {
    res.status(400).json({
      error:
        "A common-depth and combined-ask market snapshot is required to calculate pair capacity.",
    });
    return;
  }

  let query: ReturnType<typeof GetPolymarketCompoundQueryParams.parse>;
  try {
    query = GetPolymarketCompoundQueryParams.parse(req.query);
  } catch {
    res.status(400).json({
      error:
        "commonDepth must be non-negative and combinedAsk must be between 0 and 2.",
    });
    return;
  }

  try {
    const live = liveMarketData.snapshot();
    if (live.wallet.balancePusd === null) {
      throw new Error("An authenticated CLOB collateral balance is required.");
    }
    const result = calculateFinalExecutionStake({
      currentBalancePusd: live.wallet.balancePusd,
      commonDepthShares: query.commonDepth,
      combinedAskPusd: query.combinedAsk,
    });

    res.json({
      ...result,
      balanceSource: "POLYMARKET_CLOB_COLLATERAL_BALANCE",
      marketSource: "REQUEST_MARKET_SNAPSHOT",
    });
  } catch (error) {
    res.status(503).json({
      error:
        error instanceof Error
          ? error.message
          : "Compound balance configuration is invalid.",
    });
  }
});

router.get("/polymarket/market", async (req, res) => {
  const input = GetPolymarketMarketQueryParams.parse(req.query);

  try {
    const response = await curlThroughProxy(
      `${CLOB_MARKET_URL}/${encodeURIComponent(input.conditionId)}`,
    );
    const raw = JSON.parse(response) as Record<string, unknown>;
    const data = GetPolymarketMarketResponse.parse({
      conditionId: input.conditionId,
      fetchedAt: new Date(),
      raw,
    });

    res.json(data);
  } catch {
    req.log.warn("Polymarket market request failed");
    res.status(503).json({
      error:
        "Live market data is unavailable because the proxy or the Polymarket upstream could not be reached.",
    });
  }
});

export default router;