---
name: Directional execution arm state and recovery
description: Manual re-arming and recovery rules for the single-leg directional BTC strategy.
---

Every process restart must return the live-money supervisor to PAUSED and require
an explicit operator START. Entry requires combined Up/Down best ask below 0.99;
BTC 60-second direction selects the candidate side and matching near-book
pressure confirms it. BTC never triggers entry by itself.

**Why:** The user replaced protected two-sided execution with one directional
position while retaining the combined-ask mispricing gate.

**How to apply:** Buy only the confirmed Up or Down token using FOK and size from
10% of available pUSD, rounded to valid order precision without exceeding the
wallet. Unknown entry results block duplicate entries.

Activity-history timestamps and a 100c redemption are not proof that two legs
were submitted or filled as one pair. Treat fills as a pair only when exact
order IDs, matched sizes, and lifecycle/trade records correlate.

**Why:** Human-facing activity rows can be minutes apart and redemption only
proves that a winning token settled; grouping adjacent rows incorrectly can
hide a directional single-leg position.

**How to apply:** Keep adjacent activity entries separate until exchange-side
order and trade evidence proves they belong to the same execution attempt.

After a confirmed entry, target entry price +0.02 pUSD per share. Exit the same
token with FAK/IOC and accept no more than 1% slippage. A partial, rejected, or
unknown exit pauses new entries and keeps querying/retrying until inventory is
zero; it must not enter HALTED merely because the exit is incomplete.

**Why:** Exit completion takes priority over all new opportunities, but a
persistent HALTED lock would prevent the requested autonomous liquidation loop.

**How to apply:** Maintain a durable position/exit journal, serialize execution
ticks, and do not evaluate a new entry while any confirmed position remains.
