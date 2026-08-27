---
name: Protected-pair arm state and fail-closed recovery
description: Manual re-arming and durable recovery rules for ambiguous real-money pair submissions.
---

Every process restart must return the live-money supervisor to PAUSED and require
an explicit operator START. An ambiguous or partial pair submission must persist
a recovery lock and remain HALTED across restarts.

**Why:** A real batch returned one accepted FOK leg and one precision rejection.
Automatic cooldown retries and memory-only state could have repeated exposure or
lost the incident state after a restart.

**How to apply:** Journal intent before submission. Retry only when there is
positive proof that no order reached the venue. Partial acknowledgements,
missing IDs, lookup failures, mixed statuses, and uncertain cancellations all
stay HALTED until an operator resolves the exposure.

Activity-history timestamps and a 100c redemption are not proof that two legs
were submitted or filled as one pair. Treat fills as a pair only when exact
order IDs, matched sizes, and lifecycle/trade records correlate.

**Why:** Human-facing activity rows can be minutes apart and redemption only
proves that a winning token settled; grouping adjacent rows incorrectly can
hide a directional single-leg position.

**How to apply:** Keep adjacent activity entries separate until exchange-side
order and trade evidence proves they belong to the same execution attempt.

Single-leg rescue must be mutually exclusive. After canceling the missing
original FOK, re-read it and require a terminal-unfilled lifecycle plus an
explicit zero matched quantity. Apply the same proof to a failed rescue hedge
before selling the original leg. Any contradictory or unknown response HALTs.

**Why:** A cancel/status race or overlapping reconciliation tick can otherwise
create a duplicate hedge or sell the original leg after the supposedly missing
leg actually filled.

**How to apply:** Hold one lock across reconciliation and the complete rescue
sequence. Preflight the real custody-compatible Merge route and conservative
gas reserve before buying the missing leg. Once both legs are balanced, never
sell one leg because Merge failed; preserve the complete set and HALT.
