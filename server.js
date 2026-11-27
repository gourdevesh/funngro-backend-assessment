
'use strict';

const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const { makeWithdrawHandler } = require('./part1/withdraw');
const { ensureIndexes } = require('./part1/indexes');
const { monthlyReport } = require('./part2/monthlyReport');

const app = express();

app.use(express.json());

const PORT = 5000;

async function startServer() {
  const client = new MongoClient(process.env.MONGO_URI);

  await client.connect();

  console.log('MongoDB Connected');

  const db = client.db('funngro_demo');

  await ensureIndexes(db);

  // Temporary demo authentication
  app.use((req, res, next) => {
    const userId = req.headers['x-user-id'];

    if (userId && ObjectId.isValid(userId)) {
      req.auth = { userId: new ObjectId(userId) };
    }

    next();
  });

  app.get('/', (req, res) => {
    res.json({ message: 'Funngro API is running' });
  });

  // Get user details
app.get('/api/demo/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({
        error: 'invalid_user_id'
      });
    }

    const user = await db.collection('users').findOne({
      _id: new ObjectId(userId)
    });

    if (!user) {
      return res.status(404).json({
        error: 'user_not_found'
      });
    }

    const wallet = await db.collection('wallets').findOne({
      userId: new ObjectId(userId)
    });

    res.status(200).json({
      user,
      wallet
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: 'internal_error'
    });
  }
});

// Monthly Finance Report API
app.get('/api/reports/monthly', async (req, res) => {
  try {
    const { month, byCohort } = req.query;

    // Validate month
if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
          return res.status(400).json({
        error: 'invalid_month',
        message: 'Month format must be YYYY-MM'
      });
    }

    const report = await monthlyReport(db, month, {
      byCohort: byCohort === 'true'
    });

    res.status(200).json({
      success: true,
      month,
      reportType: byCohort === 'true' ? 'cohort' : 'user',
      data: report
    });

  } catch (error) {
    console.error('Monthly report error:', error);

    res.status(500).json({
      error: 'internal_error'
    });
  }
});

  app.post(
    '/api/wallet/withdraw',
    makeWithdrawHandler({
      client,
      db
    })
  );

  app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
  });
}

startServer().catch(console.error);
