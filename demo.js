const { MongoClient, ObjectId } = require('mongodb');
const { makeWithdrawHandler } = require('./part1/withdraw');
const { makeWorker } = require('./part1/payoutWorker');
const { ensureIndexes } = require('./part1/indexes');

(async () => {
  const client = await new MongoClient(process.env.MONGO_URI).connect();
  const db = client.db('funngro_demo');
  await db.dropDatabase();            // har run par fresh start, par run ke baad data rehta hai
  await ensureIndexes(db);

  const userId = new ObjectId();
  await db.collection('users').insertOne({ _id: userId, status: 'active', bankAccount: { id: 'ba1', verified: true } });
  await db.collection('wallets').insertOne({ userId, balance: 100000 }); // Rs 1000

  const handler = makeWithdrawHandler({ client, db });
  const call = (key, amount) => new Promise((resolve) => {
    const res = { status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); } };
    handler({ auth: { userId }, body: { amount }, get: () => key }, res);
  });

  console.log('1st (Rs 600):', await call('key-aaaaaaaaaaaaaaaa', 60000));
  console.log('retry same key:', await call('key-aaaaaaaaaaaaaaaa', 60000));
  console.log('2nd (Rs 600, only 400 left):', await call('key-bbbbbbbbbbbbbbbb', 60000));
  console.log('negative amount:', await call('key-cccccccccccccccc', -5000));

  // fake gateway: worker payout bhejta hai, withdrawal "submitted" ho jata hai
  const gateway = { createPayout: async (p) => { console.log('gateway got payout:', p); return { id: 'gw_demo_1' }; } };
  const worker = makeWorker({ client, db, gateway });
  await worker.processOne();

  console.log('wallet:', await db.collection('wallets').findOne({ userId }));
  console.log('withdrawal:', await db.collection('withdrawals').findOne({ userId }));
  await client.close();
})();