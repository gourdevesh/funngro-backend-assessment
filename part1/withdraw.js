'use strict';
/**
 * POST /api/wallet/withdraw
 * headers: Idempotency-Key: <uuid, generated once per user tap, reused on retries>
 * body:    { amount }   // integer, minor units (paise)
 *
 * Money safety:
 *  - userId from the auth layer, never from the body
 *  - atomic conditional $inc (no read-modify-write)
 *  - debit + withdrawal + ledger + outbox in ONE transaction
 *  - idempotency via unique index (userId, idempotencyKey)
 *  - gateway is NOT called here; payoutWorker does it after commit
 */
const { ObjectId } = require('mongodb');

const MIN_AMOUNT = 10_000;      // Rs 100  (assumption - confirm with product)
const MAX_AMOUNT = 5_000_000;   // Rs 50,000 per withdrawal (assumption)
const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function isDuplicateKey(err) {
  return err && (err.code === 11000 || /E11000/.test(err.message || ''));
}

function toResponse(w) {
  return { withdrawalId: String(w._id), status: w.status, amount: w.amount };
}

function makeWithdrawHandler({ client, db, logger = console }) {
  const Users = db.collection('users');
  const Wallets = db.collection('wallets');
  const Ledger = db.collection('ledger');
  const Withdrawals = db.collection('withdrawals');
  const Outbox = db.collection('outbox');

  async function replay(userId, key, amount, res) {
    const existing = await Withdrawals.findOne({ userId, idempotencyKey: key });
    if (!existing) throw new HttpError(409, 'conflict', 'retry shortly');
    if (existing.amount !== amount) {
      throw new HttpError(422, 'idempotency_key_reused', 'key used with a different amount');
    }
    return res.status(200).json({ ...toResponse(existing), replayed: true });
  }

  return async function withdraw(req, res) {
    try {
      // 1. identity + input validation (before touching the DB)
      const userId = req.auth && req.auth.userId;           // set by auth middleware
      if (!userId) throw new HttpError(401, 'unauthenticated');

      const key = req.get('Idempotency-Key');
      if (!key || !KEY_RE.test(key)) throw new HttpError(400, 'bad_idempotency_key');

      const amount = req.body && req.body.amount;
      if (!Number.isSafeInteger(amount) || amount < MIN_AMOUNT || amount > MAX_AMOUNT) {
        throw new HttpError(400, 'invalid_amount');
      }

      // 2. cheap replay path: a retry of something we already accepted
      const prior = await Withdrawals.findOne({ userId, idempotencyKey: key });
      if (prior) return await replay(userId, key, amount, res);

      // 3. the money transaction
      const session = client.startSession();
      let withdrawal;
      try {
        await session.withTransaction(
          async () => {
            const user = await Users.findOne(
              { _id: userId, status: 'active', 'bankAccount.verified': true },
              { projection: { 'bankAccount.id': 1 }, session }
            );
            if (!user) throw new HttpError(403, 'account_not_eligible');

            // atomic check-and-debit: matches only if balance is sufficient
            const wallet = await Wallets.findOneAndUpdate(
              { userId, balance: { $gte: amount } },
              { $inc: { balance: -amount }, $set: { updatedAt: new Date() } },
              { returnDocument: 'after', session }
            );
            if (!wallet) throw new HttpError(400, 'insufficient_balance');

            const now = new Date();
            const _id = new ObjectId();
            withdrawal = {
              _id,
              userId,
              idempotencyKey: key,
              amount,
              bankAccountId: user.bankAccount.id,   // snapshot: pay the account as of request time
              status: 'pending',                    // pending -> processing -> submitted -> succeeded | failed | needs_review
              attempts: 0,
              createdAt: now,
              updatedAt: now,
            };
            await Withdrawals.insertOne(withdrawal, { session }); // unique (userId, idempotencyKey)

            await Ledger.insertOne(
              {
                userId,
                type: 'withdrawal',
                amount: -amount,
                balanceAfter: wallet.balance,
                withdrawalId: _id,
                createdAt: now,
              },
              { session }
            );

            await Outbox.insertOne(
              {
                type: 'payout',
                withdrawalId: _id,
                status: 'pending',
                attempts: 0,
                nextAttemptAt: now,
                createdAt: now,
              },
              { session }
            );
          },
          {
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' },
            maxCommitTimeMS: 5000,
          }
        );
      } catch (err) {
        if (isDuplicateKey(err)) {
          // two concurrent requests with the same key; the loser lands here
          return await replay(userId, key, amount, res);
        }
        throw err;
      } finally {
        await session.endSession();
      }

      logger.info && logger.info({ msg: 'withdrawal_accepted', withdrawalId: String(withdrawal._id), userId: String(userId) });
      // 202: debit is committed, payout happens asynchronously.
      return res.status(202).json(toResponse(withdrawal));
    } catch (err) {
      if (err instanceof HttpError) {
        return res.status(err.status).json({ error: err.code });
      }
      // unknown error: transaction aborted, nothing was debited. Safe for the client to retry with the same key.
      (logger.error || logger.log).call(logger, { msg: 'withdraw_failed', err: err.message });
      return res.status(500).json({ error: 'internal_error', retryable: true });
    }
  };
}

module.exports = { makeWithdrawHandler, HttpError, MIN_AMOUNT, MAX_AMOUNT };
