/**
 * Pair capacity is calculated from the verified wallet collateral and the
 * current common YES/NO ask depth. There is deliberately no account-percentage
 * cap or synthetic balance fallback.
 */

export type ExecutionStakeReason =
  | "WALLET_LIMIT"
  | "MARKET_LIQUIDITY_LIMIT"
  | "NO_EXECUTABLE_VOLUME";

export type FinalExecutionStakeInput = {
  currentBalancePusd: number;
  commonDepthShares: number;
  combinedAskPusd: number;
};

export type FinalExecutionStakeResult = {
  walletMaxStakePusd: number;
  commonDepthShares: number;
  combinedAskPusd: number;
  marketAvailableVolumePusd: number;
  finalExecutionStakePusd: number;
  executable: boolean;
  executionReason: ExecutionStakeReason;
};

function roundDownCents(value: number): number {
  return Math.floor((value + Number.EPSILON) * 100) / 100;
}

export function calculateFinalExecutionStake({
  currentBalancePusd,
  commonDepthShares,
  combinedAskPusd,
}: FinalExecutionStakeInput): FinalExecutionStakeResult {
  if (!Number.isFinite(currentBalancePusd) || currentBalancePusd < 0) {
    throw new Error("currentBalancePusd must be a finite non-negative number");
  }
  if (!Number.isFinite(commonDepthShares) || commonDepthShares < 0) {
    throw new Error("commonDepthShares must be a finite non-negative number");
  }
  if (
    !Number.isFinite(combinedAskPusd) ||
    combinedAskPusd <= 0 ||
    combinedAskPusd > 2
  ) {
    throw new Error("combinedAskPusd must be a positive finite number no greater than 2");
  }

  const marketAvailableVolumePusd = roundDownCents(
    commonDepthShares * combinedAskPusd,
  );
  const finalExecutionStakePusd = Math.min(
    roundDownCents(currentBalancePusd),
    marketAvailableVolumePusd,
  );
  const executable =
    finalExecutionStakePusd >= combinedAskPusd && commonDepthShares >= 1;

  return {
    walletMaxStakePusd: roundDownCents(currentBalancePusd),
    commonDepthShares,
    combinedAskPusd,
    marketAvailableVolumePusd,
    finalExecutionStakePusd,
    executable,
    executionReason: !executable
      ? "NO_EXECUTABLE_VOLUME"
      : currentBalancePusd <= marketAvailableVolumePusd
        ? "WALLET_LIMIT"
        : "MARKET_LIQUIDITY_LIMIT",
  };
}