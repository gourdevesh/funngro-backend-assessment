# Funngro Backend Assessment - Submission

| Part | Files |
|------|-------|
| 1 - Payout handler review | `part1/review.md`, `part1/withdraw.js`, `part1/payoutWorker.js`, `part1/indexes.js`, `part1/test/withdraw.concurrency.test.js` |
| 2 - Rewards schema + report | `part2/design.md`, `part2/monthlyReport.js` |
| 3 - Production incident | `part3/incident.md` |
| 4 - Recording | `part4/recording-notes.md` (talking points only; link to the video goes in the LinkedIn reply) |

## Assumptions (and the question I'd have asked)
1. **Money is stored as integer minor units (paise).** Q: Is `balance` currently a float of rupees? If so we need a migration before anything else; floats cannot be trusted with money.
2. **Atlas replica set, MongoDB 4.2+**, so multi-document transactions are available. Q: What is the Atlas tier / version?
3. **User identity comes from the auth layer (`req.auth.userId`)**, not from the request body. Q: Is there an auth middleware today? The original trusts `userId` from the body, which would be the worst bug if there is none.
4. **The gateway supports an idempotency key / client reference** and a payout status lookup. Q: Does it? Which gateway? This decides how safe retries on timeout are.
5. **Mobile client can send an `Idempotency-Key` header** (a UUID generated once per withdraw tap and reused on retries). Q: Can we ship that in the app, and how do old app versions behave?
6. **Reports use IST month boundaries.** Q: Does finance close the month in IST or UTC?

## Running
```
npm install
MONGO_URI="mongodb://localhost:27017/?replicaSet=rs0" npm test
```
**Honest note:** I did not run the tests in my environment (no MongoDB replica set available there). I ran `node --check` on every JS file only. Before the on-site round, run the test against a local replica set.
