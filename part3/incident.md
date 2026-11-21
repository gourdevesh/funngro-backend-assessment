# Part 3 - 9pm payout day: p95 300ms -> 11s, "debited but not received"

I did not write this system, so I assume nothing about it and look at evidence before changing anything. Two symptoms, probably linked: (a) slow endpoint, (b) money debited with no payout. Slowness plus app retries can turn into duplicate debits, so the worst case is still getting worse while I investigate.

## Minutes 0-5: stop the bleeding (before root cause)
1. **Tell people I'm on it.** Post in the incident channel: "Withdraw p95 11s, debited-not-received reports. I'm incident lead. Next update in 15 min." Ask support to stop telling users to "just retry" and to log affected user ids + timestamps in one shared sheet.
2. **Put withdrawals behind a kill switch / maintenance mode** (feature flag, or at the load balancer return 503 with a friendly message for `POST /api/wallet/withdraw`). Reason: every extra withdrawal now may be debited without a payout, and every timeout triggers a client retry that can double-debit. Reads (balance, history) stay up. Trigger: if there's no flag, a 3-line deploy or an ingress rule is acceptable. This is a business decision (payout day, angry users), so I tell the founder in the same message and do not hide it, but I would not leave the endpoint running if the gateway dashboard shows any payouts missing.
3. **Do not touch money data yet.** No manual refunds, no re-running payouts, no scripts.

## Minutes 5-15: find out what is slow and what is broken
**MongoDB Atlas metrics:** Operation Execution Time, Query Targeting (scanned/returned ratio; a ratio in the thousands means collection scans), Opcounters, Connections, Disk IOPS/queue depth, CPU, Replication lag, WiredTiger cache dirty %. Open **Performance Advisor** and **Real-Time Panel**.

**mongosh:**
```js
db.currentOp({ active: true, secs_running: { $gte: 3 } })            // what's running long, which collection
db.ledger.find({ userId: ObjectId("<an affected user>") }).sort({ createdAt: -1 }).explain("executionStats")
db.ledger.getIndexes()
db.ledger.estimatedDocumentCount()
```
I expect: `COLLSCAN` + in-memory `SORT` on `ledger` (only `_id` indexed, 40M docs), `totalDocsExamined` ~ 40M. That matches the code: each withdraw ends with `Ledger.find({userId}).sort({createdAt:-1})` returning full history.

**App logs:** group by endpoint and duration; look for `gateway error` lines (they're swallowed `console.log`s), count per minute; look for the same `userId` hitting `/withdraw` multiple times (client retries).

**Gateway dashboard:** count of payouts created vs ledger `withdrawal` rows in the last 2h; error/timeout rate; are payouts `pending`, `failed`, or absent? Note that the code builds references as `'WD-' + Date.now()`, so matching is by user + amount + time window, not by reference.

Decision tree:
- Gateway returns errors/timeouts and we log "gateway error" -> that's the missing payouts: the debit already happened (the code debits first, never awaits the gateway call, swallows errors).
- Mongo shows COLLSCAN on `ledger` -> that's the latency. Fix in the next step.
- Both -> both are true, and they amplify each other.

## Minutes 15-25: fix the latency safely, scope the damage
1. **Quick fix for latency without touching the money path:** deploy a hotfix that stops returning `history` from the withdraw response (the app presumably only needs `ok`/`balance`; I'd check the app code/with the mobile dev first). This removes the 40M-doc scan from the hot path immediately and carries no schema risk.
2. **Index:** create `{userId: 1, createdAt: -1}` on `ledger` via Atlas (rolling build). On a loaded 40M-doc collection I would do this only after traffic is stopped by the kill switch, because the build consumes IO/CPU; on 4.2+ it doesn't block reads/writes but can slow things. Check `db.currentOp({ "command.createIndexes": { $exists: true } })` for progress. Also confirm `wallets` has an index on `userId` (2M docs).
3. **Kill long ops** that are only the history scans: `db.killOp(<opid>)` for those, not blanket-killing everything.
4. **Scope the money damage** with a read-only script/query:
   - All `ledger` `type: 'withdrawal'` rows since the incident start, with user, amount, createdAt.
   - Gateway payout export for the same window.
   - Diff -> three buckets: (A) debited and paid (fine), (B) debited, no payout (users owed), (C) paid twice (we owe the bank; same user, same amount, close timestamps = retry duplicates).

## Minutes 25-30: communicate and decide
- **Support:** list of bucket (B) users, with a holding message: "Your withdrawal is being processed; you will receive it or it will be returned to your wallet within X hours. Please don't retry."
- **Founder/management:** facts, not guesses: what's broken, what's off, how many users and how much money are in B and C, what I'm doing next, and when the next update is.
- **Decisions and their triggers:**
  - If gateway status is bad on their side (dashboard shows incident) -> keep payouts disabled, wait, don't refund yet.
  - If gateway is healthy and bucket B is confirmed absent at the gateway (by user+amount+window and by asking the gateway to look up) -> re-submit those payouts **one by one, with a unique idempotency reference per withdrawal**, or credit back the wallets with a ledger entry each, whichever finance prefers. Not before verifying at the gateway, because "no record on dashboard" can just be a delayed record.
  - If bucket C (double payouts) exists -> raise with finance/gateway for recovery; don't claw back from users without a policy decision.
  - Re-enable the endpoint only after: latency back to normal on staging-like data, the index is in, and either the fixed handler (see Part 1) is deployed or a hard per-user cap + dedupe guard is in place.

## What I would not do, and why
- **Not restart/scale the Mongo cluster blindly.** Scaling up an unindexed 40M-row scan just moves the cliff, a restart wipes the cache and the evidence, and failovers during payouts add risk.
- **Not re-run failed payouts or bulk-refund wallets from a script I just wrote** at 9pm. If the gateway has the payout and we refund, we pay twice; if we re-run without an idempotency reference, same. Verify per withdrawal, with a second person reviewing the list.
- **Not delete or "fix" ledger rows.** The ledger is the audit trail; corrections are new rows.
- **Not just raise the client timeout** (hides the symptom, increases duplicate-debit window).
- **Not hotfix the whole payout flow live** tonight; the full fix (Part 1 rewrite) goes through review and testing. Tonight is containment: stop new damage, quantify, communicate.

## Afterwards
Blameless post-mortem: root causes (no index, no idempotency, fire-and-forget payout), add alerts (p95 of withdraw, gateway error rate, `ledger` COLLSCANs via Atlas Performance Advisor, count of debits without a matching payout after 5 min), daily reconciliation, and load-testing with production-sized data before payout days.
