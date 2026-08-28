---
name: Directional execution arm state and recovery
description: Manual re-arming and recovery rules for the single-leg directional BTC strategy.
---

Every process restart must return the live-money supervisor to PAUSED and require
an explicit operator START. Entry requires combined Up/Down best ask strictly
below 1.00. Non-flat BTC 1-second momentum selects the side immediately and has
priority; when momentum is flat, clear near-book imbalance may select the side.

**Why:** The user replaced protected two-sided execution with one directional
position while retaining the combined-ask mispricing gate.

**How to apply:** Derive the 1-second move from a high-frequency Binance trade
stream, not a once-per-second ticker. Buy only the selected Up or Down token using
market-style FAK (the available IOC-style order type) and size from 10% of
available pUSD, rounded to valid order precision without exceeding the wallet.
Unknown entry results block duplicate entries.

Activity-history timestamps and a 100c redemption are not proof that two legs
were submitted or filled as one pair. Treat fills as a pair only when exact
order IDs, matched sizes, and lifecycle/trade records correlate.

**Why:** Human-facing activity rows can be minutes apart and redemption only
proves that a winning token settled; grouping adjacent rows incorrectly can
hide a directional single-leg position.

**How to apply:** Keep adjacent activity entries separate until exchange-side
order and trade evidence proves they belong to the same execution attempt.

After a confirmed entry, calculate an absolute sell trigger as entry price +0.05
pUSD per share (for example, 0.65 → 0.70). This is a price trigger, not a
wallet-level profit amount. Once the live best bid reaches that trigger, exit the
same token immediately with a market-style FAK priced at the current best bid.
A partial, rejected, or unknown exit pauses new entries and keeps
querying/retrying at the latest executable bid until inventory is zero; it must
not enter HALTED merely because the exit is incomplete.

**Why:** Exit completion takes priority over all new opportunities, and the user
explicitly means a sell-price trigger of entry +0.05 pUSD, followed by immediate
taker liquidation at the live bid. A persistent HALTED lock would prevent the
requested autonomous liquidation loop.

**How to apply:** Maintain a durable position/exit journal, serialize execution
ticks, and do not evaluate a new entry while any confirmed position remains.
