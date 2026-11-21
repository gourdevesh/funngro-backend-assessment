# Part 4 - Recording notes (talking points, NOT a script)

Record this yourself, 5 minutes max, in your own words. Open `part1/withdraw.js` and `part1/review.md` on screen. Don't read these; use them as reminders. You will be asked to modify this code live, so make sure you can explain each block.

## 1. Two most dangerous bugs and why they're first (~2.5 min)
- **Non-atomic read-check-write on the balance.** Show the original lines. Two concurrent requests both read the same balance. Double payout, so real money leaves. Then show your `findOneAndUpdate({userId, balance: {$gte: amount}}, {$inc: ...})` and explain why Mongo's single-document atomicity makes this safe.
- **Debit happens, gateway call is fire-and-forget (no await, swallowed error), plus no idempotency and the app retries.** User debited with no payout, or paid twice on retry. Rank: both lose money, but the first lets someone *take* money and the second *loses track* of it; negative `amount` and missing auth are close behind. Be ready to defend your ranking order: say what you'd put third.
- Mention how the missing index ties in: it caused the slowness, which caused timeouts, which caused retries, which caused double debits.

## 2. One decision you weren't sure about + what you'd ask (~1.5 min)
Pick one that is true for you. Options that are honest uncertainties in this code:
- Returning **202 + async payout** instead of waiting for the gateway: better safety, but changes the app's UX. Question: can the mobile app handle a "processing" state?
- **Reversing on 4xx only** and sending unknown outcomes to `needs_review`: safe against double payment, but needs a human or reconciliation job. Question: what does the gateway guarantee about idempotency keys and status lookups?
- **Integer paise**: Question: what are balances stored as today?

## 3. Wrap (~30s)
One sentence on what you'd do next with more time (reconciliation job, alerting, tests against a replica set).

## Tips
- Show the code scrolling, not slides. No editing. Pauses are fine.
- Be ready for the on-site: "change the withdrawal limit to a daily cap", "add a fee", "why a transaction here?".
