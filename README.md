# Pump.fun Launch-Burst Bot

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Riel666/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/Riel666/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for the pump.fun bonding-curve replay (pumpfun-replay/v2). It trades 10 SOL of paper money on a short replay of recorded pump.fun activity.

## Strategy

Most coins spike in their create slot and then bleed back below their entry price, so buying the average launch loses money. The exception is the biggest launches: a coin with **at least 20 SOL bought in its create slot** keeps grinding up in its first minute as more buyers pile in — on the dev window, 65% of them rise +15% before they fall −10% or the time limit hits. So the bot:

1. Watches every coin from its `CreateEvent` and totals the buy volume in the create slot.
2. Buys a coin **within 3 slots of creation** only when that total is ≥ 20 SOL (first buy 0.5 SOL, capped at 1% of the curve's real SOL reserve per reply).
3. **Pyramids into the rise** — adds 0.05 SOL while the price keeps stepping up, up to 1 SOL per coin.
4. Sells the whole position at **+15% take-profit, −10% stop-loss, or after 300 slots** (~1 minute) — never holding a bleeding curve hoping it comes back.

Everything is a pure function of the batches the harness sends: no clock, no randomness, no network, no I/O, so the two graded executions produce byte-identical action logs.

## Local result (dev window)

`grade-local` on the prior pumpfun-replay kit's dev data: **net PnL +0.999 SOL** (+9.99% on 10 SOL), 33 round trips over 33 coins, 63.6% win rate, max drawdown 8.1%, guardrails met. For comparison: hold-cash 0, equal-weight −0.019 SOL, sniper −0.47 SOL, reversion −4.00 SOL, momentum −9.49 SOL. The edge also holds in both halves of the dev window (+0.06 / +0.94 SOL) and across failed-transaction draws.

## Run it

```sh
node main.ts
# speaks the pump.fun replay protocol on stdin/stdout; run by the grader as `node /bot/main.ts`
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=nrw7bbqr&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
