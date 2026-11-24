// Spike-catcher for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window shows: most coins spike in their create slot and then
// bleed back below their entry price, so buying the average launch loses
// money. The exception is the biggest launches: a coin with >=20 SOL bought
// in its create slot keeps grinding up in its first minute as more buyers
// pile in (65-67% of them rise +15% before they fall -10% or the 300-slot
// limit), and a third of them go on to complete the curve. So this bot only
// trades those launches: it buys within 3 slots of creation, pyramids into
// the rise up to 1 SOL per coin, and sells the whole position at +15%,
// -10%, or after 300 slots -- never holding a bleeding curve hoping it comes
// back, and never chasing a coin that has already run far.
//
// Every decision is a pure function of the batches the harness sends: no
// clock, no randomness, no I/O, no environment reads, so the two graded
// executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserve (SOL) a coin must hold before an entry is allowed. */
  minRqSol: number;
  /** ...and at most this much: never chase a coin that already ran far. */
  maxRqSol: number;
  /** Price now must be at least this far above the creation price (fraction). */
  minRunup: number;
  /** Net SOL (buys minus sells) over the last flowWindow slots must be >= this. */
  flowWindow: number;
  minFlowSol: number;
  /** Total SOL to put into one position. */
  stakeSol: number;
  /** First buy of a position (SOL). */
  initialSol: number;
  /** Each add-on buy (SOL). */
  addSol: number;
  /** Add only once the price is this far above the last buy's decision price. */
  addStep: number;
  /** Take profit: sell when the position's close value reaches cost * (1 + tp). */
  takeProfit: number;
  /** Stop loss: sell when it falls to cost * (1 - sl). */
  stopLoss: number;
  /** Exit after holding this many slots regardless. */
  maxHold: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Trailing stop: sell when the close value falls this far below its peak
      (0 = off). Arms once the peak reaches cost * (1 + trailArm). */
  trail: number;
  trailArm: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Skip a coin whose creator sold before entry. */
  skipDevSold: boolean;
  /** Entry only once the coin has held at or above its crossing price for at
      least this many slots since first crossing minRqSol (0 = enter at once). */
  confirmSlots: number;
  /** Entry only within this many slots of the CreateEvent (0 = no age cap). */
  maxAge: number;
  /** Entry only when the create slot's total buy volume is at least this (SOL). */
  minBuyVol0: number;
  /** Entry only when the create slot has at most this many distinct
      non-creator buyers (1000 = no cap). */
  maxBuyers0: number;
}

// Settings traded with: chosen on the dev window with work/sweep.ts, preferring
// flat regions of the grid over its single best cell. The edge is the launch
// burst: a coin with >=20 SOL bought in its create slot keeps grinding up in
// its first minute (65-67% hit +15% before -10% or the 300-slot limit), so the
// bot buys it within 3 slots of creation, pyramids into the rise up to 1 SOL,
// and is out within ~1 minute either way. It wins in both halves of the dev
// window (+0.06 / +0.94 SOL at these settings) and across failed-tx draws.
export const DEFAULT_PARAMS: Params = {
  minRqSol: 1,
  maxRqSol: 60,
  minRunup: 0,
  flowWindow: 60,
  minFlowSol: 0,
  stakeSol: 1,
  initialSol: 0.5,
  addSol: 0.05,
  addStep: 0,
  takeProfit: 0.15,
  stopLoss: 0.1,
  maxHold: 300,
  cooldown: 300,
  maxEntries: 1,
  buySlipBps: 1500,
  trail: 0,
  trailArm: 0.05,
  maxExposureSol: 3,
  skipDevSold: false,
  confirmSlots: 0,
  maxAge: 3,
  minBuyVol0: 20,
  maxBuyers0: 1000,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  price: number;
  user: string;
}

interface Tape {
  created: number | null;
  createPrice: number;
  creator: string;
  devSold: boolean;
  trades: Trade[];
  entries: number;
  lastExit: number;
  /** Slot and price when real SOL first crossed minRqSol. */
  crossedAt: number | null;
  crossPrice: number;
  /** Create-slot totals: buy SOL and distinct non-creator buyers. */
  buyVol0: number;
  buyers0: Set<string>;
}

interface Held {
  opened: number;
  invested: number;
  lastAddPrice: number;
  exiting: boolean;
  filled: boolean;
  peakValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const keep = Math.max(p.flowWindow, 120) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, createPrice: 0, creator: '', devSold: false, trades: [], entries: 0, lastExit: -1e12, crossedAt: null, crossPrice: 0, buyVol0: 0, buyers0: new Set() };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Close value of `tokens` on this curve now, curve + tx fees deducted (SOL). */
  const closeValue = (tokens: bigint, vq: number, vt: number, tx: number): number => {
    const n = Number(tokens);
    return ((n * vq) / (vt + n) / LAMPORTS) * (1 - CURVE_FEE) - tx;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          t.creator = e.creator;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          if (t.created !== null && e.slot === t.created && e.is_buy) {
            t.buyVol0 += sol;
            if (e.user !== t.creator) t.buyers0.add(e.user);
          }
          if (!e.is_buy && e.user === t.creator) t.devSold = true;
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, stop loss, or time limit, on the whole position.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const value = closeValue(pos.token_amount, vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (cost <= 0) continue;
        if (value > h.peakValue) h.peakValue = value;
        let exit = h.exiting;
        if (!exit && value >= cost * (1 + p.takeProfit)) exit = true;
        if (!exit && value <= cost * (1 - p.stopLoss)) exit = true;
        if (!exit && p.trail > 0 && h.peakValue >= cost * (1 + p.trailArm) && value <= h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) {
          if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        }
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Then entries and adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (t.created === null || t.createPrice <= 0) continue;
          if (rqSol < p.minRqSol || rqSol > p.maxRqSol) continue;
          if (p.maxAge > 0 && t.created !== null && now - t.created > p.maxAge) continue;
          if (t.buyVol0 < p.minBuyVol0) continue;
          if (t.buyers0.size > p.maxBuyers0) continue;
          if (price < t.createPrice * (1 + p.minRunup)) continue;
          if (p.skipDevSold && t.devSold) continue;
          if (flow(t, now, p.flowWindow) < p.minFlowSol) continue;
          if (t.crossedAt === null) {
            t.crossedAt = now;
            t.crossPrice = price;
          }
          if (now - t.crossedAt < p.confirmSlots) continue;
          if (price < t.crossPrice) continue;
          want = p.initialSol;
        } else {
          // Pyramid into strength only: the price stepped up from the last buy
          // and net SOL still flows in.
          if (h.exiting || !h.filled || h.invested >= p.stakeSol - 0.001) continue;
          if (price < h.lastAddPrice * (1 + p.addStep)) continue;
          if (flow(t, now, p.flowWindow) < p.minFlowSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        if (lamports < 10_000_000n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, { opened: now, invested: amount, lastAddPrice: price, exiting: false, filled: false, peakValue: 0 });
          t.entries++;
          slotsLeft--;
        } else {
          h.invested += amount;
          h.lastAddPrice = price;
        }
      }
      return orders;
    },
  };
}
