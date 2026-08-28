---
name: Recoverable order lifecycle
description: Safety rules for ambiguous submissions, emergency stops, and restart recovery in the trading supervisor.
---

Every exchange submission must have a durable recovery identity written before the request leaves the process. Emergency stops must fence all later submissions and reconcile every possible in-flight phase before reporting a clean halt. Missing, malformed, or unreadable journals are unsafe states, not equivalent to having no journal.

**Why:** Network timeouts can occur after exchange acceptance, stop requests can race any awaited order call, and corrupted recovery state can hide live orders or inventory. Treating any of these as clean completion can create duplicate or unmanaged exposure.

**How to apply:** Persist a client identifier before each submission; recover uniquely from authenticated order/trade history; retain the journal and remain PAUSED on partial, filled, live, ambiguous, or unreadable state. Only report HALTED when zero exposure and no resting order are conclusively proven. Exercise each phase with dependency-injected lifecycle tests.