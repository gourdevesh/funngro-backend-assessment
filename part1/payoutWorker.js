'use strict';
/**
 * Outbox worker: performs the gateway call AFTER the debit has committed.
 *
 * Rules:
 *  - The gateway reference/idempotency key is the withdrawalId, so retries cannot pay twice
 *    (REQUIRES the gateway to dedupe on it - see README assumption 4).
 *  - Definitive rejection (4xx)      -> reverse the debit.
 *  - Success                         -> mark submitted; webhook/poller moves to succeeded.
 *  - Timeout / 5xx / unknown outcome -> retry with SAME reference; after MAX_ATTEMPTS -> needs_review.
 *                                       NEVER auto-reverse an unknown outcome (could double pay).
 */
const GATEWAY_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 6;
const LOCK_MS = 60_000;

const backoffMs = (attempt) => Math.min(30 * 60_000, 2 ** attempt * 5_000);

function withTimeout(promise, ms) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error('gateway_timeout'), { unknown: true })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function makeWorker({ client, db, gateway, logger = console }) {
  const Outbox = db.collection('outbox');
  const Withdrawals = db.collection('withdrawals');
  const Wallets = db.collection('wallets');
  const Ledger = db.collection('ledger');

  async function claim() {
    const now = new Date();
    // lock-and-claim in one atomic step; a crashed worker's claim expires via lockedUntil
    return Outbox.findOneAndUpdate(
      {
        type: 'payout',
        status: { $in: ['pending', 'claimed'] },
        nextAttemptAt: { $lte: now },
        $or: [{ lockedUntil: { $exists: false } }, { lockedUntil: { $lte: now } }],
      },
      { $set: { status: 'claimed', lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' }
    );
  }

  async function reverse(withdrawal, reason) {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        // guard: only reverse once, and only from a non-final state
        const r = await Withdrawals.updateOne(
          { _id: withdrawal._id, status: { $in: ['pending', 'processing'] } },
          { $set: { status: 'failed', failureReason: reason, updatedAt: new Date() } },
          { session }
        );
        if (r.modifiedCount !== 1) return; // already handled by someone else

        const wallet = await Wallets.findOneAndUpdate(
          { userId: withdrawal.userId },
          { $inc: { balance: withdrawal.amount } },
          { returnDocument: 'after', session }
        );
        await Ledger.insertOne(
          {
            userId: withdrawal.userId,
            type: 'withdrawal_reversal',
            amount: withdrawal.amount,
            balanceAfter: wallet.balance,
            withdrawalId: withdrawal._id,   // unique (withdrawalId, type) index prevents a second reversal
            reason,
            createdAt: new Date(),
          },
          { session }
        );
      }, { writeConcern: { w: 'majority' } });
    } finally {
      await session.endSession();
    }
  }

  async function processOne() {
    const job = await claim();
    if (!job) return false;

    const withdrawal = await Withdrawals.findOne({ _id: job.withdrawalId });
    if (!withdrawal || ['failed', 'succeeded', 'submitted'].includes(withdrawal.status)) {
      await Outbox.updateOne({ _id: job._id }, { $set: { status: 'done' } });
      return true;
    }

    await Withdrawals.updateOne(
      { _id: withdrawal._id, status: 'pending' },
      { $set: { status: 'processing', updatedAt: new Date() } }
    );

    try {
      const result = await withTimeout(
        gateway.createPayout({
          idempotencyKey: String(withdrawal._id),
          reference: String(withdrawal._id),
          bankAccountId: withdrawal.bankAccountId,
          amount: withdrawal.amount, // minor units
        }),
        GATEWAY_TIMEOUT_MS
      );
      await Withdrawals.updateOne(
        { _id: withdrawal._id },
        { $set: { status: 'submitted', gatewayPayoutId: result && result.id, updatedAt: new Date() } }
      );
      await Outbox.updateOne({ _id: job._id }, { $set: { status: 'done' } });
    } catch (err) {
      const definitive = err && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
      if (definitive) {
        await reverse(withdrawal, `gateway_rejected_${err.status}`);
        await Outbox.updateOne({ _id: job._id }, { $set: { status: 'done' } });
      } else if (job.attempts >= MAX_ATTEMPTS) {
        // unknown outcome: do NOT refund. A human / reconciliation job checks the gateway by reference.
        await Withdrawals.updateOne({ _id: withdrawal._id }, { $set: { status: 'needs_review', updatedAt: new Date() } });
        await Outbox.updateOne({ _id: job._id }, { $set: { status: 'needs_review' } });
        logger.error && logger.error({ msg: 'payout_needs_review', withdrawalId: String(withdrawal._id) });
      } else {
        await Outbox.updateOne(
          { _id: job._id },
          { $set: { status: 'pending', nextAttemptAt: new Date(Date.now() + backoffMs(job.attempts)) }, $unset: { lockedUntil: '' } }
        );
      }
    }
    return true;
  }

  async function run({ stop = () => false, idleMs = 1000 } = {}) {
    while (!stop()) {
      const worked = await processOne().catch((e) => { logger.error && logger.error({ msg: 'worker_error', err: e.message }); return false; });
      if (!worked) await new Promise((r) => setTimeout(r, idleMs));
    }
  }

  return { processOne, run, reverse };
}

module.exports = { makeWorker };
