'use strict';
// Needs a replica set (transactions): MONGO_URI="mongodb://localhost:27017/?replicaSet=rs0" npm test
// NOT RUN in the authoring environment - run locally before the on-site round.
const test = require('node:test');
const assert = require('node:assert');
const { MongoClient, ObjectId } = require('mongodb');
const { makeWithdrawHandler } = require('../withdraw');
const { ensureIndexes } = require('../indexes');

const uri = process.env.MONGO_URI;

function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}
function fakeReq(userId, key, amount) {
  return { auth: { userId }, body: { amount }, get: (h) => (h === 'Idempotency-Key' ? key : undefined) };
}

test('concurrent withdrawals cannot overdraw; same key is applied once', { skip: !uri }, async () => {
  const client = await new MongoClient(uri).connect();
  const db = client.db('funngro_test_' + Date.now());
  try {
    await ensureIndexes(db);
    const userId = new ObjectId();
    await db.collection('users').insertOne({ _id: userId, status: 'active', bankAccount: { id: 'ba1', verified: true } });
    await db.collection('wallets').insertOne({ userId, balance: 100_000 }); // Rs 1000

    const handler = makeWithdrawHandler({ client, db, logger: { info() {}, error() {}, log() {} } });

    // 20 different requests of Rs 600 each: at most ONE may succeed (balance only covers one)
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const res = fakeRes();
        return handler(fakeReq(userId, `key-${i}`.padEnd(20, 'x'), 60_000), res).then(() => res);
      })
    );
    const accepted = results.filter((r) => r.statusCode === 202).length;
    assert.strictEqual(accepted, 1);
    assert.strictEqual((await db.collection('wallets').findOne({ userId })).balance, 40_000);
    assert.strictEqual(await db.collection('ledger').countDocuments({ userId, type: 'withdrawal' }), 1);

    // same idempotency key 10x concurrently on a fresh wallet: exactly one debit
    await db.collection('wallets').updateOne({ userId }, { $set: { balance: 1_000_000 } });
    const sameKey = 'same-key-0123456789abcd';
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => { const res = fakeRes(); return handler(fakeReq(userId, sameKey, 20_000), res).then(() => res); })
    );
    assert.ok(rs.every((r) => [200, 202].includes(r.statusCode)), JSON.stringify(rs.map((r) => r.statusCode)));
    assert.strictEqual((await db.collection('wallets').findOne({ userId })).balance, 980_000);
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});

test('rejects negative / fractional / missing amounts', { skip: !uri }, async () => {
  const client = await new MongoClient(uri).connect();
  const db = client.db('funngro_test_' + Date.now());
  try {
    const handler = makeWithdrawHandler({ client, db, logger: { info() {}, error() {}, log() {} } });
    for (const bad of [-5000, 0, 100.5, '1000', null, undefined, Infinity, NaN]) {
      const res = fakeRes();
      await handler(fakeReq(new ObjectId(), 'k'.repeat(20), bad), res);
      assert.strictEqual(res.statusCode, 400, `amount ${bad}`);
    }
  } finally {
    await db.dropDatabase();
    await client.close();
  }
});
