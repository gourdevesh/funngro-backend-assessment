'use strict';
// Run once at deploy time. On a 40M-row collection build via Atlas (rolling index build), off-peak.
async function ensureIndexes(db) {
  // wallets: one wallet per user, and the hot lookup/update path for withdraw
  await db.collection('wallets').createIndex({ userId: 1 }, { unique: true });

  // ledger: "show me this user's history, newest first" (cursor-paginated)
  await db.collection('ledger').createIndex({ userId: 1, createdAt: -1 });
  // ledger: a withdrawal can be reversed at most once
  await db.collection('ledger').createIndex(
    { withdrawalId: 1, type: 1 },
    { unique: true, partialFilterExpression: { withdrawalId: { $exists: true } } }
  );

  // withdrawals: idempotency. Serves the replay lookup AND enforces no double-accept.
  await db.collection('withdrawals').createIndex({ userId: 1, idempotencyKey: 1 }, { unique: true });
  // withdrawals: ops dashboard / alert on stuck states
  await db.collection('withdrawals').createIndex({ status: 1, updatedAt: 1 });

  // outbox: the worker's claim query
  await db.collection('outbox').createIndex({ status: 1, nextAttemptAt: 1 });
}
module.exports = { ensureIndexes };
