# Part 2 - Reward points: schema and query design

Money in integer paise; points are integers. All timestamps UTC `Date`.

## 1. Collections

### `point_lots` - one row per earning event (what makes expiry and FIFO possible)
```
{
  _id: ObjectId,
  userId: ObjectId,
  source: { type: 'project' | 'promo', refId: ObjectId|String },  // project id or promo event id
  points: Int,              // originally granted, > 0
  remaining: Int,           // decremented on convert/expire
  earnedAt: Date,
  expiresAt: Date | null,
  status: 'active' | 'exhausted' | 'expired'
}
```

### `points_ledger` - append-only audit trail, one row per balance movement (the finance report reads this)
```
{
  _id: ObjectId,
  userId: ObjectId,
  type: 'earn' | 'convert' | 'expire' | 'reverse',
  points: Int,              // always positive; direction comes from `type`
  lotId: ObjectId,          // which lot was touched
  conversionId: ObjectId?,  // for convert / reverse
  createdAt: Date           // when it happened (report month is based on this)
}
```
Never updated or deleted. Corrections are new `reverse` rows.

### `points_balances` - cached available balance, used only as the atomic guard
```
{ _id: userId, available: Int, updatedAt: Date }
```
Always changed with `$inc` in the same transaction as the ledger rows. A nightly job verifies `available == sum(lots.remaining)`.

### `point_rates` - conversion rate over time
```
{ _id: ObjectId, paisePerPoint: Int, effectiveFrom: Date, effectiveTo: Date|null, createdBy: String, createdAt: Date }
```
Rates are inserted, never edited. Rate in force at time T: latest `effectiveFrom <= T`.

### `point_conversions` - one document per conversion request (auditable)
```
{
  _id: ObjectId,
  userId: ObjectId,
  idempotencyKey: String,
  points: Int,
  rateId: ObjectId,
  paisePerPoint: Int,       // snapshot, so changing rates later cannot change history
  cashPaise: Int,           // points * paisePerPoint
  lotsConsumed: [{ lotId, points }],
  walletLedgerId: ObjectId, // the wallet `ledger` row that credited cash
  createdAt: Date
}
```

`users.cohort` (e.g. `"2026-03"`, signup month) is assumed to exist; if not, derive from `users.createdAt`.

## Indexes - each tied to a query

| Collection | Index | Query it serves |
|---|---|---|
| `point_lots` | `{ source.type:1, source.refId:1, userId:1 }` **unique** | Idempotent earning: the same project completion cannot grant points twice. |
| `point_lots` | `{ userId:1, expiresAt:1 }` partial `{remaining:{$gt:0}}` | Convert picks the user's active lots, soonest-expiring first (FIFO by expiry). |
| `point_lots` | `{ expiresAt:1 }` partial `{status:'active'}` | Nightly expiry job: "all active lots with expiresAt <= now". Partial keeps it small. |
| `points_ledger` | `{ createdAt:1, type:1, userId:1 }` | Finance monthly report: range scan on the month, grouped by user; covered query on these 3 fields + `points` can be added if the report becomes slow. |
| `points_ledger` | `{ userId:1, createdAt:-1 }` | User-facing history, paginated. |
| `point_conversions` | `{ userId:1, idempotencyKey:1 }` **unique** | Double-conversion protection + replaying the original response on retry. |
| `point_conversions` | `{ userId:1, createdAt:-1 }` | Audit lookup per user. |
| `point_rates` | `{ effectiveFrom:-1 }` | "Rate in force now / at time T" = one-document lookup. |
| `points_balances` | `_id` (userId) | Atomic guard on conversion. |

## 2. Monthly finance report
See `monthlyReport.js` (real code). Summary: match `points_ledger` on `createdAt` in `[monthStart, nextMonthStart)` in IST, group by `userId`, sum points by type with `$cond`, then `$lookup` users for the cohort. Cohort roll-up is one more `$group` on `cohort`.

Note: "expired in a month" = ledger rows of type `expire` created that month, which the nightly job writes with `createdAt` = the lot's `expiresAt` (not the job run time), so late runs do not shift points to the wrong month. Ask finance whether they want that.

## 3. How concurrent double-conversion is prevented
The conversion runs inside one transaction. The first statement is an atomic conditional decrement `points_balances.findOneAndUpdate({_id: userId, available: {$gte: points}}, {$inc: {available: -points}})`; if two concurrent requests race, MongoDB serializes the writes to that single document, and the second either sees the reduced balance and matches nothing (insufficient points) or hits a write conflict and retries, after which it fails the same check. The lots are decremented with the same pattern (`remaining: {$gte: take}`), so even if the cached balance were wrong, no lot can go negative. A retry of the *same* request (client timeout) is stopped by the unique `(userId, idempotencyKey)` index on `point_conversions`, which makes the loser abort and return the original result. The wallet credit, ledger rows and conversion document commit atomically or not at all, so there is no state where points are gone but cash is missing, or the reverse.
