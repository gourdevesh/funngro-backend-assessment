const assert = require('node:assert');
const { MongoClient, ObjectId } = require('mongodb');
const { monthlyReport } = require('./part2/monthlyReport');

(async () => {
  const client = await new MongoClient(process.env.MONGO_URI).connect();
  const db = client.db('funngro_part2_check');
  await db.dropDatabase();

  const u1 = new ObjectId(), u2 = new ObjectId();
  await db.collection('users').insertMany([
    { _id: u1, cohort: '2026-01' },
    { _id: u2, cohort: '2026-02' },
  ]);
  const d = (s) => new Date(s);
  await db.collection('points_ledger').insertMany([
    { userId: u1, type: 'earn',    points: 100, createdAt: d('2026-11-05T10:00:00Z') },
    { userId: u1, type: 'convert', points: 40,  createdAt: d('2026-11-10T10:00:00Z') },
    { userId: u1, type: 'reverse', points: 10,  createdAt: d('2026-11-11T10:00:00Z') },
    { userId: u1, type: 'expire',  points: 5,   createdAt: d('2026-11-20T10:00:00Z') },
    { userId: u1, type: 'earn',    points: 999, createdAt: d('2026-10-31T10:00:00Z') }, // October: excluded
    { userId: u2, type: 'earn',    points: 50,  createdAt: d('2026-11-30T20:00:00Z') }, // 1 Dec IST: excluded
    { userId: u2, type: 'earn',    points: 20,  createdAt: d('2026-11-01T00:00:00Z') }, // 1 Nov IST: included
  ]);

  const rows = await monthlyReport(db, '2026-11');
  console.log(rows);
  const byUser = Object.fromEntries(rows.map((r) => [String(r.userId), r]));
  assert.deepStrictEqual([byUser[u1].earned, byUser[u1].converted, byUser[u1].expired], [100, 30, 5]);
  assert.deepStrictEqual([byUser[u2].earned, byUser[u2].converted, byUser[u2].expired], [20, 0, 0]);

  console.log('cohort rollup:', await monthlyReport(db, '2026-11', { byCohort: true }));
  console.log('PART 2 OK');
  await db.dropDatabase();
  await client.close();
})();