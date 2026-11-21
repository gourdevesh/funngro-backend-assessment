'use strict';
/**
 * Monthly finance report: per user, points earned / converted / expired.
 *   month: 'YYYY-MM' (interpreted in IST: +05:30). Confirm with finance.
 */
function monthRangeIST(month) {
  const [y, m] = month.split('-').map(Number);
  const IST_OFFSET_MS = 5.5 * 3600 * 1000;
  const start = new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS);
  const end = new Date(Date.UTC(y, m, 1) - IST_OFFSET_MS);
  return { start, end };
}

function perUserPipeline(month) {
  const { start, end } = monthRangeIST(month);
  const sumOf = (type) => ({ $sum: { $cond: [{ $eq: ['$type', type] }, '$points', 0] } });
  return [
    // uses index { createdAt:1, type:1, userId:1 }
    { $match: { createdAt: { $gte: start, $lt: end }, type: { $in: ['earn', 'convert', 'expire', 'reverse'] } } },
    {
      $group: {
        _id: '$userId',
        earned: sumOf('earn'),
        converted: sumOf('convert'),
        expired: sumOf('expire'),
        reversed: sumOf('reverse'), // convert reversals: subtract from converted in the final step
      },
    },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', pipeline: [{ $project: { cohort: 1 } }], as: 'u' } },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        cohort: { $ifNull: [{ $arrayElemAt: ['$u.cohort', 0] }, 'unknown'] },
        earned: 1,
        converted: { $subtract: ['$converted', '$reversed'] },
        expired: 1,
      },
    },
    { $sort: { cohort: 1, userId: 1 } },
  ];
}

// Same data rolled up by cohort
function perCohortPipeline(month) {
  return [
    ...perUserPipeline(month).filter((s) => !('$sort' in s)),
    {
      $group: {
        _id: '$cohort',
        users: { $sum: 1 },
        earned: { $sum: '$earned' },
        converted: { $sum: '$converted' },
        expired: { $sum: '$expired' },
      },
    },
    { $sort: { _id: 1 } },
  ];
}

async function monthlyReport(db, month, { byCohort = false } = {}) {
  const pipeline = byCohort ? perCohortPipeline(month) : perUserPipeline(month);
  return db.collection('points_ledger').aggregate(pipeline, { allowDiskUse: true }).toArray();
}

module.exports = { monthlyReport, perUserPipeline, perCohortPipeline, monthRangeIST };
