# Part 1 - Code review of `withdraw`

## 1. Problems, most dangerous first

### 1. Race condition: read-check-write on the balance (double spend)
`findOne` -> check -> `$set: { balance: newBalance }` is not atomic, and `$set` writes an absolute value computed from a stale read.

**Scenario:** balance Rs 1000. The user (or a script, or a retry after a timeout) fires two withdrawals of Rs 1000 at once. Both read 1000, both pass the check, both call the gateway. Two payouts of Rs 1000 leave the company and the wallet ends at 0. We lost Rs 1000. A concurrent reward credit can also be silently overwritten by the stale `$set` (lost update).

**Fix:** one conditional atomic update: `findOneAndUpdate({userId, balance: {$gte: amount}}, {$inc: {balance: -amount}})`. No match = insufficient funds. Never write an absolute balance computed in app code.

### 2. Payout is fire-and-forget: money debited, nothing sent
`gateway.createPayout(...)` is not awaited, so the `try/catch` can never catch an async rejection. The wallet is debited first, and if the gateway call fails we log and carry on. The ledger says "withdrawal" and the user gets `ok: true`.

**Scenario:** the gateway returns 5xx, or the process is killed right after the debit. The user is debited and never paid. This is exactly the "money debited but not received" complaint in Part 3.

**Fix:** model the withdrawal as a persisted state machine (`pending -> processing -> submitted -> succeeded | failed`) created in the same transaction as the debit. A worker makes the gateway call and, on a *definitive* failure only, reverses the debit with a ledger entry.

### 3. No idempotency, and the mobile app retries timeouts
**Scenario:** the request is slow (see #7), the app times out and retries while the first request is still running. Two debits, two payouts. Same loss as #1, but it happens even if requests are perfectly serialized.

**Fix:** client-supplied `Idempotency-Key`, a `withdrawals` collection with a unique index on `(userId, idempotencyKey)`, and replay of the stored result on duplicates. Send the `withdrawalId` to the gateway as its own idempotency/reference key.

### 4. Wallet, gateway and ledger are not atomic (no transaction, no outbox)
**Scenario:** the process crashes between the wallet update and `Ledger.insert`. The balance went down but there is no ledger row; the books do not reconcile and finance cannot explain the gap.

**Fix:** wallet debit + withdrawal row + ledger row + outbox row in one MongoDB transaction. The gateway call happens after commit, driven by the outbox.

### 5. Authorization: `userId` comes from the request body
**Scenario:** anyone who can reach the endpoint can trigger withdrawals for any user. If the bank account can be changed through another endpoint, that is direct theft.

**Fix:** take `userId` from the authenticated session. Require an active user with a verified bank account.

### 6. No validation of `amount`
**Scenario:** `{amount: -100000}`: `balance >= -100000` is true, `newBalance = balance + 100000`, so the wallet is credited out of thin air. Strings, `NaN`, `Infinity`, `0.001`, `"1e9"` all misbehave too. (`amount * 1.0` does nothing useful.)

**Fix:** require a safe integer in minor units with `MIN <= amount <= MAX`; reject everything else with 400.

### 7. Unbounded `Ledger.find().sort()` on 40M docs with no index
Only `_id` is indexed. `find({userId}).sort({createdAt:-1})` is a collection scan plus in-memory sort, and the whole history is returned in the response.

**Scenario:** this is the p95 going from 300ms to 11s on payout day. Slow requests -> client timeouts -> retries (#3) -> more load -> more double debits. A performance bug turns into a money bug.

**Fix:** do not return history from the withdraw endpoint (separate paginated `GET /ledger?cursor=`), and add `{userId: 1, createdAt: -1}` on `Ledger`. `Wallets` also needs a unique index on `userId` (it is queried by `userId` on 2M docs with only `_id` indexed).

### 8. Float money
JS floats for balances: `0.1 + 0.2 !== 0.3`. Over millions of operations the ledger drifts, and `>=` comparisons become unreliable.

**Fix:** integer paise everywhere; convert only at the display edge.

### 9. Weak reference: `'WD-' + Date.now()`
Two withdrawals in the same millisecond share a reference, and the reference is not stored anywhere, so reconciling with the gateway dashboard is impossible.

**Fix:** reference = the withdrawal `_id`, stored on the withdrawal and sent to the gateway.

### 10. Unhandled errors after the debit; missing null checks
`wallet` can be `null` -> `TypeError` -> 500 with unclear state. Any exception after the debit (ledger insert, history query) leaves a debited wallet and an error response, which invites a retry (#3).

**Fix:** everything after the debit lives in one transaction with one error handler; the response is built from committed data.

### 11. Logging / observability
`console.log('gateway error', e)` can leak bank details, has no correlation id, and alerts nobody.

**Fix:** structured logs with `withdrawalId`, no account numbers, alerts on stuck/`needs_review` withdrawals.

## 2. Rewrite
See `withdraw.js` (request path), `payoutWorker.js` (gateway call + reversal), `indexes.js`.

Decisions:
- Atomic conditional `$inc` inside a transaction together with the withdrawal, ledger and outbox rows.
- Idempotency via unique index; a duplicate key replays the original response (422 if same key but different amount).
- Returns **202** with `withdrawalId`: money has left the wallet, the payout is async. The app polls `GET /withdrawals/:id`.
- The worker retries timeouts/5xx with the *same* gateway reference. It reverses the debit only on a definitive rejection. Unknown outcomes after N attempts go to `needs_review`; we never auto-refund an unknown outcome because that is how you pay twice.

## 3. Design changes beyond this function
Make the ledger the source of truth (append-only, with the wallet balance as a derived cache) and run a daily reconciliation of ledger vs withdrawals vs the gateway settlement report. Move every external side effect (payouts, notifications) behind an outbox/queue with idempotency keys, so web latency and gateway health can never affect money correctness. Add per-user and per-day limits, holds for newly added bank accounts, and a feature-flag kill switch on payouts. Put dashboards and alerts on stuck withdrawals, reversal rate and gateway error rate so we find problems before users do. Finally, check every query's `explain()` against production-sized data before a payout day.
